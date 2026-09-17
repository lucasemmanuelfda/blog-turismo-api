/**
 * Cloudflare Worker — Site do Blog Turismo (Server-Side Rendering)
 *
 * Serve o blog com HTML indexável por crawlers (Google, Bing) e por agentes
 * (ChatGPT / Facebook / etc. via Open Graph + JSON-LD), sem depender de
 * JavaScript para ler o conteúdo.
 * Layout (CSS próprio inline, sem CDN): navbar, cards, dark mode por preferência do sistema.
 *
 * Painel admin em /admin: login com a senha ADMIN_KEY (trocada por token curto na API),
 * gerar artigos, publicar, regenerar kit/imagens e excluir.
 *
 * Deploy: `wrangler deploy` (ou via GitHub Actions em .github/workflows/atualizar-blog.yml).
 */

const API_BASE_URL = "https://blog-turismo-api.onrender.com";

// Sessão do painel admin: nome do cookie + prefixo de rota das ações
const ADMIN_COOKIE = "admin_token";
const ADMIN_ROOT = "/admin";

const DEFAULT_TITLE = "Blog Turismo";
const DEFAULT_DESC =
  "Destinos, roteiros e dicas de viagem atualizados todos os dias.";

// Páginas públicas podem ser cacheadas por 5 min (Cloudflare + navegador).
// Conteúdo muda 1x/dia; cache curto reduz o custo de repetição sem estagnar.
const PUB_CACHE = { "Cache-Control": "public, max-age=300, s-maxage=300" };
const POST_CACHE = { "Cache-Control": "public, max-age=3600, s-maxage=3600" };

// ---------- Utilitários ----------

// Headers de segurança aplicados em todas as respostas.
// Scripts de terceiros entram por lista explícita: cada um abaixo abre só o
// próprio domínio no CSP (script-src/connect-src), nada de 'unsafe-inline'.

// Cloudflare Web Analytics (sem cookies). Preencha o token do painel para ativar.
const CF_BEACON_TOKEN = "";

// Travelpayouts Drive: monetiza links automaticamente. Cole a URL do seu painel;
// vazio desliga o script.
const DRIVE_SRC = "https://emrld.ltd/NTc0Nzcw.js?t=574770";

const cspList = (extra) => ["'self'", ...extra.filter(Boolean)].join(" ");
const CSP = `default-src 'self'; img-src * data:; media-src *; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests; script-src ${cspList([
  CF_BEACON_TOKEN && "https://static.cloudflareinsights.com",
  DRIVE_SRC && "https://emrld.ltd",
])}; connect-src ${cspList([
  CF_BEACON_TOKEN && "https://cloudflareinsights.com",
  DRIVE_SRC && "https://emrld.ltd",
])}`;

