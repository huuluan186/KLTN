import re, psycopg2
from pathlib import Path

env_path = Path('src/.env')
url = re.search(r'^DATABASE_URL=(\S+)', env_path.read_text(encoding='utf-8', errors='ignore'), re.M).group(1).strip()
conn = psycopg2.connect(url)
cur = conn.cursor()

try:
    cur.execute("UPDATE predictions SET risk_level = 'Low', risk_probability = 0.0 WHERE ROUND(predicted_cases::numeric) <= 0 AND risk_level != 'Low'")
    print(f'Rows updated: {cur.rowcount}')
    conn.commit()
except Exception as e:
    print('Error:', e)
finally:
    cur.close()
    conn.close()
