# Blog Turismo IA

Blog de turismo com geração automática de conteúdo por IA (API + frontend).

## Stack

- Python + FastAPI
- PostgreSQL (Supabase) ou SQLite local
- Qualquer API de IA compatível com OpenAI
- Cloudflare Worker (frontend SSR com SEO/sitemap/robots)

## Rodar localmente

```bash
python -m venv .venv
.\.venv\Scripts\activate        # Windows
pip install -r requirements.txt
python -m uvicorn app.main:app --reload
```

> Sem `DATABASE_URL` usa SQLite local. Copie `.env.example` para `.env`
> e preencha as variáveis (veja o arquivo para detalhes de cada chave).

Acesse `http://127.0.0.1:8000/docs`.

## Testes

```bash
pip install pytest pytest-mock
pytest tests
node worker/test-worker.mjs
```

## Licença

MIT