const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function secured(extra = {}) {
  return { ...SECURITY_HEADERS, ...extra };
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Google só aceita lastmod em YYYY-MM-DD (ou datetime W3C com fuso).
// A API devolve "2026-09-08T00:36:38.597165" (sem fuso); normalizamos para a data.
function sitemapDate(s) {
  if (!s) return "";
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

// Origin fixa de referência para construir URLs absolutas de schema.org (canonical / og:url).
const SITE_ORIGIN = "https://blog-turismo-api.lucasemmanuel2005.workers.dev";

// Favicon SVG (logo: gradiente da marca + montanha e sol)
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f7490"/><stop offset="1" stop-color="#7012c2"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><circle cx="45" cy="19" r="6" fill="#fff" opacity=".95"/><path d="M9 46l15-22 8 11 7-9 16 20z" fill="#fff"/></svg>`;

// Verificação do Google Search Console.
// Método do arquivo: o Worker serve /google<hex>.html com "google-site-verification: <arquivo>".
// Também emite a meta tag <meta name="google-site-verification"> quando o token é definido aqui.
const GOOGLE_SITE_VERIFICATION = "5r8Ci2K7Dr-x1L1pogJ4qXrXxTQHxzURb2w9djRXs0o";

// Remove 'utm_*' e outros parâmetros de rastreio das imagens (Wikimedia injeta utm_source).
function cleanImageUrl(u) {
  if (!u) return "";
  try {
    const nu = new URL(u);
    return nu.origin + nu.pathname; // descarta query string
  } catch {
    return u;
  }
}

// Largura de thumbnail do Wikimedia. 960px é um tamanho pré-renderizado padrão dos
// arquivos da Commons (pedir 640/800 arbitrários devolve 400), ~40% menor que o 1280px.
const THUMB_W = 960;

// Rebaixa thumbs do Wikimedia de qualquer largura para THUMB_W mantendo formato e host.
function thumb(u) {
  const s = String(u || "");
  return /^https:\/\/(?:upload|thumb)\.wikimedia\.org\/wikipedia\/commons\/thumb\//.test(s)
    ? s.replace(/\d+px-([^/]+)$/, `${THUMB_W}px-$1`)
    : s;
}

// ---------- Markdown → HTML (SSR, sem JS) ----------

function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function mdToHtml(md, toc) {
  if (!md) return "";
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  const usedIds = new Set();
  let i = 0;

  const inlineSafe = (s) =>
    esc(s)
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, ($0, alt, src) => {
        return `<img src="${esc(thumb(cleanImageUrl(src)))}" alt="${esc(alt || "foto")}" loading="lazy" decoding="async" />`;
      })
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, t, href) => `<a href="${esc(href)}" rel="nofollow noopener">${esc(t)}</a>`);

  while (i < lines.length) {
    const l = lines[i];
    const img = l.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (img) {
      out.push(`<figure class="img"><img src="${esc(thumb(cleanImageUrl(img[2])))}" alt="${esc(img[1] || "foto")}" loading="lazy" decoding="async" /></figure>`);
      i++;
      continue;
    }
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      const text = inlineSafe(h[2]);
      if (lvl === 2 && toc) {
        let id = slugify(h[2]);
        if (usedIds.has(id)) {
          let n = 2;
          while (usedIds.has(`${id}-${n}`)) n++;
          id = `${id}-${n}`;
        }
        usedIds.add(id);
        toc.push({ id, text: h[2].replace(/[*_]/g, "") });
        out.push(`<h2 id="${esc(id)}">${text}</h2>`);
      } else {
        out.push(`<h${lvl}>${text}</h${lvl}>`);
      }
      i++;
      continue;
    }
    // Lista não ordenada
    if (/^\s*[-*]\s+/.test(l)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inlineSafe(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    // Lista ordenada
    if (/^\s*\d+[.)]\s+/.test(l)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(`<li>${inlineSafe(lines[i].replace(/^\s*\d+[.)]\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    if (l.trim() === "") {
      i++;
      continue;
    }
    // Parágrafo (aplica markdown bastando: ** * [links] [img] )
    out.push(`<p>${inlineSafe(l)}</p>`);
    i++;
  }
  return out.join("\n");
}

// ---------- Layout (CSS inline, sem dependência de CDN) ----------

function publicNav() {
  return `<nav class="navbar navbar-dark blognav sticky-top py-3" aria-label="Navegação principal">
  <div class="container d-flex flex-wrap align-items-center justify-content-between gap-2">
    <a class="navbar-brand fw-bold" href="/">Blog Turismo</a>
    <span class="navbar-text small opacity-75">Destinos, roteiros e dicas de viagem.</span>
  </div>
</nav>`;
}

function adminNav() {
  return `<nav class="navbar navbar-dark blognav sticky-top py-3" aria-label="Navegação do painel">
  <div class="container d-flex flex-wrap align-items-center justify-content-between gap-2">
    <a class="navbar-brand fw-bold" href="${ADMIN_ROOT}">Blog Turismo <span class="badge text-bg-warning align-middle">admin</span></a>
    <form class="d-flex mb-0" method="post" action="${ADMIN_ROOT}/logout">
      <button class="btn btn-sm btn-outline-light" type="submit">Sair</button>
    </form>
  </div>
</nav>`;
}

function page(t) {
  const ogImage = t.image || (t.post && t.post.cover_image ? thumb(cleanImageUrl(t.post.cover_image)) : "");
  const preload = ogImage ? `<link rel="preload" as="image" fetchpriority="high" href="${esc(ogImage)}">` : "";
  const canonical = t.canonical || (t.admin ? t.origin + ADMIN_ROOT : t.origin + "/");
  const robots = t.robots || "index, follow";
  const gscMeta = GOOGLE_SITE_VERIFICATION
    ? `<meta name="google-site-verification" content="${esc(GOOGLE_SITE_VERIFICATION)}">`
    : "";
  const nav = t.admin ? adminNav() : publicNav();
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0f7490">
<meta name="robots" content="${robots}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="shortcut icon" href="/favicon.svg">
${gscMeta}
<title>${esc(t.title)}</title>
<meta name="description" content="${esc(t.desc)}">
<link rel="canonical" href="${esc(canonical)}">
${preload}
<meta property="og:type" content="${t.type}">
<meta property="og:site_name" content="Blog Turismo">
<meta property="og:title" content="${esc(t.ogTitle || t.title)}">
<meta property="og:description" content="${esc(t.desc)}">
<meta property="og:url" content="${esc(canonical)}">
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(ogImage)}">` : `<meta name="twitter:card" content="summary">`}
${t.jsonld ? `<script type="application/ld+json">${t.jsonld}</script>` : ""}
<style>
:root {
  color-scheme: light dark;
  --brand-1:#0e7490;
  --brand-2:#6d28d9;
  --bs-body-bg:#f6f3ee;
  --bs-body-color:#20262e;
  --bs-body-font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --bs-body-font-size:1.05rem;
  --bs-body-line-height:1.7;
  --bs-link-color:#0e7490;
  --bs-link-hover-color:#0b5970;
  --bs-link-decoration:none;
  --bs-border-radius:.9rem;
  --bs-border-radius-lg:1.25rem;
  --bs-card-bg:#fff;
  --bs-card-border-color:#e7e3dc;
  --bs-card-border-radius:1.25rem;
  --bs-secondary-color:#5c6874;
  --bs-tertiary-bg:#efece5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bs-body-bg:#10151c;
    --bs-body-color:#e4ebf2;
    --bs-link-color:#53b6d4;
    --bs-link-hover-color:#7bcbe4;
    --bs-card-bg:#182029;
    --bs-card-border-color:#2b3540;
    --bs-secondary-color:#93a0ae;
    --bs-tertiary-bg:#151c24;
  }
}
/* ---------- Base: substitui o bootstrap.min.css do CDN (só o que o site usa) ---------- */
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bs-body-bg);color:var(--bs-body-color);font-family:var(--bs-body-font-family);font-size:var(--bs-body-font-size);line-height:var(--bs-body-line-height)}
a{color:var(--bs-link-color)}
a:hover{color:var(--bs-link-hover-color)}
h1,h2,h3,h4,h5,h6{font-weight:700;line-height:1.32;margin:0 0 .5rem}
p{margin:0 0 1rem}
ul,ol{padding-left:1.5em;margin:0 0 1rem}
.container{width:100%;max-width:1140px;margin-inline:auto;padding-inline:1rem}
.row{display:flex;flex-wrap:wrap;gap:1.5rem}
.row.g-0{gap:0}.row.g-2{gap:.5rem}.row.g-3{gap:1rem}.row.g-4{gap:1.5rem}
.row>*{width:100%;max-width:100%}
.col{flex:1 1 0%}.col-auto{flex:0 0 auto}
@media (min-width:768px){.col-md-6{flex:0 0 calc(50% - .75rem)}.col-md-4{flex:0 0 calc(33.333% - 1rem)}.p-md-5{padding:3rem!important}.row.g-0 .col-md-6{flex:0 0 50%}}
@media (min-width:992px){.row.g-0 .col-lg-4{flex:0 0 33.333%}.col-lg-3{flex:0 0 calc(25% - 1.125rem)}.col-lg-4{flex:0 0 calc(33.333% - 1rem)}.col-lg-9{flex:0 0 calc(75% - .375rem)}.col-lg-12{flex:0 0 100%}}
.navbar{display:flex;align-items:center;padding-block:.75rem}
.navbar-dark .navbar-brand,.navbar-dark .navbar-nav .nav-link{color:#fff}
.navbar-brand{font-weight:700;text-decoration:none}
.navbar-text{color:rgba(255,255,255,.78)}
.btn{display:inline-block;padding:.5rem 1rem;border:1px solid transparent;border-radius:.55rem;background:transparent;cursor:pointer;font:inherit;line-height:1.5;text-decoration:none;text-align:center}
.btn-primary{background:var(--brand-1);color:#fff}.btn-primary:hover{background:#0b5970}
.btn-dark{background:#20262e;color:#fff}.btn-dark:hover{background:#10151c}
.btn-outline-primary{color:var(--brand-1);border-color:var(--brand-1)}.btn-outline-primary:hover{background:var(--brand-1);color:#fff}
.btn-outline-secondary{color:var(--bs-secondary-color);border-color:var(--bs-secondary-color)}.btn-outline-secondary:hover{background:var(--bs-secondary-color);color:#fff}
.btn-outline-danger{color:#dc3545;border-color:#dc3545}.btn-outline-danger:hover{background:#dc3545;color:#fff}
.btn-outline-light{color:#fff;border-color:rgba(255,255,255,.6)}.btn-outline-light:hover{background:rgba(255,255,255,.18);color:#fff}
.btn-sm{padding:.3rem .6rem;font-size:.875em}
.badge{display:inline-block;padding:.42em .68em;font-size:.76em;font-weight:600;line-height:1;white-space:nowrap;border-radius:.5em}
.rounded-pill{border-radius:50rem}
.text-bg-primary{background:var(--brand-1);color:#fff}
.text-bg-secondary{background:var(--bs-secondary-color);color:#fff}
.text-bg-success{background:#198754;color:#fff}
.text-bg-warning,.text-bg-warning a{background:#ffc107;color:#20262e}
.text-bg-danger{background:#dc3545;color:#fff}
.card{background:var(--bs-card-bg);border:1px solid var(--bs-card-border-color);border-radius:var(--bs-card-border-radius);display:flex;flex-direction:column}
.border-0{border:0!important}
.shadow-sm{box-shadow:0 .125rem .5rem rgba(24,32,40,.12)}
.card-body{padding:1rem;flex:1 1 auto}
.card-title{margin-bottom:.5rem;font-weight:600;line-height:1.35}
.card-header{padding:1rem;border-bottom:1px solid var(--bs-card-border-color)}
.card-text{margin:0}
.breadcrumb{display:flex;flex-wrap:wrap;list-style:none;padding:0;margin:0 0 1.25rem;gap:.5rem}
.breadcrumb-item a{color:inherit;text-decoration:none}
.breadcrumb-item.active{color:var(--bs-secondary-color)}
.breadcrumb-item+.breadcrumb-item::before{content:"/";margin-right:.5rem;color:var(--bs-secondary-color)}
.form-label{display:block;margin:0 0 .5rem}
.form-control{display:block;width:100%;padding:.5rem .75rem;border:1px solid var(--bs-card-border-color);border-radius:.55rem;background:var(--bs-card-bg);color:inherit;font:inherit}
.form-control:focus{outline:2px solid var(--brand-1);outline-offset:1px;border-color:transparent}
.alert{padding:1rem;border-radius:.8rem;border:1px solid transparent;margin:0 0 1rem}
.alert-danger{color:#842029;background:#f8d7da;border-color:#f5c2c7}
.alert-success{color:#0f5132;background:#d1e7dd;border-color:#badbcc}
.list-group{display:flex;flex-direction:column;list-style:none;padding:0;margin:0;background:var(--bs-card-bg);border:1px solid var(--bs-card-border-color);border-radius:var(--bs-card-border-radius);overflow:hidden}
.list-group-item{padding:.75rem 1rem;border-bottom:1px solid var(--bs-card-border-color)}
.list-group-item:last-child{border-bottom:0}
.ratio{position:relative;width:100%;overflow:hidden;background:var(--bs-secondary-color)}
.ratio-16x9::before{content:"";display:block;padding-top:56.25%}
.ratio>*{position:absolute;inset:0}
.list-unstyled{list-style:none;padding-left:0}
.d-grid{display:grid}
/* ---------- Utilidades ---------- */
.d-flex{display:flex}.d-block{display:block}.flex-wrap{flex-wrap:wrap}.flex-column{flex-direction:column}.flex-grow-1{flex-grow:1}
.justify-content-between{justify-content:space-between}.justify-content-center{justify-content:center}
.align-items-center{align-items:center}.align-self-start{align-self:flex-start}
.gap-2{gap:.5rem}.gap-3{gap:1rem}
.p-3{padding:1rem}.p-4{padding:1.5rem}.p-5{padding:3rem}.py-3{padding-block:1rem}.py-4{padding-block:1.5rem}.px-3{padding-inline:1rem}
.mb-0{margin-bottom:0}.mb-1{margin-bottom:.25rem}.mb-2{margin-bottom:.5rem}.mb-3{margin-bottom:1rem}.mb-4{margin-bottom:1.5rem}.mb-5{margin-bottom:3rem}.mt-2{margin-top:.5rem}.mt-5{margin-top:3rem}
.mx-auto{margin-inline:auto}.me-auto{margin-inline-end:auto}
.text-center{text-align:center}.text-uppercase{text-transform:uppercase}.text-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.text-body-secondary{color:var(--bs-secondary-color)}
.link-body-emphasis{color:inherit;text-decoration:none}
.link-secondary{color:var(--bs-secondary-color)}
.text-decoration-none{text-decoration:none}
.fw-bold{font-weight:700}.fw-semibold{font-weight:600}.fs-4{font-size:1.5rem}
.h1{font-size:2.4rem}.h2{font-size:2rem}.h3{font-size:1.75rem}.h4{font-size:1.5rem}.h5{font-size:1.25rem}.h6{font-size:1rem}
.small{font-size:.875em}.opacity-75{opacity:.75}
.h-100{height:100%}.w-100{width:100%}.min-vh-100{min-height:100vh}.overflow-hidden{overflow:hidden}.object-fit-cover{object-fit:cover}
.sticky-top{position:sticky;top:0;z-index:1020}.align-middle{vertical-align:middle}
.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.visually-hidden-focusable:not(:focus):not(:focus-within){position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
/* ---------- Customizações do site ---------- */
.blognav { background:linear-gradient(140deg,#0f7490,#54139b 80%); }
.progress { position:fixed; top:0; left:0; width:100%; height:3px; transform:scaleX(0); transform-origin:0 50%;
  background:linear-gradient(90deg,#0e7490,#6d28d9); z-index:1050; pointer-events:none; }
@supports (animation-timeline: scroll()) {
  .progress { animation:progress-grow linear; animation-timeline:scroll(root); }
}
@keyframes progress-grow { to { transform:scaleX(1); } }
.hero .cover-img { min-height:300px; }
.post-card { height:100%; transition:transform .18s ease, box-shadow .18s ease; }
.post-card:hover { transform:translateY(-3px); box-shadow:0 14px 30px -14px rgba(24,32,40,.28)!important; }
.cover-img { display:block; width:100%; aspect-ratio:16/9; object-fit:cover; background:var(--bs-secondary-color,#ddd); }
.post-hero-card .card-body { font-size:1.05rem; }
.toc-sticky { position:sticky; top:88px; }
.content { font-size:1.05rem; line-height:1.78; }
.content h1, .content h2, .content h3 { line-height:1.32; margin:1.7em 0 .55em; letter-spacing:-.2px; }
.content p { margin:.85em 0; }
.content img { width:100%; aspect-ratio:16/9; object-fit:cover; border-radius:14px; display:block; background:var(--bs-secondary-color,#ddd); }
.content figure.img { margin:1.6em 0; }
.content ul, .content ol { padding-left:1.3em; margin:.85em 0; }
code { white-space:pre-wrap; background:rgba(14,116,144,.1); padding:.15em .4em; border-radius:6px; font-size:.9em; }
.sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
</style>
${!t.admin && DRIVE_SRC ? `<script async data-cmp-ab="2" src="${esc(DRIVE_SRC)}"></script>` : ""}
${!t.admin && CF_BEACON_TOKEN ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon="${esc(JSON.stringify({ token: CF_BEACON_TOKEN }))}"></script>` : ""}
</head>
<body class="d-flex flex-column min-vh-100">
<a class="visually-hidden-focusable" href="#principal">Pular para o conteúdo principal</a>
<div class="progress" aria-hidden="true"></div>
${nav}
<main id="principal" class="container py-4 flex-grow-1">
${t.body}
</main>
<footer class="footer text-center text-body-secondary small py-4 px-3">
  <a class="link-body-emphasis" href="/">Blog Turismo</a> · <a class="link-secondary" href="/sobre">Sobre</a> · <a class="link-secondary" href="/privacidade">Privacidade</a> · Conteúdo informativo gerado automaticamente todos os dias · <a class="link-secondary" href="${ADMIN_ROOT}">Painel</a>
</footer>
</body>
</html>`;
}

// ---------- JSON-LD ----------

function blogJsonLd() {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Blog",
    name: "Blog Turismo",
    description: DEFAULT_DESC,
    inLanguage: "pt-BR",
  });
}

function postJsonLd(a) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: a.title,
    description: a.summary || a.meta_description,
    image: a.cover_image ? cleanImageUrl(a.cover_image) : undefined,
    datePublished: a.published_at,
    dateModified: a.updated_at || a.published_at,
    inLanguage: "pt-BR",
    keywords: (a.tags || []).map((tag) => String(tag).trim()).filter(Boolean).join(", ") || undefined,
    mainEntityOfPage: { "@type": "WebPage", "@id": `${SITE_ORIGIN}/post/${a.slug}/` },
    author: { "@type": "Organization", name: "Blog Turismo" },
    publisher: { "@type": "Organization", name: "Blog Turismo" },
  });
}

// ---------- Acesso à API ----------

async function fetchPosts(limit = 30) {
  const u = `${API_BASE_URL}/posts?status=published&limit=${limit}`;
  const res = await fetch(u, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("API " + res.status);
  return res.json();
}

async function fetchPost(slug) {
  const u = `${API_BASE_URL}/posts/${encodeURIComponent(slug)}`;
  const res = await fetch(u, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  return res.json();
}

async function apiCall(path, { method = "GET", token, body } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(API_BASE_URL + path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

// ---------- Sessão admin (cookie HttpOnly à prova das rotas /admin) ----------

function readCookie(request, name) {
  const header = request.headers && typeof request.headers.get === "function"
    ? request.headers.get("Cookie")
    : "";
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) {
      const value = part.slice(i + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

function tokenExpired(token) {
  const i = token.indexOf(".");
  if (i <= 0) return true;
  const exp = Number(token.slice(0, i));
  return !Number.isFinite(exp) || exp * 1000 < Date.now();
}

function adminRedirect(location, setCookie) {
  const headers = { Location: location };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  return new Response(null, { status: 302, headers });
}

function adminSessionCookie(token, maxAge) {
  return `admin_token=${encodeURIComponent(token)}; Path=${ADMIN_ROOT}; HttpOnly; SameSite=Lax; Secure; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
}

function clearAdminCookie() {
  return `admin_token=; Path=${ADMIN_ROOT}; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}

async function adminPosts(status, token) {
  try {
    const res = await apiCall(`/posts?status=${status}&limit=50`, { token });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// ---------- Site público ----------

function slugTag(t) {
  return encodeURIComponent(String(t).toLowerCase().replace(/\s+/g, "-"));
}

function cardsHtml(posts) {
  return posts.map((p) => {
    const img = p.cover_image
      ? `<a class="d-block ratio ratio-16x9" href="/post/${esc(p.slug)}/" tabindex="-1" aria-hidden="true"><img class="cover-img object-fit-cover w-100" loading="lazy" src="${esc(thumb(cleanImageUrl(p.cover_image)))}" alt="" role="presentation" /></a>`
      : "";
    const tag = (p.tags && p.tags[0])
      ? `<a class="badge rounded-pill text-bg-secondary text-decoration-none" href="/tag/${esc(slugTag(p.tags[0]))}/">${esc(p.tags[0])}</a>`
      : "";
    const date = p.published_at ? `<time datetime="${esc(p.published_at)}">${new Date(p.published_at).toLocaleDateString("pt-BR")}</time>` : "";
    return `<article class="col-md-6 col-lg-4">
      <div class="card post-card h-100 border-0 shadow-sm">
        ${img}
        <div class="card-body d-flex flex-column">
          <div class="d-flex flex-wrap align-items-center gap-2 small text-body-secondary mb-2">${tag ? `<span>${tag}</span>` : ""}${date ? `<span>${date}</span>` : ""}</div>
          <h2 class="h5 card-title mb-2"><a class="text-decoration-none link-body-emphasis" href="/post/${esc(p.slug)}/">${esc(p.title)}</a></h2>
          <p class="card-text text-body-secondary flex-grow-1 small">${esc(p.summary || "")}</p>
          <a class="btn btn-sm btn-outline-primary align-self-start mt-2" href="/post/${esc(p.slug)}/">Ler artigo completo →</a>
        </div>
      </div>
    </article>`;
  }).join("") || `<div class="col-12"><p class="text-body-secondary mb-0">Nenhum artigo publicado ainda.</p></div>`;
}

function heroHtml(p) {
  return `<article class="card hero border-0 shadow-sm mb-5 overflow-hidden">
  <div class="row g-0">
    <div class="col-md-6">
      <a class="d-block h-100" href="/post/${esc(p.slug)}/" tabindex="-1" aria-hidden="true"><img class="cover-img object-fit-cover w-100 h-100" loading="eager" fetchpriority="high" src="${esc(thumb(cleanImageUrl(p.cover_image)))}" alt="" role="presentation" /></a>
    </div>
    <div class="col-md-6 d-flex flex-column justify-content-center p-4 p-md-5">
      <span class="badge rounded-pill text-bg-primary align-self-start mb-3">${esc((p.tags && p.tags[0]) || "Turismo")}</span>
      <h2 class="card-title h1 mb-3"><a class="text-decoration-none link-body-emphasis" href="/post/${esc(p.slug)}/">${esc(p.title)}</a></h2>
      <p class="card-text text-body-secondary mb-4">${esc(p.summary || "")}</p>
      <a class="btn btn-dark align-self-start" href="/post/${esc(p.slug)}/">Ler artigo completo</a>
    </div>
  </div>
</article>`;
}

async function home(request, origin) {
  let posts = [];
  try {
    posts = await fetchPosts(15);
  } catch (e) {
    // Fallback: ainda renderiza a página mas com aviso
  }
  let hero = "";
  let grid = posts;
  let heroImage = "";
  if (posts[0] && posts[0].cover_image) {
    heroImage = thumb(cleanImageUrl(posts[0].cover_image));
    hero = heroHtml(posts[0]);
    grid = posts.slice(1);
  }
  const body = `<h1 class="visually-hidden">Últimos artigos</h1>
${hero}
<div class="d-flex align-items-center mb-3">
  <h2 class="h6 text-uppercase text-body-secondary mb-0">Artigos recentes</h2>
</div>
<div class="row g-4 post-grid">${cardsHtml(grid)}</div>`;
  return new Response(
    page({
      type: "website",
      title: DEFAULT_TITLE,
      desc: DEFAULT_DESC,
      canonical: origin + "/",
      origin,
      image: heroImage,
      body,
      jsonld: blogJsonLd(),
    }),
    { headers: secured({ "Content-Type": "text/html; charset=utf-8", ...PUB_CACHE }) }
  );
}

const AMAZON_TAG = "blogturismo20-20";

// Afiliados de viagem. Deixe vazio para ocultar o bloco. Exportado para os testes
// injetarem IDs temporários (em produção, preencha aqui e faça o deploy).
export const TRAVEL_AFFILIATES = { travelpayouts: "", booking: "" };

// E-mail público de contato (LGPD / dúvidas). Preencha para exibir o link.
const CONTACT_EMAIL = "";

function contactLine() {
  return CONTACT_EMAIL
    ? `Para falar com a gente, escreva para <a href="mailto:${esc(CONTACT_EMAIL)}">${esc(CONTACT_EMAIL)}</a>.`
    : "O canal de contato será publicado em breve nesta página.";
}

function legalPage(origin, path, title, desc, body) {
  return new Response(
    page({
      type: "website",
      title,
      desc,
      canonical: origin + path,
      origin,
      body,
    }),
    { headers: secured({ "Content-Type": "text/html; charset=utf-8", ...POST_CACHE }) }
  );
}

function sobrePage(origin) {
  const body = `<h1>Sobre o Blog Turismo</h1>
<p>O <strong>Blog Turismo</strong> publica todos os dias roteiros, dicas e guias de destinos para quem gosta de viajar — com foco em lugares do Brasil e do mundo que valem a viagem.</p>
<p>Os textos são produzidos com apoio de ferramentas automatizadas de escrita e organizados por <strong>Lucas</strong>, que mantém o projeto, cuida dos temas e revisa o que vai ao ar. Nosso objetivo é informar de forma direta e útil, sem enrolação.</p>
<p>Quando indicamos produtos ou serviços, deixamos claro: alguns links são de afiliado e podem gerar uma pequena comissão para o blog, sem custo extra para você.</p>
<h2>Como o conteúdo é organizado</h2>
<p>Cada artigo traz um roteiro ou destino com dicas práticas de quando ir, o que fazer e o que levar. A frequência de publicação é diária.</p>`;
  return legalPage(origin, "/sobre", `Sobre — ${DEFAULT_TITLE}`, "Quem faz o Blog Turismo e como o conteúdo é produzido.", body);
}

function privacidadePage(origin) {
  const body = `<h1>Política de Privacidade</h1>
<p>Esta política explica como o Blog Turismo trata informações dos visitantes, em linha com a Lei Geral de Proteção de Dados (LGPD).</p>
<h2>Cookies</h2>
<p>Este site não usa cookies próprios de rastreamento nem de publicidade, e não identifica visitantes. O único cookie nosso é de sessão do painel administrativo (restrito à equipe).</p>
<p>Para monetizar os links de parceiros (abaixo), carregamos um script da Travelpayouts que marca o link de afiliado. Ao clicar num link de parceiro, o site de destino pode gravar cookies próprios de atribuição, conforme as políticas dele.</p>
<h2>Análises</h2>
<p>Podemos usar estatísticas de acesso agregadas e sem cookies para entender quais conteúdos são úteis. Esses dados não identificam você individualmente.</p>
<h2>Links de afiliado</h2>
<p>Alguns links levam a lojas e serviços parceiros (como Amazon, Booking.com e Aviasales). Ao comprar ou reservar por eles, o blog pode receber uma comissão <strong>sem nenhum custo adicional para você</strong>. O preço e as condições são os mesmos.</p>
<h2>Seus direitos (LGPD)</h2>
<p>Como não coletamos dados pessoais de visitantes, normalmente não há dados a excluir. Ainda assim, você pode solicitar informações. ${contactLine()}</p>
<p>Última atualização: ${new Date().toISOString().slice(0, 10)}.</p>`;
  return legalPage(origin, "/privacidade", `Privacidade — ${DEFAULT_TITLE}`, "Como o Blog Turismo trata cookies, análises e links de afiliado.", body);
}

const KIT_ITEMS = [
  ["Sapatilha aquática de neoprene", "ideal para flutuação e trilhas com água", "sapato aquático neoprene"],
  ["Mochila de trilha", "leve e resistente para os passeios do dia", "mochila de trilha leve"],
  ["Capinha à prova d'água para celular", "fotos sem risco nas lagoas e cachoeiras", "capa celular à prova d'água"],
];

function amazonSearchLink(query) {
  return `https://www.amazon.com.br/s?k=${encodeURIComponent(query)}&tag=${AMAZON_TAG}`;
}

function kitHtml(post) {
  const aiKit = Array.isArray(post?.kit_recommendations) ? post.kit_recommendations : [];
  const kit = aiKit.length
    ? aiKit
    : KIT_ITEMS.map(([name, note, query]) => ({ name, note, query }));
  const items = kit
    .map((item, i) => {
      const url = amazonSearchLink(item.query || item.name);
      return `<div class="col-md-4">
      <div class="card h-100 border-0 shadow-sm">
        <div class="card-body">
          <span class="badge rounded-pill text-bg-primary mb-2" aria-hidden="true">${i + 1}</span>
          <h3 class="h6 mb-2"><a class="text-decoration-none link-body-emphasis" rel="sponsored nofollow noopener" href="${url}">${esc(item.name)}</a></h3>
          ${item.note ? `<p class="small text-body-secondary mb-3">${esc(item.note)}</p>` : ""}
          <a class="btn btn-sm btn-outline-primary" rel="sponsored nofollow noopener" href="${url}">Ver na Amazon</a>
        </div>
      </div>
    </div>`;
    })
    .join("");
  return `<section class="kit mt-5" aria-label="Kit recomendado para essa viagem">
  <h2 class="h4 mb-1">Kit recomendado para essa viagem</h2>
  <p class="text-body-secondary small mb-3">Alguns links desta página são de afiliado da Amazon. Se você comprar por eles, o blog ganha uma pequena comissão sem custo extra para você.</p>
  <div class="row g-3">${items}</div>
</section>`;
}

function travelHtml(post, travelMarker) {
  const marker = String(travelMarker || "").trim() || TRAVEL_AFFILIATES.travelpayouts;
  const booking = TRAVEL_AFFILIATES.booking;
  if (!marker && !booking) return "";
  const dest = ((post.tags || [])[0] || post.title || "").trim();
  const q = encodeURIComponent(dest);
  const sub = encodeURIComponent(post.slug || "");
  const links = [];
  if (marker) {
    links.push(`<a class="btn btn-outline-primary" rel="sponsored nofollow noopener" href="https://www.aviasales.com/?marker=${encodeURIComponent(marker)}&subid=${sub}">Buscar voos para ${esc(dest)}</a>`);
  }
  if (booking) {
    links.push(`<a class="btn btn-outline-primary" rel="sponsored nofollow noopener" href="https://www.booking.com/searchresults.html?aid=${encodeURIComponent(booking)}&ss=${q}">Ver hotéis em ${esc(dest)}</a>`);
  }
  return `<section class="kit mt-5" aria-label="Planeje a viagem">
  <h2 class="h4 mb-1">Planeje a viagem</h2>
  <p class="text-body-secondary small mb-3">Links de parceiros. Reservando por eles, o blog ganha uma pequena comissão sem custo extra para você.</p>
  <div class="d-flex flex-wrap gap-2">${links.join("")}</div>
</section>`;
}

async function postPage(request, origin, slug, travelMarker) {
  const post = await fetchPost(slug);
  if (!post) {
    return new Response("Artigo não encontrado", {
      status: 404,
      statusText: "Not Found",
      headers: secured({ "Content-Type": "text/plain; charset=utf-8" }),
    });
  }
  const title = post.meta_title || post.title || DEFAULT_TITLE;
  const desc = post.meta_description || post.summary || DEFAULT_DESC;
  const ogTitle = post.title;
  const canonical = `${origin}/post/${esc(post.slug)}/`;
  const date = post.published_at ? `<time datetime="${esc(post.published_at)}">${new Date(post.published_at).toLocaleDateString("pt-BR")}</time>` : "";
  const readTime = post.content
    ? Math.max(1, Math.round(post.content.split(/\s+/).length / 200))
    : null;
  const tags = (post.tags || []).map((tag) => {
    const t = String(tag).trim();
    return `<a class="badge rounded-pill text-bg-secondary text-decoration-none" href="/tag/${esc(slugTag(t))}/">${esc(t)}</a>`;
  }).join("");
  const toc = [];
  const content = mdToHtml(post.content, toc);
  const tocHtml = toc.length >= 2
    ? `<aside class="col-lg-3"><nav class="card toc border-0 shadow-sm toc-sticky p-3" aria-label="Neste artigo"><p class="small text-uppercase text-body-secondary mb-2">Neste artigo</p><ol class="list-unstyled small mb-0 d-grid gap-2">${toc.map((t) => `<li><a href="#${esc(t.id)}" class="text-decoration-none">${esc(t.text)}</a></li>`).join("")}</ol></nav></aside>`
    : "";
  const meta = `<div class="d-flex flex-wrap align-items-center gap-2 text-body-secondary small mb-3">${tags ? `<span class="d-flex gap-2">${tags}</span>` : ""}${date ? `<span>${date}</span>` : ""}${readTime ? `<span>· ${readTime} min de leitura</span>` : ""}</div>`;

  const cover = post.cover_image ? thumb(cleanImageUrl(post.cover_image)) : "";
  const body = `<nav aria-label="breadcrumb"><ol class="breadcrumb">
  <li class="breadcrumb-item"><a href="/">Início</a></li>
  <li class="breadcrumb-item active" aria-current="page">${esc(post.title)}</li>
</ol></nav>
<article class="post post-single">
  <div class="card border-0 shadow-sm overflow-hidden">
    ${cover ? `<img class="cover-img w-100 post-cover" loading="eager" fetchpriority="high" src="${esc(cover)}" alt="${esc(post.title)}" />` : ""}
    <div class="card-body p-4 p-md-5">
      ${meta}
      <h1 class="h2 mb-4">${esc(post.title)}</h1>
      <div class="row g-4 layout">
        ${tocHtml ? `<div class="col-lg-9 content">${content}</div>${tocHtml}` : `<div class="col-lg-12 content">${content}</div>`}
      </div>
      ${kitHtml(post)}
      ${travelHtml(post, travelMarker)}
    </div>
  </div>
</article>`;
  return new Response(
    page({
      type: "article",
      title,
      desc,
      ogTitle,
      canonical,
      origin,
      image: cover,
      post,
      body,
      jsonld: postJsonLd(post),
    }),
    { headers: secured({ "Content-Type": "text/html; charset=utf-8", ...POST_CACHE }) }
  );
}

async function tagPage(request, origin, tag) {
  const lower = tag.toLowerCase();
  let posts = [];
  try {
    posts = await fetchPosts();
  } catch (e) {
    // Fallback: página renderizada mesmo sem API
  }
  const filtered = posts.filter((p) =>
    (p.tags || []).some((t) => String(t).toLowerCase() === lower)
  );
  const pretty = tag.replace(/-/g, " ");
  const prettyTitle = pretty.charAt(0).toUpperCase() + pretty.slice(1);
  const desc = `Artigos sobre ${prettyTitle}.`;
  const body = `<nav aria-label="breadcrumb"><ol class="breadcrumb">
  <li class="breadcrumb-item"><a href="/">Início</a></li>
  <li class="breadcrumb-item active" aria-current="page">Artigos: ${esc(prettyTitle)}</li>
</ol></nav>
<div class="mb-3">
  <h1 class="h2 mb-0">Artigos: ${esc(prettyTitle)}</h1>
</div>
<div class="row g-4 post-grid">${filtered.length ? cardsHtml(filtered) : `<div class="col-12"><p class="text-body-secondary mb-0">Nenhum artigo publicado com essa tag ainda.</p></div>`}</div>`;
  return new Response(
    page({
      type: "website",
      title: `Artigos sobre ${prettyTitle} — ${DEFAULT_TITLE}`,
      desc,
      canonical: `${origin}/tag/${esc(slugTag(pretty))}/`,
      origin,
      body,
      jsonld: blogJsonLd(),
    }),
    { headers: secured({ "Content-Type": "text/html; charset=utf-8", ...PUB_CACHE }) }
  );
}

// ---------- Painel admin (SSR, formulários sem JS) ----------

function adminLoginPage(url) {
  const erro = url.searchParams.get("erro");
  const body = `<div class="mx-auto" style="max-width:400px">
${erro ? `<div class="alert alert-danger" role="alert">${esc(erro)}</div>` : ""}
<div class="card border-0 shadow-sm">
  <div class="card-body p-4 p-md-5">
    <h1 class="h4 mb-1">Painel do blog</h1>
    <p class="text-body-secondary small mb-4">Entre com seu usuário e senha.</p>
    <form method="post" action="${ADMIN_ROOT}/login">
      <div class="mb-3">
        <label class="form-label" for="admin-username">Usuário</label>
        <input class="form-control" type="text" id="admin-username" name="username" value="admin" autocomplete="username" required>
      </div>
      <div class="mb-3">
        <label class="form-label" for="admin-password">Senha</label>
        <input class="form-control" type="password" id="admin-password" name="password" autocomplete="current-password" required>
      </div>
      <button class="btn btn-primary w-100" type="submit">Entrar</button>
    </form>
  </div>
</div>
</div>`;
  return new Response(
    page({
      type: "website",
      title: `Painel — ${DEFAULT_TITLE}`,
      desc: "Painel administrativo do blog",
      body,
      admin: true,
      robots: "noindex, nofollow",
      origin: url.origin,
    }),
    { headers: secured({ "Content-Type": "text/html; charset=utf-8" }) }
  );
}

function postAdminRow(post) {
  const isPublishable = post.status === "draft" || post.status === "scheduled";
  const publicUrl = post.status === "published" ? `/post/${esc(post.slug)}/` : null;
  const scheduledAt = post.scheduled_at
    ? `<div class="small text-body-secondary">Agendado para ${esc(new Date(post.scheduled_at).toLocaleString("pt-BR"))}</div>`
    : "";
  return `<div class="list-group-item d-flex flex-wrap align-items-center gap-2">
  <div class="flex-grow-1">
    <div class="fw-semibold text-truncate">${esc(post.title)} <span class="text-body-secondary small">#${post.id}</span></div>
    <div class="small text-body-secondary text-truncate">${esc((post.summary || post.meta_description || "").slice(0, 110))}</div>
    ${scheduledAt}
  </div>
  ${publicUrl ? `<a class="btn btn-sm btn-outline-secondary" href="${publicUrl}" target="_blank" rel="noopener">Ver</a>` : ""}
  ${isPublishable ? `<form method="post" action="${ADMIN_ROOT}/publish"><input type="hidden" name="id" value="${post.id}"><button class="btn btn-sm btn-primary" type="submit">Publicar</button></form>` : ""}
  <form method="post" action="${ADMIN_ROOT}/refresh-images"><input type="hidden" name="id" value="${post.id}"><button class="btn btn-sm btn-outline-primary" type="submit">Imagens</button></form>
  <form method="post" action="${ADMIN_ROOT}/kit"><input type="hidden" name="id" value="${post.id}"><button class="btn btn-sm btn-outline-primary" type="submit">Kit</button></form>
  <form method="post" action="${ADMIN_ROOT}/delete"><input type="hidden" name="id" value="${post.id}"><button class="btn btn-sm btn-outline-danger" type="submit">Excluir</button></form>
</div>`;
}

function statusSection(title, badgeClass, posts) {
  const rows = posts.length
    ? posts.map(postAdminRow).join("")
    : `<div class="list-group-item text-body-secondary">Nenhum post.</div>`;
  return `<div class="card border-0 shadow-sm mb-4">
  <div class="card-header bg-transparent d-flex align-items-center gap-2">
    <h2 class="h5 mb-0">${title}</h2>
    <span class="badge ${badgeClass}">${posts.length}</span>
  </div>
  <div class="list-group list-group-flush">${rows}</div>
</div>`;
}

async function adminDashboard(request, url) {
  const token = readCookie(request, ADMIN_COOKIE);
  if (!token) return adminLoginPage(url);
  if (tokenExpired(token)) {
    const loginUrl = new URL(url);
    loginUrl.searchParams.set("erro", "Sessão expirada — entre novamente");
    return adminLoginPage(loginUrl);
  }
  const msg = url.searchParams.get("msg");
  const erro = url.searchParams.get("erro");
  const flash = msg
    ? `<div class="alert alert-success" role="alert">${esc(msg)}</div>`
    : erro
      ? `<div class="alert alert-danger" role="alert">${esc(erro)}</div>`
      : "";

  const [published, scheduled, drafts] = await Promise.all([
    adminPosts("published", token),
    adminPosts("scheduled", token),
    adminPosts("draft", token),
  ]);

  const body = `<div class="d-flex justify-content-between align-items-center mb-4">
  <h1 class="h3 mb-0">Painel</h1>
  <span class="text-body-secondary small">Sessão ativa</span>
</div>
${flash}
<details class="card border-0 shadow-sm mb-4">
  <summary class="card-body fw-semibold" style="cursor:pointer">Trocar senha</summary>
  <form method="post" action="${ADMIN_ROOT}/senha">
    <div class="card-body pt-0">
      <div class="row g-2">
        <div class="col-md-4"><input class="form-control" type="password" name="current_password" placeholder="Senha atual" autocomplete="current-password" required></div>
        <div class="col-md-4"><input class="form-control" type="password" name="new_password" placeholder="Nova senha" autocomplete="new-password" minlength="4" required></div>
        <div class="col-md-4"><input class="form-control" type="password" name="confirm_password" placeholder="Confirmar nova senha" autocomplete="new-password" minlength="4" required></div>
      </div>
      <button class="btn btn-outline-primary mt-2" type="submit">Salvar nova senha</button>
    </div>
  </form>
</details>
<form class="card border-0 shadow-sm mb-4" method="post" action="${ADMIN_ROOT}/generate">
  <div class="card-body">
    <h2 class="h5 mb-3">Gerar artigo</h2>
    <div class="row g-2">
      <div class="col"><input class="form-control" type="text" name="topic" placeholder="Tema (ex.: Roteiro de 2 dias em Paraty)" required minlength="3" maxlength="200"></div>
      <div class="col-auto"><button class="btn btn-primary" type="submit">Gerar rascunho</button></div>
    </div>
  </div>
</form>
${statusSection("Publicados", "text-bg-success", published)}
${statusSection("Agendados", "text-bg-warning", scheduled)}
${statusSection("Rascunhos", "text-bg-secondary", drafts)}`;

  return new Response(
    page({
      type: "website",
      title: `Painel — ${DEFAULT_TITLE}`,
      desc: "Painel administrativo do blog",
      body,
      admin: true,
      robots: "noindex, nofollow",
      origin: url.origin,
    }),
    { headers: secured({ "Content-Type": "text/html; charset=utf-8" }) }
  );
}

async function adminLoginAction(request) {
  const fd = await request.formData();
  const username = String(fd.get("username") || "admin").trim();
  const password = String(fd.get("password") || "");
  let data;
  try {
    const res = await apiCall("/auth/login", { method: "POST", body: { username, password } });
    if (!res.ok) {
      return adminRedirect(ADMIN_ROOT + "?erro=" + encodeURIComponent(res.status === 401 ? "Usuário ou senha incorretos" : "Falha ao entrar (" + res.status + ")"));
    }
    data = await res.json();
  } catch {
    return adminRedirect(ADMIN_ROOT + "?erro=" + encodeURIComponent("API indisponível — tente novamente"));
  }
  return adminRedirect(
    ADMIN_ROOT,
    adminSessionCookie(data.token, data.expires_in || 86400)
  );
}

async function adminChangePasswordAction(request) {
  const token = readCookie(request, ADMIN_COOKIE);
  if (!token) return adminRedirect(ADMIN_ROOT);
  const fd = await request.formData();
  const current = String(fd.get("current_password") || "");
  const next = String(fd.get("new_password") || "");
  const confirm = String(fd.get("confirm_password") || "");
  if (next.length < 4) {
    return adminRedirect(ADMIN_ROOT + "?erro=" + encodeURIComponent("Nova senha muito curta (mínimo 4)"));
  }
  if (next !== confirm) {
    return adminRedirect(ADMIN_ROOT + "?erro=" + encodeURIComponent("As senhas não conferem"));
  }
  try {
    const res = await apiCall("/auth/change-password", {
      method: "POST",
      token,
      body: { current_password: current, new_password: next },
    });
    if (res.status === 401) {
      return adminRedirect(ADMIN_ROOT + "?erro=" + encodeURIComponent("Senha atual inválida"));
    }
    if (!res.ok) {
      return adminRedirect(ADMIN_ROOT + "?erro=" + encodeURIComponent("Falha ao trocar a senha (" + res.status + ")"));
    }
    return adminRedirect(ADMIN_ROOT + "?msg=" + encodeURIComponent("Senha alterada com sucesso"));
  } catch {
    return adminRedirect(ADMIN_ROOT + "?erro=" + encodeURIComponent("API indisponível"));
  }
}

function adminLogoutAction() {
  return adminRedirect(ADMIN_ROOT, clearAdminCookie());
}

async function adminGenerateAction(request) {
  const token = readCookie(request, ADMIN_COOKIE);
  if (!token) return adminRedirect(ADMIN_ROOT);
  const fd = await request.formData();
  const topic = String(fd.get("topic") || "").trim();
  if (topic.length < 3) {
    return adminRedirect(ADMIN_ROOT + "?erro=" + encodeURIComponent("Tema muito curto"));
  }
  try {
    const res = await apiCall("/generate/post", { method: "POST", token, body: { topic } });
    if (res.status === 401) {
      return adminRedirect(ADMIN_ROOT + "?erro=" + encodeURIComponent("Sessão expirada — entre novamente"));
    }
    if (!res.ok) {
      return adminRedirect(ADMIN_ROOT + "?erro=" + encodeURIComponent("Falha ao gerar (" + res.status + ")"));
    }
    const data = await res.json();
    const name = (data.post && data.post.title) || topic;
    return adminRedirect(ADMIN_ROOT + "?msg=" + encodeURIComponent((data.message || "Artigo gerado") + " — " + name));
  } catch {
    return adminRedirect(ADMIN_ROOT + "?erro=" + encodeURIComponent("API indisponível"));
  }
}

async function adminPostAction(request, action) {
  const token = readCookie(request, ADMIN_COOKIE);
  if (!token) return adminRedirect(ADMIN_ROOT);
  const fd = await request.formData();
  const id = parseInt(String(fd.get("id") || ""), 10);
  if (!Number.isInteger(id) || id <= 0) {
    return adminRedirect(ADMIN_ROOT + "?erro=" + encodeURIComponent("ID inválido"));
  }
  const label =
    action === "publish" ? "Post publicado" :
    action === "delete" ? "Post excluído" :
    action === "kit" ? "Kit de afiliado regenerado" :
    "Imagens atualizadas";
  try {
    const method = action === "delete" ? "DELETE" : "POST";
    const res = await apiCall(`/posts/${id}/${action}`, { method, token });
    if (res.status === 401) {
      return adminRedirect(ADMIN_ROOT + "?erro=" + encodeURIComponent("Sessão expirada — entre novamente"));
    }
    if (!res.ok) {
      const msg = action === "delete" ? "Não foi possível excluir" : "Não foi possível executar a ação";
      return adminRedirect(ADMIN_ROOT + "?erro=" + encodeURIComponent(`${msg} (${res.status})`));
    }
    return adminRedirect(ADMIN_ROOT + "?msg=" + encodeURIComponent(label));
  } catch {
    return adminRedirect(ADMIN_ROOT + "?erro=" + encodeURIComponent("API indisponível"));
  }
}

// ---------- Main / Fetch Handler ----------

function handleSlugUrl(origin, path) {
  // Aceitar /post/slug ou /<slug> direto
  let slug;
  if (path.startsWith("/post/")) {
    slug = path.slice("/post/".length);
  } else {
    slug = path.replace(/^\//, "");
  }
  if (!slug) return null;
  return decodeURIComponent(slug.split("/")[0]);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = url.origin;
    const method = (request.method || "GET").toUpperCase();

    // Painel admin (login + ações por formulário)
    if (path === ADMIN_ROOT || path === ADMIN_ROOT + "/" || path.startsWith(ADMIN_ROOT + "/")) {
      if (method === "POST") {
        if (path === ADMIN_ROOT + "/login") return adminLoginAction(request);
        if (path === ADMIN_ROOT + "/logout") return adminLogoutAction();
        if (path === ADMIN_ROOT + "/senha") return adminChangePasswordAction(request);
        if (path === ADMIN_ROOT + "/generate") return adminGenerateAction(request);
        const action = path.slice((ADMIN_ROOT + "/").length);
        if (["publish", "delete", "refresh-images", "kit"].includes(action)) {
          return adminPostAction(request, action);
        }
        return adminRedirect(ADMIN_ROOT);
      }
      // O painel nunca deve ser indexado: além do <meta robots> nas páginas,
      // marca X-Robots-Tag em qualquer resposta do /admin.
      const res = await adminDashboard(request, url);
      const headers = new Headers(res.headers);
      headers.set("X-Robots-Tag", "noindex, nofollow");
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    }

    // Verificação do Google Search Console (URL prefix, método "arquivo HTML").
    // O GSC pede o arquivo /google<hex>.html contendo "google-site-verification: <nome do arquivo>".
    // Como o token É o nome do arquivo, servimos qualquer googleXXXX.html automaticamente.
    if (/^\/google[0-9a-f]{8,64}\.html$/.test(path)) {
      const filename = path.slice(1); // ex.: googlea1b2c3d4e5f6a7b8.html
      return new Response(`google-site-verification: ${filename}\n`, {
        headers: secured({ "Content-Type": "text/plain; charset=utf-8" }),
      });
    }

    // Favicon
    if (path === "/favicon.svg" || path === "/favicon.ico") {
      return new Response(FAVICON_SVG, {
        headers: secured({
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
        }),
      });
    }

    // Robots.txt
    if (path === "/robots.txt") {
      const body = `User-agent: *
Allow: /
Sitemap: ${origin}/sitemap.xml
`;
      return new Response(body, { headers: secured({ "Content-Type": "text/plain; charset=utf-8" }) });
    }

    // Páginas institucionais
    if (path === "/sobre" || path === "/sobre/") return sobrePage(origin);
    if (path === "/privacidade" || path === "/privacidade/") return privacidadePage(origin);

    // llms.txt — índice simples para agentes/crawlers (Lighthouse "agentic browsing")
    if (path === "/llms.txt") {
      let links = "- [Início](" + origin + "/)";
      try {
        const posts = await fetchPosts(30);
        for (const p of posts) {
          links += `\n- [${p.title}](${origin}/post/${p.slug}/)`;
        }
      } catch (e) {
        // lista parcial se API indisponível
      }
      const body = `# Blog Turismo\n\n> ${DEFAULT_DESC}\n\n## Sobre\n\n- [Sobre](${origin}/sobre)\n- [Privacidade](${origin}/privacidade)\n\n## Artigos\n\n${links}\n`;
      return new Response(body, { headers: secured({ "Content-Type": "text/markdown; charset=utf-8" }) });
    }

    // Sitemap.xml — gerado dinamicamente a partir dos posts publicados
    if (path === "/sitemap.xml") {
      let links = "";
      try {
        const posts = await fetchPosts();
        for (const p of posts) {
          links += `<url><loc>${origin}/post/${esc(p.slug)}/</loc><lastmod>${sitemapDate(p.updated_at || p.published_at)}</lastmod></url>`;
        }
      } catch (e) {
        // sitemap vazio se API indisponível
      }
      const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${origin}/</loc><changefreq>daily</changefreq></url>
  <url><loc>${origin}/sobre</loc><changefreq>monthly</changefreq></url>
  <url><loc>${origin}/privacidade</loc><changefreq>monthly</changefreq></url>
${links}
</urlset>`;
      return new Response(body, { headers: secured({ "Content-Type": "application/xml; charset=utf-8" }) });
    }

    // Página de tag: /tag/<tag>/
    if (path.startsWith("/tag/")) {
      const tag = decodeURIComponent(path.slice("/tag/".length).replace(/\/+$/, ""));
      if (tag) return tagPage(request, origin, tag);
    }

    // Slug real: /post/<slug>/
    if (path.startsWith("/post/")) {
      const slug = handleSlugUrl(origin, path);
      if (slug) return postPage(request, origin, slug, env?.TRAVELPAYOUTS_MARKER);
    }

    // Home (default)
    return home(request, origin);
  },

  async scheduled(event, env, ctx) {
    // Mantém a API do Render free acordada (dorme ~15min de inatividade).
    // cron: */10 * * * *
    try {
      await fetch("https://blog-turismo-api.onrender.com/health", { cf: { cacheTtl: 0 } });
    } catch (e) {
      // falha isolada: o próximo run de 10min reverifica sozinho
    }
  },
};