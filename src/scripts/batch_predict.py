"""
batch_predict.py — Predict h=1 + risk classification cho mọi country có
feature_snapshot tuần mới nhất, ghi vào bảng `predictions`.

Mục đích:
  /risk-map/{disease}/latest đọc từ bảng predictions. Bảng này hiện chỉ
  có data 2010-2019 (training-era). Cần batch script chạy weekly để
  populate prediction cho tuần realtime.

Pipeline:
  1. Load ML models (regressor h=1) vào memory
  2. Với mỗi disease (flu, dengue):
     - Tìm tuần (iso_year, iso_week) MỚI NHẤT có feature_snapshot
     - Với mỗi iso3 có snapshot tuần đó:
       * Predict h=1 → predicted_cases (regressor)
       * risk_level = endemic channel Bortman: đối chiếu predicted_cases với
         ngưỡng (mean, mean+2σ) theo (iso3, iso_week) từ kỳ tham chiếu training
       * UPSERT vào predictions (ON CONFLICT idx_predictions_unique)

  Ghi chú: mức nguy cơ trên bản đồ suy TRỰC TIẾP từ số ca dự báo của regressor
  qua ngưỡng endemic channel (Bortman 1999), KHÔNG dùng XGBClassifier — để
  risk_level luôn nhất quán với predicted_cases hiển thị. Classifier chỉ giữ
  vai trò nhánh so sánh trong notebook/báo cáo.

Usage:
  python scripts/batch_predict.py                              # cả flu + dengue, latest week
  python scripts/batch_predict.py --disease flu
  python scripts/batch_predict.py --year 2026 --week 18       # override target week (1 tuần)
  python scripts/batch_predict.py --year 2023 --from-week 24 --to-week 36  # range trong 1 năm
  python scripts/batch_predict.py --dry-run

Cron: Thứ Hai 11:30 ICT (sau feature_builder 11:00).
"""

import argparse
import os
import sys
import warnings
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import execute_values

warnings.filterwarnings("ignore")
load_dotenv()

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "backend"))

from app.services import ml_engine  # noqa: E402

sys.path.insert(0, str(PROJECT_ROOT / "scripts"))
from _pipeline_logger import track_run  # noqa: E402

DB_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres:111111111@localhost:5432/kltn_epiweather",
)

ML_MODELS_DIR = PROJECT_ROOT / "ml_models"

DISEASE_TO_ID = {"flu": 1, "dengue": 2}
DENGUE_LATEST_VALID_WEEK = (2023, 36)

# Kỳ tham chiếu tính baseline endemic channel (khớp notebook SESSION 5 —
# compute_endemic_channel). Chỉ dùng năm training để tránh leakage.
BASELINE_YEARS = {"flu": (2010, 2018), "dengue": (2015, 2018)}


def load_bortman_baselines(cur, disease: str, disease_id: int) -> dict[tuple[str, int], tuple[float, float]]:
    """Baseline endemic channel (mean, mean+2σ) số ca theo (iso3, iso_week),
    tính trên kỳ training. Trả dict[(iso3, iso_week)] -> (mean, upper).

    Nước không có dữ liệu lịch sử ở (iso3, iso_week) sẽ không có key tương ứng.
    Khi đó risk_from_bortman nhận baseline None và xếp Low vì thiếu mức nền để so
    (không có fallback baseline theo iso_week toàn cục)."""
    start_year, end_year = BASELINE_YEARS[disease]
    cur.execute(
        """
        SELECT iso3, iso_week, raw_count, transformed_value
        FROM disease_cases
        WHERE disease_id = %s AND iso_year BETWEEN %s AND %s
        """,
        (disease_id, start_year, end_year),
    )
    import math
    import statistics as st
    from collections import defaultdict

    per_country: dict[tuple[str, int], list[float]] = defaultdict(list)
    for iso3, week, raw, trans in cur.fetchall():
        val = raw if raw is not None else (math.expm1(trans) if trans is not None else None)
        if val is not None:
            per_country[(iso3, week)].append(float(val))

    baselines: dict[tuple[str, int], tuple[float, float]] = {}
    for key, vals in per_country.items():
        mean = st.mean(vals)
        std = st.stdev(vals) if len(vals) > 1 else 0.0
        baselines[key] = (mean, mean + 2 * std)
    return baselines


