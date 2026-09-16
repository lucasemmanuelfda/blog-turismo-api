# Worker Cloudflare — Site do Blog Turismo (SSR)

Este worker serve o blog com **HTML índice-ável** (Google, Bing e agentes como
ChatGPT, Perplexity, Claude etc.). O layout usa **CSS próprio inline** (sem CDN) e
todo o conteúdo é renderizado no servidor, sem depender de JavaScript no cliente.

O que ele faz:

| Rota | Conteúdo |
|---|---|
| `/` | Página inicial com cards dos posts publicados + JSON-LD `Blog` + Open Graph |
| `/post/<slug>/` | Artigo completo renderizado no servidor (HTML puro) + JSON-LD `BlogPosting` + canonical + Open Graph |
| `/tag/<tag>/` | Lista de posts de uma tag |
| `/admin` | Painel admin: login com a senha `ADMIN_KEY`; gera rascunhos, publica, regenera kit/imagens e exclui posts |
| `/robots.txt` | Permite todos os bots (`User-agent: *`) e aponta o `Sitemap` |
| `/sitemap.xml` | Sitemap dinâmico com todos os posts publicados |

O painel em `/admin` troca a senha por um **token de sessão curto** emitido pela
API (`POST /auth/login`, cookie `admin_token` HttpOnly). As ações são
formulários SSR (sem JS): **Gerar artigo**, **Publicar**, **Imagens**,
**Kit** e **Excluir**. Páginas admin são `noindex`.

Acessibilidade: link "pular para o conteúdo", `lang=pt-BR`, landmarks semânticos,
`alt` nas imagens (decorativas com `role="presentation"`), contraste adaptado ao
tema escuro e suporte a `prefers-reduced-motion`.

## Deploy

### CI (automático, recomendado)

O workflow `.github/workflows/deploy-worker.yml` roda em todo push que altere
`worker/**` ou `wrangler.toml` (e pode ser disparado manualmente em **Actions**).
Ele roda `node worker/test-worker.mjs` e publica com o Wrangler.

Para ativar, crie 2 secrets em
**GitHub → Settings → Secrets and variables → Actions**:

| Secret | Valor |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | ID da sua conta (veja no URL do painel `dash.cloudflare.com/<account_id>/...`) |
| `CLOUDFLARE_API_TOKEN` | My Profile → **API Tokens** → template **"Edit Cloudflare Workers"** (scope na sua conta) |

### Local (uma vez)

Na raiz do repositório (`wrangler.toml` aponta para `worker/worker.js`):

```bash
npx wrangler login   # só na primeira vez (abre o navegador)
npx wrangler deploy
```

Independente do método, o resultado são as rotas:

## Testar localmente (Node)

Sem dependências. Na pasta `worker/`:

```bash
node test-worker.mjs
```

O teste usa dados fictícios (não chama a API real).

## Estrutura

```
worker/
├── worker.js         # Código do worker (cole no painel)
├── test-worker.mjs   # Teste local (Node)
└── package.json      # type: module (para o teste)
```

## Pós-publicação (indexação Google)

### Verificação do Search Console

Use **URL prefix** (tipo "Domain" não funciona em `*.workers.dev`). Faça a verificação
pelo método **HTML tag**: o GSC exibe `<meta name="google-site-verification"
content="SEU_TOKEN"/>`; então:

1. Abra `worker/worker.js` e preencha a constante
   `GOOGLE_SITE_VERIFICATION = "SEU_TOKEN";` (no alto do arquivo).
2. Deploy (CI ou Wrangler) — a meta é emitida no `<head>` de todas as páginas.
3. Clique em **Verify** no GSC.

Cada `/google<hex>.html` também é servido automaticamente (método "arquivo HTML"),
caso prefira.

### Após a verificação

1. No GSC → **Sitemaps**, envie `https://<seu-domínio>/sitemap.xml`.
2. Peça o recrawl de `https://<seu-domínio>/robots.txt`.
3. Para aceitar agentes/crawlers: se usar **Cloudflare AI Gateway** ou bloqueio de bots, libere
   `GPTBot`, `ClaudeBot`, `PerplexityBot`, `Google-Extended` (o `User-agent: *` já permite todos).

> Note: as imagens do Wikimedia Commons incluem `utm_source=commons.wikimedia.org`;
> o worker remove a querystring no HTML renderizado.