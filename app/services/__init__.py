import json
import re
import unicodedata


def slugify(text: str, max_len: int = 200) -> str:
    """Converte texto em slug URL-friendly (mantém acentos básicos de pt-BR se possível)."""
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "ignore").decode("ascii")
    text = text.lower()
    text = re.sub(r"[^a-z0-9\u00e0-\u00ff]+", "-", text)
    text = re.sub(r"-{2,}", "-", text).strip("-")
    return text[:max_len]


def unique_slug(text: str, existing_slugs: list[str]) -> str:
    base = slugify(text)
    if base not in existing_slugs:
        return base
    counter = 2
    while f"{base}-{counter}" in existing_slugs:
        counter += 1
    return f"{base}-{counter}"


def serialize_list(values: list[str]) -> str:
    return json.dumps(values, ensure_ascii=False)


def parse_list(raw: str) -> list[str]:
    if not raw:
        return []
    return json.loads(raw)


def build_meta_title(title: str, max_len: int = 60) -> str:
    if len(title) <= max_len:
        return title
    return title[: max_len - 1].rstrip() + "…"