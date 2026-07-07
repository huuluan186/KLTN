"""fix_champion_flags.py — dọn cờ is_champion trùng trong model_versions.

Bối cảnh: mỗi disease từng có 2 dòng is_champion=TRUE — v1.0 cũ (seed ban đầu)
và v2-regressor (champion thật sau Optuna). Predictions đang phục vụ chỉ trỏ
v2-regressor, nhưng để 2 champion dễ gây chọn nhầm nếu về sau có query champion
không kèm filter '-regressor'. Script hạ v1.0 xuống is_champion=FALSE, giữ đúng
một champion regressor mỗi disease.

Idempotent — chạy lại chỉ update các dòng còn TRUE.
"""

import os
import re
import sys
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
load_dotenv()

env_path = Path(__file__).resolve().parent.parent / ".env"
url = os.getenv("DATABASE_URL")
if url is None and env_path.exists():
    m = re.search(r"^DATABASE_URL=(\S+)", env_path.read_text(encoding="utf-8", errors="ignore"), re.M)
    url = m.group(1).strip() if m else None
if url is None:
    sys.exit("Không tìm thấy DATABASE_URL")

conn = psycopg2.connect(url)
cur = conn.cursor()
try:
    cur.execute(
        "UPDATE model_versions SET is_champion = FALSE "
        "WHERE version = 'v1.0' AND is_champion = TRUE"
    )
    print(f"Rows updated: {cur.rowcount}")
    conn.commit()

    cur.execute(
        "SELECT disease_id, version, is_active, is_champion "
        "FROM model_versions WHERE is_champion = TRUE ORDER BY disease_id"
    )
    print("Champion còn lại:")
    for r in cur.fetchall():
        print(" ", r)
except Exception as e:
    conn.rollback()
    print("Error:", e)
finally:
    cur.close()
    conn.close()
