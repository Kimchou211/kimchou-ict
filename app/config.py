from pathlib import Path
import os
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")

APP_NAME = os.getenv("APP_NAME", "JD ANALYSIS")
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.6-flash").strip()
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "").strip()
DEEPSEEK_VISION_MODEL = os.getenv("DEEPSEEK_VISION_MODEL", "deepseek-flash").strip()
DEEPSEEK_CHAT_MODEL = os.getenv("DEEPSEEK_CHAT_MODEL", "deepseek-flash").strip()
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "12"))
CONFIDENCE_MINIMUM = int(os.getenv("CONFIDENCE_MINIMUM", "65"))
PRICE_AGREEMENT_ABSOLUTE = float(os.getenv("PRICE_AGREEMENT_ABSOLUTE", "0.50"))
ATR_AGREEMENT_PERCENT = float(os.getenv("ATR_AGREEMENT_PERCENT", "0.20"))
# FORCE_SIGNAL=true  -> return a best-effort direction when one can be inferred; not trade-ready.
# FORCE_SIGNAL=false -> strict mode (returns WAIT when validation checks fail).
FORCE_SIGNAL = os.getenv("FORCE_SIGNAL", "true").strip().lower() in ("1", "true", "yes", "on")
UPLOAD_DIR = ROOT_DIR / "uploads"
DATA_DIR = ROOT_DIR / "data"
STATIC_DIR = ROOT_DIR / "static"
UPLOAD_DIR.mkdir(exist_ok=True)
DATA_DIR.mkdir(exist_ok=True)

if DATABASE_URL:
    # SQLAlchemy 2 + psycopg 3 URL normalization for Neon URLs.
    if DATABASE_URL.startswith("postgres://"):
        DATABASE_URL = "postgresql+psycopg://" + DATABASE_URL[len("postgres://"):]
    elif DATABASE_URL.startswith("postgresql://") and "+psycopg" not in DATABASE_URL:
        DATABASE_URL = "postgresql+psycopg://" + DATABASE_URL[len("postgresql://"):]
else:
    DATABASE_URL = f"sqlite:///{(DATA_DIR / 'jd_analysis.db').as_posix()}"

# ---- ICT upgrade ---------------------------------------------------------------------------
TWELVEDATA_API_KEY = os.getenv("TWELVEDATA_API_KEY", "").strip()
TWELVEDATA_SYMBOL = os.getenv("TWELVEDATA_SYMBOL", "XAU/USD").strip()
APP_USER = os.getenv("APP_USER", "jd").strip()
APP_PASSWORD = os.getenv("APP_PASSWORD", "").strip()  # empty = no login (local use)
ICT_MIN_SCORE = int(os.getenv("ICT_MIN_SCORE", "60"))
ICT_AI_LANGUAGE = os.getenv("ICT_AI_LANGUAGE", "Khmer").strip()
AUTO_TRACK = os.getenv("AUTO_TRACK", "true").strip().lower() in ("1", "true", "yes", "on")
AUTO_TRACK_SECONDS = int(os.getenv("AUTO_TRACK_SECONDS", "90"))


def _hours(name: str, default: str) -> tuple[float, float]:
    raw = os.getenv(name, default)
    try:
        a, b = raw.split("-")
        return float(a), float(b)
    except ValueError:
        a, b = default.split("-")
        return float(a), float(b)


# Session windows in UTC hours. ICT kill zones are defined in New York time, so they shift by an
# hour with US daylight saving; edit these in .env if you want the winter values (London 7-10, NY 13-16).
ICT_ASIA_UTC = _hours("ICT_ASIA_UTC", "0-7")
ICT_LONDON_KZ_UTC = _hours("ICT_LONDON_KZ_UTC", "7-10")
ICT_NY_KZ_UTC = _hours("ICT_NY_KZ_UTC", "12-15")
