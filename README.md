# Blog Turismo IA — Backend

Backend (API) de um blog de turismo que gera conteúdo automático com IA.
**100% gratuito**: roda de graça, hospeda de graça e ganha domínio de graça.

## Stack

- **Python + FastAPI** (api leve e rápida)
- **PostgreSQL gratuito** via Supabase (sem hóspede, apenas config)
- **IA** via qualquer API compatível com OpenAI (OpenAI, Groq, OpenRouter, DeepSeek…)
- **Agendador** APScheduler para publicar posts automaticamente

## Custos: tudo R$ 0

| Recurso | Serviço grátis | Limite |
|---|---|---|
| Código/API online | Render (Free) | 750h/mês, spin-down em 15min sem uso |
| Banco de dados | Supabase Free | 500 MB, 2 projetos |
| Domínio | `https://SEU-APP.onrender.com` | domínio público de graça |
| Geração de IA | Groq / OpenRouter (modelos free) | 30 req/min (Groq) |
| Imagens | (adicione depois) OpenAI DALL·E / Unsplash | — |

## Estrutura

```
blog-turismo-api/
├── app/
│   ├── main.py          # App FastAPI + rotas + agendador
│   ├── config.py        # Configurações via variáveis de ambiente
│   ├── database.py      # Conexão SQLAlchemy (Postgres ou SQLite local)
│   ├── models.py        # Post e Category
│   ├── schemas.py       # Validação de entrada/saída
│   ├── crud.py          # Operações no banco
│   ├── scheduler.py     # Publicação automática de posts agendados
│   ├── services/
│   │   ├── ai.py        # Geração de artigos de turismo (LLM)
│   │   └── __init__.py  # Helpers de SEO (slug, meta tags)
│   └── routers/
│       ├── posts.py     # CRUD de posts
│       ├── categories.py
│       ├── generate.py  # POST /generate/post (IA)
│       └── deps.py      # Proteção com chave de admin
├── tests/
├── requirements.txt
├── render.yaml          # Blueprint de deploy da Render
└── runtime.txt          # Python 3.12
```

## Como rodar localmente

```bash
cd blog-turismo-api
python -m venv .venv
.\.venv\Scripts\activate          # Windows
pip install -r requirements.txt
python -m uvicorn app.main:app --reload
```

Acesse `http://127.0.0.1:8000/docs` (Swagger). Sem `DATABASE_URL`, ele usa SQLite local (`blog.db`).

Testes:

```bash
pip install pytest pytest-mock
pytest tests
```

## Endpoints

| Método | Rota | Descrição | Auth |
|---|---|---|---|
| GET | `/posts` | Lista posts (filtros: `status`, `category`) | — |
| GET | `/posts/{slug_ou_id}` | Busca post | — |
| POST | `/posts` | Cria post | Bearer |
| PATCH | `/posts/{id}` | Edita post / agenda | Bearer |
| POST | `/posts/{id}/publish` | Publica na hora | Bearer |
| DELETE | `/posts/{id}` | Apaga post | Bearer |
| GET | `/categories` | Lista categorias | — |
| POST | `/categories` | Cria categoria | Bearer |
| POST | `/generate/post` | **Gera artigo de turismo com IA** | Bearer |
| GET | `/health` | Healthcheck | — |

> Auth: cabeçalho `Authorization: Bearer SEU_ADMIN_KEY`. Se `ADMIN_KEY` estiver vazio, as rotas ficam abertas.

### Gerar um artigo

```bash
curl -X POST https://SEU-APP.onrender.com/generate/post \
  -H "Authorization: Bearer SEU_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"topic":"Roteiro de 3 dias em Gramado","category_id":1,"scheduled_at":"2026-09-10T12:00:00"}'
```

O artigo nasce como **draft** (ou **scheduled** se `scheduled_at` for enviado) para você revisar. Publicação agendada é automática.

## Deploy 100% grátis (passo a passo)

### 1. Banco — Supabase

