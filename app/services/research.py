"""Pesquisa leve na internet (NewsAPI e PubMed E-utilities) antes da geração de conteúdo.

Devolve trechos recentes sobre o tema e diretrizes biomédicas de saúde/viagem,
ou "" se não configurado/falhar — a geração nunca depende desta etapa.
"""
import logging
import re
import urllib.parse

from app.config import get_settings
from app.services import http_get_json

logger = logging.getLogger(__name__)

MAX_QUERY_LEN = 120


def research_pubmed(topic: str, tags: list[str] | None = None, limit: int = 2, timeout: float = 4.0) -> list[str]:
    """Busca rápida no PubMed por orientações de medicina de viagem relevantes ao destino."""
    clean_topic = (topic or "").strip()
    if not clean_topic:
        return []

    text = f"{clean_topic} {' '.join(tags or [])}".lower()
    words = set(re.findall(r"\b[a-zà-ÿ0-9]+\b", text))
    if any(w in words for w in ("trilha", "serra", "montanha", "altitude", "trekking", "escalada", "chapada")):
        context_terms = "altitude sickness OR hypothermia OR prevention"
    elif any(w in words for w in ("praia", "litoral", "mar", "mergulho", "ilha", "costa")):
        context_terms = "marine stings OR sun protection OR decompression sickness"
    elif any(w in words for w in ("floresta", "amazonia", "pantanal", "ecoturismo", "selva", "rio")):
        context_terms = "malaria prevention OR yellow fever OR insect repellent"
    else:
        context_terms = "prevention OR health risks"

    query = f"{clean_topic} (travel medicine OR {context_terms})"
    safe_q = urllib.parse.quote(query[:MAX_QUERY_LEN])
    search_url = (
        f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?"
        f"db=pubmed&term={safe_q}&retmode=json&retmax={limit}&tool=blog-turismo"
    )
    results: list[str] = []
    try:
        search_data = http_get_json(search_url, timeout=timeout)
        id_list = search_data.get("esearchresult", {}).get("idlist", [])
        if not id_list:
            return []
        ids_str = ",".join(id_list)
        summary_url = (
            f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?"
            f"db=pubmed&id={ids_str}&retmode=json&tool=blog-turismo"
        )
        summary_data = http_get_json(summary_url, timeout=timeout)
        result_dict = summary_data.get("result", {})
        for pmid in id_list:
            item = result_dict.get(pmid)
            if item and item.get("title"):
                title = str(item.get("title")).rstrip(".")
                results.append(f"- [Evidência PubMed] {title}")
    except Exception as exc:
        logger.debug("Pesquisa PubMed silenciosamente ignorada (%s): %s", topic, exc)
    return results


def research(topic: str, tags: list[str] | None = None, limit: int = 6, timeout: float = 12.0) -> str:
    """Trechos em pt-BR sobre o tema, um por linha (deduplicados)."""
    snippets: list[str] = []
    seen: set[str] = set()

    # 1. PubMed (E-utilities) para diretrizes de saúde/segurança em viagens (máximo 4s para não travar a geração)
    pubmed_snippets = research_pubmed(topic, tags=tags, limit=2, timeout=min(timeout, 4.0))
    for text in pubmed_snippets:
        dedupe_key = text.lower()[:80]
        if dedupe_key not in seen:
            seen.add(dedupe_key)
            snippets.append(text)

    # 2. NewsAPI (opcional, se chave configurada)
    key = get_settings().news_api_key
    if key:
        safe = topic.replace('"', "").strip()[:MAX_QUERY_LEN]
        if safe:
            q = f'"{safe}" AND (guia OR viagem OR turismo OR dicas)'
            url = (
                "https://newsapi.org/v2/everything?"
                f"q={urllib.parse.quote(q)}&language=pt&pageSize={limit}"
                f"&sortBy=relevancy&apiKey={key}"
            )
            try:
                payload = http_get_json(url, timeout=timeout)
                for article in payload.get("articles", []):
                    title = str(article.get("title") or "").strip()
                    desc = str(article.get("description") or "").strip()
                    text = f"{title}. {desc}".strip() if desc else title
                    dedupe_key = text.lower()[:80]
                    if text and dedupe_key not in seen:
                        seen.add(dedupe_key)
                        snippets.append(f"- {text}")
            except Exception as exc:
                logger.warning("Pesquisa via NewsAPI indisponível (%s): %s", safe, exc)

    return "\n".join(snippets[:limit])
