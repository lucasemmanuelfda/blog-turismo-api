import json
import re
from typing import Any

from openai import OpenAI

from app.config import get_settings
from app.services.memory import memory


class AIService:
    """Gera conteúdo de turismo usando qualquer API compatível com OpenAI."""

    def __init__(self) -> None:
        self.settings = get_settings()
        kwargs: dict[str, Any] = {
            "api_key": self.settings.ai_api_key or "sk-nokey",
            "timeout": 90,
        }
        if self.settings.ai_base_url:
            kwargs["base_url"] = self.settings.ai_base_url
        self.client = OpenAI(**kwargs)

    @property
    def available(self) -> bool:
        return bool(self.settings.ai_api_key and self.settings.ai_model)

    def _model(self) -> str:
        return self.settings.ai_model or "gpt-4o-mini"

    def _system_prompt(self, language: str) -> str:
        return f"""
Você é um redator profissional de um blog de turismo. Escreva em {language}.
Regras obrigatórias:
- Conteúdo original, factual e otimizado para SEO, sem sensacionalismo.
- NUNCA mencione que o conteúdo foi gerado por IA, nem escreva avisos como "este artigo foi gerado automaticamente".
- Estruture em seções com título [H2] e parágrafos em [H3] quando necessário.
- Use Markdown limpo (## para H2, ### para H3, listas e **destaques**).
- Inclua dicas práticas, horários, custo médio, melhor época e como chegar.
- Cite datas, valores e fatos de forma conservadora (evite dados inventados).
- Retorne SOMENTE JSON válido, sem texto ao redor, no formato:
{{
  "title": "título SEO com até 60 caracteres",
  "meta_title": "título para o Google até 60 caracteres",
  "meta_description": "descrição até 155 caracteres",
  "summary": "resumo de 2 a 3 frases",
  "content": "artigo completo em Markdown (mínimo 800 palavras)",
  "keywords": ["5-8 palavras-chave", "focadas em turismo"],
  "tags": ["3-5 tags curtas"],
  "image_prompt": "descrição em inglês para gerar uma imagem de capa",
  "facts": {{
    "melhor_epoca": "fato objetivo (ex.: 'abril a novembro')",
    "custo_medio": "ex.: 'médio; diária R$300'",
    "como_chegar": "ex.: 'ônibus de Porto Alegre, 2h'",
    "destaques": "3 destaques separados por vírgula",
    "dicas": "3 dicas práticas separadas por vírgula"
  }}
}}
""".strip()

    def generate_travel_post(
        self,
        topic: str,
        category: str | None = None,
        language: str | None = None,
        target_audience: str | None = None,
    ) -> dict[str, Any]:
        lang = language or self.settings.ai_language
        audience = target_audience or "viajantes em geral"

        memory_context = memory.context_block(topic)
        user_prompt = f"""
Crie um artigo de turismo sobre: "{topic}".
Categoria do blog: {category or "geral"}.
Público-alvo: {audience}.

Memória do blog (fatos já apurados e títulos já publicados — NÃO repita títulos,
reutilize os fatos com coerência):
{memory_context}

O artigo deve ser completo e útil, cobrindo: por que visitar, o que fazer,
onde comer, onde se hospedar, como chegar, custos aproximados, dicas de
segurança e perguntas frequentes ao final.
""".strip()

        response = self.client.chat.completions.create(
            model=self._model(),
            messages=[
                {"role": "system", "content": self._system_prompt(lang)},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.7,
            response_format={"type": "json_object"},
        )

        raw = response.choices[0].message.content or "{}"
        return self._parse_json(raw)

    def _parse_json(self, raw: str) -> dict[str, Any]:
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            match = re.search(r"\{.*\}", raw, re.DOTALL)
            if not match:
                raise ValueError("Resposta da IA não continha JSON válido")
            data = json.loads(match.group(0))

        defaults = {
            "title": "Sem título",
            "meta_title": "",
            "meta_description": "",
            "summary": "",
            "content": "",
            "keywords": [],
            "tags": [],
            "image_prompt": "",
            "facts": {},
        }
        defaults.update(data)
        data = defaults

        if not isinstance(data.get("facts"), dict):
            data["facts"] = {}
        if not data["content"] or len(data["content"]) < 300:
            data["content"] = self._fallback_markdown(data["title"] or "título")
        return data

    @staticmethod
    def _fallback_markdown(title: str, min_words: int = 800) -> str:
        """Texto básico de reserva caso a IA não retorne conteúdo suficiente."""
        section = [
            "O que esperar",
            "O que fazer",
            "Onde comer",
            "Onde se hospedar",
            "Como chegar",
            "Quanto custa",
            "Dicas de segurança",
            "Perguntas frequentes",
        ]
        md = [f"# {title}\n"]
        for s in section:
            md.append(f"## {s}")
            md.append(
                "Texto gerado automaticamente. Suplemente aqui as informações "
                "sobre esta seção antes de publicar.\n"
            )
        body = "\n".join(md)
        words = len(body.split())
        fill = max(min_words - words, 0)
        if fill:
            body += "\n\n" + "\n\n".join(["Parágrafo informativo sobre o destino."] * 5)
        return body


ai_service = AIService()