def risk_from_bortman(predicted_cases: float, baseline: tuple[float, float] | None) -> tuple[str, float]:
    """Đối chiếu số ca dự báo với ngưỡng endemic channel → (risk_level, risk_score).

    risk_score là vị trí tương đối trong dải endemic (0..1), để UI có thang liên
    tục nhất quán với level (không phải xác suất của classifier)."""
    if baseline is None:
        # Không có lịch sử → không đủ căn cứ; số ca gần 0 nên xếp Low.
        return ("Low", 0.0)
    mean, upper = baseline
    if mean == 0 and upper == 0:
        return ("Low", 0.0) if round(predicted_cases) <= 0 else ("High", 1.0)
    if predicted_cases < mean:
        score = 0.0 if mean == 0 else max(0.0, min(0.33, 0.33 * predicted_cases / mean))
        return ("Low", round(score, 4))
    if predicted_cases < upper:
        span = upper - mean
        frac = 0.0 if span == 0 else (predicted_cases - mean) / span
        return ("Medium", round(0.33 + 0.34 * frac, 4))
    # >= upper → High; score bão hòa dần trên ngưỡng
    over = 0.0 if upper == 0 else min(1.0, (predicted_cases - upper) / max(upper, 1.0))
    return ("High", round(0.67 + 0.33 * over, 4))


def latest_valid_week(disease: str) -> tuple[int, int] | None:
    if disease == "dengue":
        return DENGUE_LATEST_VALID_WEEK
    return None


def get_model_version_id(cur, disease_id: int) -> int:
    """Lấy id của regressor version đang active (không hardcode version cụ thể).

    model_versions.version có dạng '<ver>-regressor' / '<ver>-classifier'
    (vd 'v2-regressor', 'v4-classifier'). Chọn regressor champion/active mới nhất
    để label prediction — đổi model version chỉ cần reseed, không sửa code ở đây.
    """
    cur.execute(
        """
        SELECT id
        FROM model_versions
        WHERE disease_id = %s
          AND version LIKE '%%-regressor'
          AND is_active = TRUE
        ORDER BY is_champion DESC, id DESC
        LIMIT 1
        """,
        (disease_id,),
    )
    row = cur.fetchone()
    if row:
        return int(row[0])
    raise RuntimeError(
        f"Không tìm thấy model_versions regressor active cho disease_id={disease_id} "
        f"— chạy load_db_v2.py để seed model_versions trước"
    )


def not_after_latest_valid(disease: str, year: int, week: int) -> bool:
    latest = latest_valid_week(disease)
    if latest is None:
        return True
    max_year, max_week = latest
    return year < max_year or (year == max_year and week <= max_week)


def find_latest_snapshot_week(cur, disease: str, disease_id: int) -> tuple[int, int] | None:
    """Tìm (iso_year, iso_week) mới nhất có ít nhất N quốc gia với snapshot."""
    latest = latest_valid_week(disease)
    if latest is None:
        cur.execute(
            """
            SELECT iso_year, iso_week, COUNT(DISTINCT iso3) AS n
            FROM feature_snapshots
            WHERE disease_id = %s
            GROUP BY iso_year, iso_week
            ORDER BY iso_year DESC, iso_week DESC
            LIMIT 1
            """,
            (disease_id,),
        )
    else:
        max_year, max_week = latest
        cur.execute(
            """
            SELECT iso_year, iso_week, COUNT(DISTINCT iso3) AS n
            FROM feature_snapshots
            WHERE disease_id = %s
              AND (iso_year < %s OR (iso_year = %s AND iso_week <= %s))
            GROUP BY iso_year, iso_week
            ORDER BY iso_year DESC, iso_week DESC
            LIMIT 1
            """,
            (disease_id, max_year, max_year, max_week),
        )
    row = cur.fetchone()
    return (row[0], row[1]) if row else None


def list_all_snapshot_weeks(cur, disease: str, disease_id: int) -> list[tuple[int, int]]:
    """Trả về toàn bộ (year, week) có feature_snapshot — dùng cho backfill."""
    latest = latest_valid_week(disease)
    if latest is None:
        cur.execute(
            """
            SELECT DISTINCT iso_year, iso_week
            FROM feature_snapshots
            WHERE disease_id = %s
            ORDER BY iso_year, iso_week
            """,
            (disease_id,),
        )
    else:
        max_year, max_week = latest
        cur.execute(
            """
            SELECT DISTINCT iso_year, iso_week
            FROM feature_snapshots
            WHERE disease_id = %s
              AND (iso_year < %s OR (iso_year = %s AND iso_week <= %s))
            ORDER BY iso_year, iso_week
            """,
            (disease_id, max_year, max_year, max_week),
        )
    return [(r[0], r[1]) for r in cur.fetchall()]


