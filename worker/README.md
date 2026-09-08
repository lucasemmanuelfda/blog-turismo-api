# Worker Cloudflare — Site do Blog Turismo IA (SSR)

Este worker serve o blog com **HTML índice-ável** (Google, Bing, e agentes de IA:
ChatGPT, Perplexity, Claude etc.), sem depender de JavaScript no cliente.

O que ele faz:

| Rota | Conteúdo |
|---|---|
| `/` | Página inicial com cards dos posts publicados + JSON-LD `Blog` + Open Graph |
| `/post/<slug>/` | Artigo completo renderizado no servidor (HTML puro) + JSON-LD `BlogPosting` + canonical + Open Graph |
| `/robots.txt` | Permite todos os bots (`User-agent: *`) e aponta o `Sitemap` |
| `/sitemap.xml` | Sitemap dinâmico com todos os posts publicados |

Acessibilidade: link "pular para o conteúdo", `lang=pt-BR`, landmarks semânticos,
`alt` nas imagens (decorativas com `role="presentation"`), contraste adaptado ao
tema escuro e suporte a `prefers-reduced-motion`.

## Substituir no painel da Cloudflare

1. Abra **https://dash.cloudflare.com** → **Workers & Pages**.
2. Clique no Worker que serve o site (cujo domínio é `blog-turismo-api.lucasemmanuel2005.workers.dev`).
3. **Edit code** → apague o conteúdo atual → cole todo o conteúdo de `worker/worker.js`.
4. Confirme que a constante `API_BASE_URL` aponta para a sua API (padrão: `https://blog-turismo-api.onrender.com`).
5. Clique em **Deploy**.

Pronto: `/`, `/sitemap.xml`, `/robots.txt` e `/post/<slug>/` passam a existir.

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

Depois de colar o worker:

1. Acesse **Google Search Console** → adicione seu domínio e envie `https://<seu-domínio>/sitemap.xml`.
2. Peça o recrawl de `https://<seu-domínio>/robots.txt`.
3. Para aceitar IA: se usar **Cloudflare AI Gateway** ou bloquear bots de IA, libere
   `GPTBot`, `ClaudeBot`, `PerplexityBot`, `Google-Extended` (o `User-agent: *` já permite todos).

> Note: as imagens do Wikimedia Commons incluem `utm_source=commons.wikimedia.org`;
> o worker remove a querystring no HTML renderizado.