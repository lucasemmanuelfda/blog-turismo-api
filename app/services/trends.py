"""Temas do dia: Google Trends (pytrends), com reserva NewsAPI, cacheados por dia.

Devolve CANDIDATOS brutos (termos/títulos); a camada de IA transforma esses
candidatos em tópicos de viagem evergreen (atemporais) e sem notícias.
"""
import json
import logging
import threading
import urllib.parse
import os
from datetime import date, datetime, timedelta

from app.config import get_settings
from app.services import http_get_json

logger = logging.getLogger(__name__)

SEED_TOPICS = [
    "praias do nordeste",
    "serra fluminense",
    "caminhos rurais do sul",
    "vilas históricas de minas",
    "ecoturismo na amazônia",
    "vinícolas da serra gaúcha",
    "roteiro em bonito",
    "trilhas em chapada dos veadeiros",
    "cataratas do iguaçu",
    "fernando de noronha",
    "gramado e canela",
    "ilha do mel",
    "lençóis maranhenses",
    "ilha grande rio de janeiro",
    "morro de são paulo bahia",
    "petrópolis serra fluminense",
]


class TrendService:
    def __init__(self, path: str | None = None) -> None:
        self.path = path or get_settings().topics_cache_file
        self._lock = threading.Lock()
        self.data: dict = {}
        self._load()

    def _load(self) -> None:
        try:
            with open(self.path, encoding="utf-8") as f:
                self.data = json.load(f)
        except (FileNotFoundError, ValueError, json.JSONDecodeError):
            self.data = {}

    def _purge_old_entries(self) -> None:
        cutoff = date.today() - timedelta(days=7)
        keys_to_del = []
        for k in self.data:
            try:
                if datetime.strptime(k, "%Y-%m-%d").date() < cutoff:
                    keys_to_del.append(k)
            except ValueError:
                pass
        for k in keys_to_del:
            self.data.pop(k, None)

    def _save(self) -> None:
        parent = os.path.dirname(self.path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        self._purge_old_entries()
        tmp_path = f"{self.path}.tmp"
        with self._lock:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(self.data, f, ensure_ascii=False, indent=1)
            os.replace(tmp_path, self.path)

    @staticmethod
    def _dedupe(items: list[str], max_keys: int = 4) -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for item in items:
            key = " ".join(item.lower().replace("-", " ").split()[:max_keys])
            if key.strip() and key not in seen:
                seen.add(key)
                out.append(item.strip())
        return out

    def _google_trends(self, country: str, n: int) -> list[str]:
        """Consultas relacionadas (em alta) a viagens no Google Trends com backoff e cabeçalhos realistas."""
        try:
            from pytrends.request import TrendReq

            pt = TrendReq(
                hl="pt-BR",
                tz=180,
                timeout=(5, 12),
                retries=2,
                backoff_factor=0.8,
                requests_args={
                    "headers": {
                        "User-Agent": (
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                            "AppleWebKit/537.36 (KHTML, like Gecko) "
                            "Chrome/122.0.0.0 Safari/537.36"
                        )
                    }
                },
            )
            queries: list[str] = []
            for kw in ("viagem turismo", "viagem"):
                try:
                    pt.build_payload(kw_list=[kw], timeframe="today 1-m", geo=country)
                    frames = pt.related_queries().values()
                    for frame in frames:
                        if frame is None:
                            continue
                        for col in ("rising", "top"):
                            data = frame.get(col)
                            if data is not None and not data.empty:
                                queries.extend(str(q) for q in data["query"].tolist())
                    if queries:
                        break
                except Exception as kw_err:
                    logger.debug("Tentativa com kw '%s' falhou: %s", kw, kw_err)
            return self._dedupe(queries)[:n]
        except Exception as exc:
            logger.warning("Google Trends indisponível: %s", exc)
            return []

    def _news(self, n: int) -> list[str]:
        """Reserva gratuita: manchetes recentes de turismo (NewsAPI.org)."""
        key = get_settings().news_api_key
        if not key:
            return []

        url = (
            "https://newsapi.org/v2/everything?"
            f"q={urllib.parse.quote('turismo OR viagem')}&language=pt&pageSize=20"
            f"&sortBy=publishedAt&apiKey={key}"
        )
        try:
            payload = http_get_json(url, timeout=15)
            titles: list[str] = []
            for a in payload.get("articles", []):
                titles.append(a.get("title", "") or "")
                titles.append(a.get("description", "") or "")
            return self._dedupe(titles)[:n]
        except Exception as exc:
            logger.warning("NewsAPI indisponível: %s", exc)
            return []

    def daily_candidates(self) -> list[str]:
        """Candidatos de temas do dia (cacheado por dia, nunca vazio)."""
        key = date.today().isoformat()
        cached = self.data.get(key)
        if cached:
            return cached

        settings = get_settings()
        n = max(settings.max_posts_per_day * 2, 8)
        candidates = self._google_trends(settings.trends_country, n=n)
        if not candidates:
            candidates = self._news(n)
        candidates = self._dedupe(candidates + SEED_TOPICS)
        self.data[key] = candidates
        self._save()
        return candidates


trends = TrendService()