def fetch_snapshots(cur, disease_id: int, iso_year: int, iso_week: int) -> list[tuple[str, dict]]:
    """Trả về [(iso3, features_dict), ...] cho tất cả country tuần này."""
    cur.execute(
        """
        SELECT iso3, features
        FROM feature_snapshots
        WHERE disease_id = %s AND iso_year = %s AND iso_week = %s
        ORDER BY iso3
        """,
        (disease_id, iso_year, iso_week),
    )
    return cur.fetchall()


def predict_one(disease: str, features: dict, baseline: tuple[float, float] | None) -> dict:
    """Predict h=1 (regressor) + risk từ ngưỡng endemic channel (Bortman)."""
    reg = ml_engine.predict_horizon(disease, 1, features)
    risk_level, risk_score = risk_from_bortman(reg["predicted_cases"], baseline)
    return {
        "predicted_value": reg["predicted_log"],
        "predicted_cases": reg["predicted_cases"],
        "risk_level": risk_level,
        "risk_probability": risk_score,
    }


def upsert_predictions(
    cur,
    disease_id: int,
    model_version_id: int,
    iso_year: int,
    iso_week: int,
    rows: list[tuple[str, dict]],
    dry_run: bool = False,
) -> int:
    """UPSERT vào predictions table dùng idx_predictions_unique."""
    if not rows:
        return 0

    payload = []
    for iso3, pred in rows:
        payload.append((
            disease_id,
            iso3,
            iso_year,
            iso_week,
            1,                         # horizon_weeks
            pred["predicted_value"],
            pred["predicted_cases"],
            pred["risk_level"],
            pred["risk_probability"],
            model_version_id,
        ))

    if dry_run:
        print(f"    [DRY-RUN] would upsert {len(payload)} rows, sample: {payload[0]}")
        return 0

    execute_values(
        cur,
        """
        INSERT INTO predictions
            (disease_id, iso3, iso_year, iso_week, horizon_weeks,
             predicted_value, predicted_cases, risk_level, risk_probability,
             model_version_id)
        VALUES %s
        ON CONFLICT (disease_id, iso3, iso_year, iso_week, horizon_weeks, model_version_id)
        DO UPDATE SET
            predicted_value   = EXCLUDED.predicted_value,
            predicted_cases   = EXCLUDED.predicted_cases,
            risk_level        = EXCLUDED.risk_level,
            risk_probability  = EXCLUDED.risk_probability
        """,
        payload,
        page_size=500,
    )
    return len(payload)


