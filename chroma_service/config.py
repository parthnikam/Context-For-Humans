"""Service-wide configuration: paths, limits, model names, and API key loading."""

from __future__ import annotations

import os
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("CHROMA_DATA_DIR", SERVICE_DIR / "data")).resolve()
COLLECTION_NAME = "conversation_titles"

MAX_CONVERSATIONS = 2000
QUERY_BATCH_SIZE = 64
SEARCH_TOP_K = 40

TYPESAFE_MODEL = "jev-latest"
TYPESAFE_SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone"
# Each Choice question repeats the full category taxonomy (~4k input tokens),
# and Jev caps a single request at 64k combined state+questions tokens.
# 12 titles per request stays near 49k tokens even with long titles, and
# classify_title_batch splits further if a request still exceeds the limit.
TYPESAFE_CLASSIFICATION_BATCH_SIZE = 12

OPENAI_MODEL = "gpt-5.6-luna"
OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions"


def load_openai_api_key() -> str:
    return _load_env_key("OPENAI_API_KEY")


def load_typesafe_api_key() -> str:
    return _load_env_key("TYPESAFE_API_KEY")


def load_mem0_api_key() -> str:
    return _load_env_key("MEM0_API_KEY") or _load_env_key("MEMO_API_KEY")


def _load_env_key(name: str) -> str:
    key = os.environ.get(name, "").strip()
    if key:
        return key
    env_path = SERVICE_DIR.parent / "chrome_agent" / ".env"
    if not env_path.is_file():
        return ""
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    for line in lines:
        value = line.strip()
        if not value or value.startswith("#") or "=" not in value:
            continue
        key_name, raw_value = value.split("=", 1)
        if key_name.strip() == name:
            result = raw_value.strip()
            if len(result) >= 2 and result[0] == result[-1] and result[0] in {"'", '"'}:
                result = result[1:-1]
            return result.strip()
    return ""
