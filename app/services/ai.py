import json
import re
import time
from typing import Any

from openai import OpenAI

from app.config import get_settings
from app.services.memory import memory
from app.services.research import research


def _clean_kit(raw: Any) -> list[dict[str, str]]:
    """Mantém até 3 itens de kit com name/query válidos (never quebra o post)."""
    if not isinstance(raw, list):
        return []
    items = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        query = str(item.get("query") or name).strip()
        if name and query and len(items) < 3:
            items.append({"name": name, "note": str(item.get("note") or "").strip(), "query": query})
    return items


class AIService:
    """Gera conteúdo de turismo usando qualquer API compatível com OpenAI."""

    def __init__(self) -> None:
        self.settings = get_settings()
        self.client = OpenAI(
            api_key=self.settings.ai_api_key or "sk-nokey",
            base_url=(self.settings.ai_base_url or "https://api.openai.com/v1"),
            timeout=90,
        )
        self.fallback_client: OpenAI | None = None
        if self.settings.ai_fallback_api_key and self.settings.ai_fallback_base_url:
            self.fallback_client = OpenAI(
                api_key=self.settings.ai_fallback_api_key,
                base_url=self.settings.ai_fallback_base_url,
                timeout=90,
            )

    @property
    def available(self) -> bool:
        return bool(self.settings.ai_api_key and self.settings.ai_model)

    @property
    def fallback_available(self) -> bool:
        return bool(
            self.fallback_client
            and self.settings.ai_fallback_model
        )

    def _model(self) -> str:
        return self.settings.ai_model or "gpt-4o-mini"

    def _system_prompt(self, language: str) -> str:
        return f"""
Você é um redator e viajante experiente de um blog de turismo brasileiro de alta autoridade. Escreva em {language}.
Sua voz: um viajante curioso, prático e honesto que conversa com um amigo — nada de folheto turístico, catálogo frio ou tom corporativo.

Como escrever com autoridade e humanidade (E-E-A-T do Google):
- Use primeira pessoa com moderação ("na minha visita", "o que mais me surpreendeu"), com opinião honesta (diga o que realmente vale o preço e o que pode pular).
- Parágrafos de 2 a 4 frases, com ritmo variado e começos diversos (nunca comece todo parágrafo com o nome do destino).
- Detalhes sensoriais e práticos: horário exato de menor fila, vento no fim de tarde, cheiro da comida de rua, sensação térmica, tipo de calçado necessário.
- NÃO invente dados históricos complexos ou estatísticas não verificáveis. Use faixas de valores realistas em Reais (R$).

OBRIGATÓRIO incluir no Markdown do "content":
1. TABELA DE ROTEIRO SINTÉTICO (Markdown):
   Crie uma tabela prática de roteiro sugerido:
   | Dia | Turno | Atração / Atividade | Dica Prática |
   | :--- | :--- | :--- | :--- |
2. TABELA DE ORÇAMENTO ESTIMADO (Markdown):
   Crie uma tabela com estimativas de custos médios diários por pessoa:
   | Perfil de Viajante | Hospedagem (diária) | Alimentação (dia) | Passeios | Total Médio / Dia |
   | :--- | :--- | :--- | :--- | :--- |
3. SEÇÃO "DICAS PULO DO GATO" (H2):
   3 conselhos valiosos de morador local ou viajante frequente (ex.: pegadinha de estacionamento, melhor ângulo de foto gratuito, como evitar filas, melhor horário para chegar).
4. SEÇÃO "ONDE FICAR" (H2):
   Sugira 3 perfis de hospedagem (econômico, custo-benefício e charme/conforto) com dicas de localização estratégica.
5. SEÇÃO "O QUE LEVAR NA MALA" (H2):
   Cite organicamente os 3 itens do "kit_recommendations" explicando sua utilidade prática no terreno desse destino.
6. SEÇÃO "SEGURANÇA E SAÚDE" (H2):
   Oriente sobre cuidados essenciais e mencione a importância de contratar um Seguro Viagem antes de embarcar.
7. SEÇÃO "PERGUNTAS FREQUENTES (FAQ)" (H2):
   4 a 5 perguntas frequentes de busca direta no Google com respostas objetivas de 2 a 3 frases (formato ideal para Featured Snippets do Google).

EVITE TERMINANTEMENTE estes clichês de IA em português:
"além disso", "vale ressaltar", "em resumo", "em conclusão", "não deixe de",
"imperdível", "uma experiência única", "tesouro escondido", "paraíso na terra",
"com certeza", "melhor época para visitar" (repetido), "sem dúvida", "venha conhecer",
"paisagens deslumbrantes", "gastronomia de dar água na boca".

Para "kit_recommendations":
- Exatamente 3 produtos físicos REAIS, genéricos (sem marcas registradas específicas), compráveis na Amazon Brasil, fundamentais para a viagem.
- "query": termo de busca vago e eficaz em português para a Amazon (ex.: "sapatilha aquatica neoprene", "mochila impermeavel 20l", "adaptador universal tomada").

Retorne SOMENTE JSON válido, sem texto antes ou depois:
{{
  "title": "título atraente e otimizado para SEO até 60 caracteres",
  "meta_title": "título conciso para o Google até 60 caracteres",
  "meta_description": "meta descrição persuasiva com gatilho de clique até 155 caracteres",
  "summary": "resumo cativante de 2 a 3 frases",
  "content": "artigo completo em Markdown rico (mínimo 900 palavras, com as 2 tabelas, H2, H3, FAQ e listas)",
  "keywords": ["5-8 palavras-chave focadas em busca real de turismo"],
  "tags": ["3-5 tags curtas em minúsculas"],
  "image_prompt": "descrição concisa em inglês do local para foto realista",
  "facts": {{
    "melhor_epoca": "fato objetivo (ex.: 'maio a setembro, época de seca')",
    "custo_medio": "ex.: 'médio; diárias de R$ 250 a R$ 450'",
    "como_chegar": "ex.: 'voo até aeroporto X + 2h de transfer'",
    "destaques": "3 destaques separados por vírgula",
    "dicas": "3 dicas práticas separadas por vírgula"
  }},
  "kit_recommendations": [
    {{
      "name": "nome do produto genérico (ex.: Sapatilha Aquática de Neoprene)",
      "note": "frase explicando exatamente por que é indispensável neste destino",
      "query": "termo de busca para a Amazon"
    }}
  ]
}}
""".strip()

    def generate_travel_post(
        self,
        topic: str,
        category: str | None = None,
        language: str | None = None,
        target_audience: str | None = None,
        provider: str = "auto",
    ) -> dict[str, Any]:
        lang = language or self.settings.ai_language
        audience = target_audience or "viajantes em geral"

        memory_context = memory.context_block(topic)
        research_context = research(topic)
        research_block = (
            "\nPesquisa rápida na internet (use como referência factual; NÃO invente "
            f"dados além deles; prefira dados concretos destes trechos):\n{research_context}\n"
            if research_context
            else ""
        )
        user_prompt = f"""
Crie um artigo completo, autoritativo e aprofundado de turismo sobre: "{topic}".
Categoria do blog: {category or "geral"}.
Público-alvo: {audience}.{research_block}

Memória do blog (evite duplicar títulos já publicados e mantenha coerência com fatos anteriores):
{memory_context}

Estrutura obrigatória do artigo:
1. Introdução envolvente com atmosfera do local e para quem o destino é ideal.
2. O que fazer (principais atrativos com ordem lógica).
3. Tabela de Roteiro Sintético (Dia a Dia).
4. Onde comer (pratos típicos autênticos e regiões de restaurantes).
5. Onde se hospedar (melhores bairros e indicações de perfis).
6. Como chegar e como se locomover.
7. Tabela de Orçamento Estimado por Perfil (Mochileiro, Conforto, Alto Padrão).
8. Dicas "Pulo do Gato" (segredos práticos que fazem a diferença).
9. O que levar na mala (mencionando os itens do kit).
10. Segurança e Saúde (incluindo orientação sobre Seguro Viagem).
11. Perguntas Frequentes (FAQ) com 4 a 5 respostas diretas para dúvidas comuns.
""".strip()

        response = self._create(
            user_prompt=user_prompt,
            system_prompt=self._system_prompt(lang),
            provider=provider,
        )

        raw = response.choices[0].message.content or "{}"
        return self._parse_json(raw)

    def generate_kit(self, topic: str) -> list[dict[str, str]]:
        """Gera 3 itens de kit recomendado para um destino, sem reescrever o artigo."""
        if not self.available:
            return []
        prompt = (
            "Sugira 3 produtos de viagem REAIS e genéricos (sem marca, itens físicos compráveis) "
            "úteis para este tema de post de blog de turismo:\n"
            f"{topic}\n"
            f"Cada um com 'name' (curto), 'note' (8-12 palavras: por que é útil aqui) e "
            f"'query' (termo de busca vago para a Amazon em pt-BR). "
            f'Responda SOMENTE JSON: {{"kit_recommendations": [{{"name":"...","note":"...","query":"..."}}]}}'
        )
        try:
            response = self._create(
                user_prompt=prompt,
                system_prompt="Você é um consultor de compras de viagem. Responda apenas com JSON válido.",
            )
            data = json.loads(response.choices[0].message.content or "{}")
        except Exception:
            return []
        return _clean_kit(data.get("kit_recommendations"))

    def to_evergreen_topics(self, candidates: list[str], count: int = 12) -> list[str]:
        """Converte termos de tendência em temas de viagem evergreen."""
        if not candidates:
            return []
        prompt = (
            "Você é o editor de um blog de turismo brasileiro. A partir destes termos "
            "do Google Trends, crie temas de viagem EVERGREEN (atemporais, úteis por "
            "anos): destinos, roteiros ou atividades. Regras:\n"
            "- Exclua notícias, eventos com data, política, acidentes e preços do momento.\n"
            "- Seja específico (ex.: 'Chapada dos Veadeiros no verão' em vez de 'viagem').\n"
            "- Não repita destinados já óbvios demais; prefira títulos que gerem busca no Google.\n"
            "Termos de tendência:\n"
            + "\n".join(f"- {c}" for c in candidates[:30])
            + f"\n\nRetorne {count} temas em pt-BR apenas como JSON: "
            '{"topics": ["...", "..."]}'
        )
        response = self._create(
            user_prompt=prompt,
            system_prompt="Você é um editor de blog de turismo. Responda apenas com JSON válido.",
        )
        raw = response.choices[0].message.content or "[]"
        return self._parse_string_list(raw)

    def _create(self, user_prompt: str, system_prompt: str, provider: str = "auto") -> Any:
        """Provedor principal (default), reserva forçada ou fallback automático."""
        if provider == "fallback":
            if not self.fallback_available:
                raise ValueError("Provedor reserva (fallback) não configurado")
            return self._try_chat(
                self.fallback_client, self.settings.ai_fallback_model, user_prompt, system_prompt
            )

        try:
            return self._try_chat(self.client, self.settings.ai_model, user_prompt, system_prompt)
        except Exception as first:
            if not self.fallback_available or provider == "primary":
                raise first
            try:
                return self._try_chat(
                    self.fallback_client, self.settings.ai_fallback_model, user_prompt, system_prompt
                )
            except Exception:
                raise first

    def _try_chat(
        self, client: OpenAI, model: str, user_prompt: str, system_prompt: str
    ) -> Any:
        """Chama a IA com até 3 tentativas, aguardando entre falhas (503/limite)."""
        attempts = 3
        delay = 4
        for attempt in range(attempts):
            try:
                try:
                    return client.chat.completions.create(
                        model=model,
                        messages=[
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_prompt},
                        ],
                        temperature=0.7,
                        response_format={"type": "json_object"},
                    )
                except Exception as req_err:
                    err_msg = str(req_err).lower()
                    if "response_format" in err_msg or "json_object" in err_msg or "400" in err_msg:
                        # Fallback para modelos que não suportam o parâmetro response_format
                        return client.chat.completions.create(
                            model=model,
                            messages=[
                                {"role": "system", "content": system_prompt + "\nImportante: responda estritamente em formato JSON válido."},
                                {"role": "user", "content": user_prompt},
                            ],
                            temperature=0.7,
                        )
                    raise
            except Exception:
                if attempt == attempts - 1:
                    raise
                time.sleep(delay * (attempt + 1))

    def _parse_json(self, raw: str) -> dict[str, Any]:
        text = raw.strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
            text = re.sub(r"\s*```$", "", text)
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            match = re.search(r"\{.*\}", text, re.DOTALL)
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
            "kit_recommendations": [],
        }
        defaults.update(data)
        data = defaults

        if not isinstance(data.get("facts"), dict):
            data["facts"] = {}
        data["kit_recommendations"] = _clean_kit(data.get("kit_recommendations"))
        if not data["content"] or len(data["content"]) < 300:
            data["content"] = self._fallback_markdown(data["title"] or "título")
        return data

    @staticmethod
    def _parse_string_list(raw: str) -> list[str]:
        """Extrai uma lista de strings de uma resposta JSON (array ou {"topics": [...]})."""
        text = raw.strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
            text = re.sub(r"\s*```$", "", text)
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            match = re.search(r"\[.*\]", text, re.DOTALL)
            if not match:
                return []
            try:
                data = json.loads(match.group(0))
            except json.JSONDecodeError:
                return []
        if isinstance(data, dict):
            for value in data.values():
                if isinstance(value, list):
                    data = value
                    break
            else:
                return []
        if isinstance(data, list):
            return [str(x).strip() for x in data if str(x).strip()]
        return []

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