def main():
    ap = argparse.ArgumentParser(description="Batch predict latest week → predictions table")
    ap.add_argument("--disease", choices=["flu", "dengue", "all"], default="all")
    ap.add_argument("--year", type=int, default=None, help="Override target year")
    ap.add_argument("--week", type=int, default=None, help="Override target week (single)")
    ap.add_argument("--from-week", type=int, default=None, help="Range start week (dùng cùng --year)")
    ap.add_argument("--to-week", type=int, default=None, help="Range end week (dùng cùng --year)")
    ap.add_argument("--all-snapshots", action="store_true",
                    help="Backfill: predict cho TẤT CẢ tuần có feature_snapshot")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--trigger", type=str, default="manual",
                    choices=["manual", "scheduled", "api", "event"])
    args = ap.parse_args()

    diseases = ["flu", "dengue"] if args.disease == "all" else [args.disease]

    # Validate range args
    use_range = (args.from_week is not None and args.to_week is not None and args.year is not None)
    if (args.from_week is not None or args.to_week is not None) and not use_range:
        ap.error("--from-week và --to-week phải dùng cùng nhau với --year")

    print("=" * 60)
    print("  batch_predict.py — predict + upsert → predictions table")
    print("=" * 60)
    print(f"  diseases: {diseases}")
    if use_range:
        print(f"  mode:     range {args.year} W{args.from_week:02d}–W{args.to_week:02d}")
    elif args.year and args.week:
        print(f"  mode:     single {args.year}-W{args.week:02d}")
    else:
        print(f"  mode:     latest (auto-detect)")
    print(f"  dry_run:  {args.dry_run}")

    # Load models
    print(f"\n[1/2] Loading ML models from {ML_MODELS_DIR}…")
    ml_engine.load_models(ML_MODELS_DIR)
    loaded = ml_engine.loaded_diseases()
    print(f"      regressors: {loaded['regressors']}")
    print(f"      classifiers: {loaded['classifiers']}")

    with track_run(
        "batch_predict",
        trigger_type=args.trigger,
        metadata={"diseases": diseases, "dry_run": args.dry_run,
                  "mode": ("range" if use_range else "single" if args.year else
                           "all_snapshots" if args.all_snapshots else "latest")},
    ) as stats:
        conn = psycopg2.connect(DB_URL)
        conn.autocommit = False
        cur = conn.cursor()

        try:
            total_upserted = 0
            total_errors: list = []
            for disease in diseases:
                disease_id = DISEASE_TO_ID[disease]
                model_version_id = get_model_version_id(cur, disease_id)
                baselines = load_bortman_baselines(cur, disease, disease_id)
                print(f"  [{disease}] endemic baselines: {len(baselines)} (iso3,week) cặp "
                      f"từ {BASELINE_YEARS[disease][0]}-{BASELINE_YEARS[disease][1]}")

                if args.all_snapshots:
                    targets = list_all_snapshot_weeks(cur, disease, disease_id)
                elif use_range:
                    targets = [(args.year, w) for w in range(args.from_week, args.to_week + 1)]
                elif args.year and args.week:
                    targets = [(args.year, args.week)]
                else:
                    latest = find_latest_snapshot_week(cur, disease, disease_id)
                    if latest is None:
                        print(f"\n  [{disease}] Không có feature_snapshot — SKIP")
                        continue
                    targets = [latest]
                targets = [
                    (y, w) for y, w in targets
                    if not_after_latest_valid(disease, y, w)
                ]
                if not targets:
                    latest = latest_valid_week(disease)
                    suffix = f" sau cutoff {latest[0]}-W{latest[1]:02d}" if latest else ""
                    print(f"\n  [{disease}] Không có target hợp lệ{suffix} — SKIP")
                    continue

                print(f"\n[2/2] [{disease}] Processing {len(targets)} week(s)…")

                for iso_year, iso_week in targets:
                    snapshots = fetch_snapshots(cur, disease_id, iso_year, iso_week)
                    if not snapshots:
                        print(f"      {iso_year}-W{iso_week:02d}: no snapshots — skip")
                        continue

                    predicted_rows: list[tuple[str, dict]] = []
                    errors = []
                    for iso3, features in snapshots:
                        try:
                            baseline = baselines.get((iso3, iso_week))
                            pred = predict_one(disease, features, baseline)
                            predicted_rows.append((iso3, pred))
                        except Exception as e:
                            errors.append((iso3, str(e)[:80]))
                            total_errors.append({"disease": disease, "iso3": iso3,
                                                 "year": iso_year, "week": iso_week,
                                                 "error": str(e)[:200]})

                    n = upsert_predictions(
                        cur, disease_id, model_version_id,
                        iso_year, iso_week, predicted_rows,
                        dry_run=args.dry_run,
                    )
                    total_upserted += n

                    if not args.dry_run:
                        conn.commit()

                    print(f"      {iso_year}-W{iso_week:02d}: {n} upserted"
                          + (f", {len(errors)} errors" if errors else ""))
                    if errors[:2]:
                        for iso3, err in errors[:2]:
                            print(f"        {iso3}: {err}")

            stats["rows_inserted"] = total_upserted
            stats["rows_skipped"] = len(total_errors)
            if total_errors:
                stats["errors"] = total_errors[:50]  # cap để JSONB không quá lớn

            print(f"\n  TOTAL upserted: {total_upserted:,}")

            if not args.dry_run:
                cur.execute(
                    "SELECT iso_year, iso_week, COUNT(*) FROM predictions "
                    "GROUP BY iso_year, iso_week ORDER BY iso_year DESC, iso_week DESC LIMIT 3"
                )
                print("\n  Top 3 most recent weeks in predictions table:")
                for r in cur.fetchall():
                    print(f"    {r[0]}-W{r[1]:02d}: {r[2]} rows")

        except Exception as e:
            conn.rollback()
            print(f"\nERROR: {e}")
            raise
        finally:
            cur.close()
            conn.close()


if __name__ == "__main__":
    main()
