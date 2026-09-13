"""Pesquisa leve na internet (NewsAPI grátis) antes da geração de conteúdo.

Devolve trechos recentes sobre o tema, ou "" se não configurado/falhar —
a geração nunca depende desta etapa.
"""
import logging
import urllib.parse

from app.config import get_settings
from app.services import http_get_json

logger = logging.getLogger(__name__)

MAX_QUERY_LEN = 120


def research(topic: str, limit: int = 6, timeout: float = 12.0) -> str:
    """Trechos em pt-BR sobre o tema, um por linha (deduplicados)."""
    key = get_settings().news_api_key
    if not key:
        return ""

    safe = topic.replace('"', "").strip()[:MAX_QUERY_LEN]
    if not safe:
        return ""

    q = f'"{safe}" AND (guia OR viagem OR turismo OR dicas)'
    url = (
        "https://newsapi.org/v2/everything?"
        f"q={urllib.parse.quote(q)}&language=pt&pageSize={limit}"
        f"&sortBy=relevancy&apiKey={key}"
    )
    try:
        payload = http_get_json(url, timeout=timeout)
    except Exception as exc:
        logger.warning("Pesquisa via NewsAPI indisponível (%s): %s", safe, exc)
        return ""

    snippets: list[str] = []
    seen: set[str] = set()
    for article in payload.get("articles", []):
        title = str(article.get("title") or "").strip()
        desc = str(article.get("description") or "").strip()
        text = f"{title}. {desc}".strip() if desc else title
        dedupe_key = text.lower()[:80]
        if text and dedupe_key not in seen:
            seen.add(dedupe_key)
            snippets.append(f"- {text}")
    return "\n".join(snippets[:limit])