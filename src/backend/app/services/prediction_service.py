import math
import statistics
from collections import defaultdict
from datetime import date, timedelta

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..crud import diseases as disease_crud
from ..crud import predictions as prediction_crud
from ..models import DiseaseCase
from ..schemas.prediction import (
    DataCoverage,
    ForecastPoint,
    ForecastResponse,
    HistoryPoint,
    HistoryResponse,
    PredictionPoint,
)
from . import feature_lookup, ml_engine

VALID_DISEASES = {"flu", "dengue"}
BASELINE_YEARS = {
    "flu": (2010, 2018),
    "dengue": (2015, 2018),
}


def _bortman_baselines(
    db: Session,
    disease_id: int,
    disease_code: str,
    iso3: str,
    iso_weeks: set[int],
) -> dict[int, tuple[float, float]]:
    start_year, end_year = BASELINE_YEARS[disease_code]
    rows = (
        db.query(DiseaseCase)
        .filter(
            DiseaseCase.disease_id == disease_id,
            DiseaseCase.iso3 == iso3,
            DiseaseCase.iso_year.between(start_year, end_year),
            DiseaseCase.iso_week.in_(iso_weeks),
        )
        .all()
    )

    cases_by_week: dict[int, list[float]] = defaultdict(list)
    for row in rows:
        value = row.raw_count
        if value is None and row.transformed_value is not None:
            value = math.expm1(row.transformed_value)
        if value is not None:
            cases_by_week[row.iso_week].append(float(value))

    baselines: dict[int, tuple[float, float]] = {}
    for week, values in cases_by_week.items():
        mean = statistics.mean(values)
        std = statistics.stdev(values) if len(values) > 1 else 0.0
        baselines[week] = (mean, mean + 2 * std)
    return baselines


def _risk_from_bortman(
    predicted_cases: float,
    baseline: tuple[float, float] | None,
) -> str | None:
    if baseline is None:
        return None
    mean, upper = baseline
    if mean == 0 and upper == 0:
        return "Low" if round(predicted_cases) <= 0 else "High"
    if predicted_cases < mean:
        return "Low"
    if predicted_cases < upper:
        return "Medium"
    return "High"


def resolve_disease(db: Session, code: str):
    """Valida disease code và trả về ORM object. Raise 400/404 nếu không hợp lệ."""
    if code not in VALID_DISEASES:
        raise HTTPException(
            status_code=400,
            detail=f"Disease phải là một trong: {sorted(VALID_DISEASES)}",
        )
    disease = disease_crud.get_by_code(db, code)
    if not disease:
        raise HTTPException(status_code=404, detail="Disease không tìm thấy trong database")
    return disease


def get_prediction(
    db: Session,
    disease_code: str,
    iso3: str,
    year: int,
    week: int,
) -> PredictionPoint:
    disease = resolve_disease(db, disease_code)
    if feature_lookup.is_after_latest_valid_week(disease.id, year, week):
        latest_year, latest_week = feature_lookup.get_latest_valid_week(disease.id) or (None, None)
        raise HTTPException(
            status_code=404,
            detail=(
                f"{disease_code} chỉ có dữ liệu hợp lệ đến "
                f"Năm {latest_year}, Tuần {latest_week:02d} trong dataset hiện có."
            ),
        )
    row = prediction_crud.get_one(db, disease.id, iso3.upper(), year, week)
    if not row:
        raise HTTPException(status_code=404, detail="Không có dự báo cho tuần này")
    return PredictionPoint.model_validate(row, from_attributes=True)


def add_iso_weeks(iso_year: int, iso_week: int, delta_weeks: int) -> tuple[int, int]:
    """
    Cộng delta_weeks vào (iso_year, iso_week), trả (target_year, target_week).
    Xử lý cross-year boundary đúng chuẩn ISO 8601.

    Ví dụ: add_iso_weeks(2019, 52, 4) → (2020, 4)
    """
    d = date.fromisocalendar(iso_year, iso_week, 1)  # Monday của ISO week
    target = d + timedelta(weeks=delta_weeks)
    y, w, _ = target.isocalendar()
    return (y, w)


def get_forecast(
    db: Session,
    disease_code: str,
    iso3: str,
    as_of_year: int,
    as_of_week: int,
) -> ForecastResponse:
    """
    Multi-horizon forecast (h=1..4) cho (disease, iso3) tại tuần as_of.
    Lookup feature snapshot từ DB → predict mỗi horizon.
    """
    disease = resolve_disease(db, disease_code)
    iso3_upper = iso3.upper()
    if feature_lookup.is_after_latest_valid_week(disease.id, as_of_year, as_of_week):
        latest_year, latest_week = feature_lookup.get_latest_valid_week(disease.id) or (None, None)
        raise HTTPException(
            status_code=404,
            detail=(
                f"{disease_code} chỉ có dữ liệu hợp lệ đến "
                f"Năm {latest_year}, Tuần {latest_week:02d} trong dataset hiện có."
            ),
        )

    features = feature_lookup.get_features(
        db, disease.id, iso3_upper, as_of_year, as_of_week
    )
    if features is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Không có feature snapshot cho {disease_code}/{iso3_upper} "
                f"tại Tuần {as_of_week:02d}, Năm {as_of_year}"
            ),
        )

    targets = [add_iso_weeks(as_of_year, as_of_week, h) for h in ml_engine.HORIZONS]
    baselines = _bortman_baselines(
        db,
        disease.id,
        disease_code,
        iso3_upper,
        {target_week for _, target_week in targets},
    )
    points: list[ForecastPoint] = []
    for h, (target_year, target_week) in zip(ml_engine.HORIZONS, targets, strict=True):
        try:
            result = ml_engine.predict_horizon(disease_code, h, features)
        except ValueError as e:
            raise HTTPException(status_code=503, detail=str(e))

        points.append(ForecastPoint(
            horizon=h,
            target_iso_year=target_year,
            target_iso_week=target_week,
            predicted_log=result["predicted_log"],
            predicted_cases=result["predicted_cases"],
            risk_level=_risk_from_bortman(result["predicted_cases"], baselines.get(target_week)),
            r2_cv=result.get("r2_cv"),
            rmse_cv=result.get("rmse_cv"),
            model_version=result["model_version"],
        ))

    coverage_dict = feature_lookup.build_data_coverage(
        db, disease.id, iso3_upper, as_of_year
    )
    coverage = DataCoverage(**coverage_dict)

    return ForecastResponse(
        disease=disease_code,
        iso3=iso3_upper,
        as_of_iso_year=as_of_year,
        as_of_iso_week=as_of_week,
        points=points,
        risk_method="bortman_1999_endemic_channel",
        data_coverage=coverage,
    )


def get_history(
    db: Session,
    disease_code: str,
    iso3: str,
    start_year: int,
    end_year: int,
    limit: int | None = None,
) -> HistoryResponse:
    disease = resolve_disease(db, disease_code)
    iso3 = iso3.upper()

    predictions = prediction_crud.list_history(
        db, disease.id, iso3, start_year, end_year, limit
    )
    actuals = prediction_crud.list_actuals(db, disease.id, iso3, start_year, end_year)

    points = [
        HistoryPoint(
            iso_year=p.iso_year,
            iso_week=p.iso_week,
            predicted_cases=p.predicted_cases,
            actual_cases=actuals.get((p.iso_year, p.iso_week)),
            risk_level=p.risk_level,
        )
        for p in predictions
    ]
    return HistoryResponse(disease=disease_code, iso3=iso3, points=points)
