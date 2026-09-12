# AGENTS.md

Instruções lidas pelo **opencode** ao trabalhar neste repositório.

Repo público de um blog de turismo com geração de conteúdo por IA.

## Stack e estrutura

- `app/` — API FastAPI (Python). `config.py` lê tudo de `.env` via pydantic-settings.
- `worker/` — Cloudflare Worker (frontend SSR: sitemap, robots, JSON-LD, HTML indexável).
- `.github/workflows/` — `atualizar-blog.yml`: um único workflow faz tudo (gerar artigos + publicar agendados + deploy do worker). Roda à meia-noite (cron) ou manualmente. Não exige push para o worker publicar — rodar manualmente após editar o `worker/`.

## Comandos

```bash
python -m uvicorn app.main:app --reload   # dev, http://127.0.0.1:8000/docs
pytest tests                              # testes da API
node worker/test-worker.mjs               # testes do worker
gh workflow run atualizar-blog.yml        # gera + publica + deploy do worker, sem acompanhar — usar sempre
```

## Segurança (repo público)

- Nunca commitar segredos. Tudo sensível vem de env/CI secrets; nunca colar chaves em código ou README.
- `ADMIN_KEY` vazio + `production` => rotas de escrita fechadas (fail-closed). Sem comparar com `!=` (usar `secrets.compare_digest`).
- Conteúdo de IA tratado como não-confiável: escapar na renderização, `rel="nofollow noopener"` em links externos.

## Memória ("segundo cérebro")

`app/services/memory.py` acumula fatos e títulos já publicados por tema em
`blog-memory.json` e injeta um resumo compacto nos prompts da IA (evita repetição).
Fatos vêm da IA e **não são verificados** — nunca afirmar como verdade querida.