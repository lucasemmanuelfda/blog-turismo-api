"""Segundo cérebro do blog: guarda em arquivo fatos já apurados para cada
destino/tema. Em vez de reenviar artigos inteiros (contexto pesado), envia
apenas um resumo compacto da memória nos próximos prompts."""
import json
import os
import threading
from datetime import datetime

from app.config import get_settings

MAX_FACTS_KEPT = 20
MAX_FACTS_IN_PROMPT = 5


class MemoryManager:
    def __init__(self, path: str | None = None) -> None:
        self.path = path or get_settings().memory_file
        self._lock = threading.Lock()
        self.data: dict = {"topics": {}}
        self._load()

    def _load(self) -> None:
        try:
            with open(self.path, encoding="utf-8") as f:
                self.data = json.load(f)
        except (FileNotFoundError, ValueError, json.JSONDecodeError):
            self.data = {"topics": {}}

    def _save(self) -> None:
        parent = os.path.dirname(self.path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with self._lock:
            with open(self.path, "w", encoding="utf-8") as f:
                json.dump(self.data, f, ensure_ascii=False, indent=1)

    def _key(self, topic: str) -> str:
        words = topic.lower().replace("-", " ").split()
        return " ".join(words[:3])

    def remember(self, topic: str, facts: dict, title: str, slug: str, category: str | None = None) -> None:
        """Guarda fatos estruturados e títulos já gerados sobre um tema."""
        key = self._key(topic)
        slot = self.data["topics"].setdefault(key, {"titles": [], "facts": [], "category": None})
        slot["titles"].append({"title": title, "slug": slug, "when": datetime.utcnow().isoformat(timespec="seconds")})
        slot["titles"] = slot["titles"][-20:]
        known = {f.get("detail", "") for f in slot["facts"]}
        for label, detail in (facts or {}).items():
            if detail and str(detail) not in known:
                slot["facts"].append({"label": str(label), "detail": str(detail)})
        slot["facts"] = slot["facts"][-MAX_FACTS_KEPT:]
        if category and not slot["category"]:
            slot["category"] = category
        self._save()

    def context_block(self, topic: str) -> str:
        """Resumo compacto da memória para injetar no prompt (pouco texto)."""
        key = self._key(topic)
        lines: list[str] = []
        for k, slot in self.data["topics"].items():
            prefix = "" if k == key else "(tema) "
            titles = "".join(f"- {t['title']}\n" for t in slot["titles"][-3:])
            if titles:
                lines.append(f"{prefix}Já publicamos sobre '{k}':\n{titles}")
            for fact in slot["facts"][-MAX_FACTS_IN_PROMPT:]:
                lines.append(f"{prefix}{fact['label']}: {fact['detail']}")
        return "\n".join(lines[:12]) if lines else "Nenhum conteúdo prévio ainda."

    def queue_topics(self) -> list[str]:
        """Temas ainda não gerados (para a rotina diária)."""
        done = set(self.data["topics"])
        return [t for t in get_settings().daily_topics.split(",") if t.strip() and self._key(t.strip()) not in done]


memory = MemoryManager()