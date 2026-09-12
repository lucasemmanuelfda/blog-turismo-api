# AGENTS.md

Instruções lidas pelo **opencode** ao trabalhar neste repositório.

Repo público de um blog de turismo com geração de conteúdo por IA.

## Stack e estrutura

- `app/` — API FastAPI (Python). `config.py` lê tudo de `.env` via pydantic-settings.
- `worker/` — Cloudflare Worker (frontend SSR: sitemap, robots, JSON-LD, HTML indexável).
- `.github/workflows/` — daily-generate (cron via API), publish-now e deploy-worker (Wrangler).

## Comandos

```bash
python -m uvicorn app.main:app --reload   # dev, http://127.0.0.1:8000/docs
pytest tests                              # testes da API
node worker/test-worker.mjs               # testes do worker
gh workflow run daily-generate.yml        # publica o dia (gera + agenda posts) sem acompanhar — usar sempre
gh workflow run publish-now.yml           # publica na hora todos os posts agendados pendentes
```

## Segurança (repo público)

- Nunca commitar segredos. Tudo sensível vem de env/CI secrets; nunca colar chaves em código ou README.
- `ADMIN_KEY` vazio + `production` => rotas de escrita fechadas (fail-closed). Sem comparar com `!=` (usar `secrets.compare_digest`).
- Conteúdo de IA tratado como não-confiável: escapar na renderização, `rel="nofollow noopener"` em links externos.

## Memória ("segundo cérebro")

`app/services/memory.py` acumula fatos e títulos já publicados por tema em
`blog-memory.json` e injeta um resumo compacto nos prompts da IA (evita repetição).
Fatos vêm da IA e **não são verificados** — nunca afirmar como verdade querida.