1. Crie conta em [supabase.com](https://supabase.com) (plano Free).
2. `New project` → nome + senha → aguarde alguns minutos.
3. Em `Project Settings → Database → Connection string`.
4. Copie a string do **Pooler (Transaction mode)**, ex.:
   `postgresql://postgres.abcd...:SENHA@aws-0-sa-east-1.pooler.supabase.com:6543/postgres`
   > O tráfego normal (porta 6543/pooler) é a opção grátis.

### 2. IA — escolha um provedor grátis

| Provider | `AI_BASE_URL` | `AI_MODEL` (exemplo) |
|---|---|---|
| [Groq](https://console.groq.com) | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| [OpenRouter](https://openrouter.ai) | `https://openrouter.ai/api/v1` | `meta-llama/llama-3.3-70b-instruct:free` |
| OpenAI (pago, mais qualidade) | `https://api.openai.com/v1` | `gpt-4o-mini` |

Crie uma API key no provedor (Grátis no Groq/OpenRouter) e guarde.

### 3. Código — Render

1. Suba este repositório no GitHub.
2. Em [render.com](https://render.com) → `New` → `Blueprint` → escolha o repositório.
3. O `render.yaml` detecta tudo sozinho (Python 3.12, Free plan, healthcheck).
4. Preencha as variáveis (algumas virão como "resolvido em produção", não as deixe em branco):

| Variável | Valor |
|---|---|
| `ADMIN_KEY` | uma senha sua para proteger a API |
| `DATABASE_URL` | string do Supabase |
| `AI_BASE_URL` | do provedor de IA |
| `AI_API_KEY` | sua key do provedor de IA |
| `AI_MODEL` | modelo escolhido |
| `AI_LANGUAGE` | `pt-BR` |
| `PUBLISH_INTERVAL_MINUTES` | `10` |

5. `Apply` → aguarde o build. Pronto: **`https://SEU-APP.onrender.com`** está no ar de graça.

> Dica: no plano Free da Render o serviço "dorme" após 15 min sem tráfego. Ao acessar ele acorda em ~30s. O agendador de publicação roda enquanto o app está ativo.

### 4. Domínio grátis (opcional)

- Já tem domínio gratuito: `https://SEU-APP.onrender.com`.
- Para um subdomínio amigável **de graça**: crie conta em [eu.org](https://nic.eu.org) e aponte um CNAME para `SEU-APP.onrender.com` (ex.: `blog.viaje.eu.org`).
- Ou use Cloudflare `workers.dev` / uma CNAME de graça na própria Render (`Settings → Custom Domain` — suporta CNAME externo, mas você ainda precisa de um domínio; se não tiver, mantenha o `onrender.com`).

## Variáveis de ambiente

Todas as opções estão em [.env.example](.env.example).

| Variável | Padrão | Descrição |
|---|---|---|
| `ENVIRONMENT` | `development` | `production` ativa o agendador |
| `ADMIN_KEY` | vazio | Chave para rotas de escrita |
| `DATABASE_URL` | SQLite local | Connection string Supabase |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | vazio | Provedor de IA |
| `AI_LANGUAGE` | `pt-BR` | Idioma dos artigos |
| `PUBLISH_INTERVAL_MINUTES` | `10` | Frequência de verificação ao publicar |
| `MAX_POSTS_PER_DAY` | `5` | Limite de artigos/dia |

## Fluxo de publicação automática

1. `POST /generate/post` com `scheduled_at` no futuro → status `scheduled`.
2. O agendador (iniciado em produção) roda a cada `PUBLISH_INTERVAL_MINUTES`.
3. Todo post agendado com data passada vira `published`.
4. `GET /posts?status=published` retorna só o conteúdo no ar.

## Geração diária automática (grátis)

`POST /generate/daily?publish=true` gera até `MAX_POSTS_PER_DAY` artigos para
temas ainda não cobertos (de `DAILY_TOPICS`) e agenda a publicação ao longo do dia.
Para rodar todo dia **sem custo**, use o workflow do GitHub Actions
(`.github/workflows/daily-generate.yml`): crie os secrets `ADMIN_KEY` e a variável
`API_URL` no repositório (`https://SEU-APP.onrender.com`).

> Obs: no Free tier da Render o app "dorme" fora de uso; a publicação agendada
> acontece quando o app acorda. Se preferir sempre no ar, `ENVIRONMENT=production`
> liga o agendador interno de publicação.

## Segundo cérebro (memória em arquivo)

O `blog-memory.json` acumula fatos e títulos já gerados por destino. Nos próximos
prompts a IA recebe **apenas esse resumo compacto** (não os artigos inteiros),
evitando repetição de assunto e gastar tokens reenviando todo o contexto.

## Front-end grátis

`frontend/index.html` é um site estático de página única (sem build) que lista os
posts publicados. Hospede de graça em Cloudflare Pages, Netlify ou Vercel apontando
para essa pasta. Para trocar a API: `?api=https://SEU-APP.onrender.com`.

## Próximos passos sugeridos

- Login/autenticação mais robusta (JWT) e role de escritor.
- Geração de imagem de capa (DALL·E/Stable Diffusion) e upload para Supabase Storage.
- Comentários e newsletter (Supabase/SendGrid free).

## Licença

MIT