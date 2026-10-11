# Blog Turismo

Blog de turismo de alta performance com geração automatizada de conteúdo por IA (API FastAPI + Frontend SSR em Cloudflare Worker).

## Stack e Arquitetura

- **Backend**: Python 3.12, FastAPI, SQLAlchemy 2, Pydantic v2.
- **Banco de Dados**: PostgreSQL (Supabase) em produção, SQLite ou PostgreSQL (Docker) local.
- **IA Generativa**: Integração com qualquer API compatível com OpenAI (Google Gemini, Groq, OpenRouter).
- **Frontend SSR**: Cloudflare Worker em JavaScript vanilla (renderização sem CDN, SEO completo, JSON-LD, sitemaps dinâmicos, robots e painel admin seguro).
- **Infraestrutura CLI**: Totalmente gerenciável via GitHub CLI (`gh`), Cloudflare Wrangler, Render CLI e Supabase CLI.

---

## Início Rápido

### 1. Configuração Automática (PowerShell)

Para preparar o ambiente virtual, instalar dependências e semear o banco:
```powershell
.\scripts\setup.ps1
```

### 2. Rodar a API em Desenvolvimento

```powershell
.\scripts\dev.ps1
```
Acesse a documentação interativa OpenAPI em: `http://127.0.0.1:8000/docs`.

---

## CLI Unificada de Gerenciamento (`app.cli`)

O projeto inclui uma ferramenta CLI integrada para manutenção, diagnósticos e testes:

```bash
# Diagnóstico completo de conexões (Banco, Wikimedia Commons, IA, NewsAPI)
python -m app.cli test-connections

# Inicializar tabelas, senha de admin e categorias padrão
python -m app.cli seed

# Visualizar estatísticas do blog (posts publicados, agendados, rascunhos, categorias)
python -m app.cli stats

# Publicar posts agendados cuja data já expirou
python -m app.cli publish-due

# Recalcular links de artigos correlacionados
python -m app.cli relink

# Gerar um artigo via IA pelo terminal
python -m app.cli generate "Roteiro de 3 dias em Bonito MS" --category "Ecoturismo"

# Iniciar servidor local
python -m app.cli serve
```

---

## CLIs Conectadas e Operações de Nuvem

O repositório está integrado e autenticado nas seguintes ferramentas de linha de comando:

- **GitHub CLI (`gh`)**:
  ```bash
  gh workflow list
  gh secret list
  ```
- **Cloudflare Wrangler**:
  ```bash
  wrangler whoami
  wrangler deploy
  ```
- **Render CLI**:
  ```bash
  render services
  render deploys list srv-dafj6b9t0dsc73ecdtt0
  ```
- **Supabase CLI**:
  ```bash
  supabase projects list
  supabase status
  ```

---

## Rodar via Docker (Opcional)

Para rodar a API junto com um banco PostgreSQL 16 isolado via container:
```bash
docker compose up -d
```
A API estará disponível na porta `8000` e o banco PostgreSQL na porta `5432`.

---

## Testes Automatizados

Para rodar toda a suíte de testes (Pytest da API + Testes do Cloudflare Worker):
```powershell
.\scripts\test.ps1
```

Ou individualmente:
```bash
# Testes da API (Python)
python -m pytest tests

# Testes do Worker (Node.js)
node worker/test-worker.mjs
```

---

## Licença

MIT