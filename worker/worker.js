/**
 * Cloudflare Worker — Site do Blog Turismo (Server-Side Rendering)
 *
 * Serve o blog com HTML indexável por crawlers (Google, Bing) e por agentes
 * (ChatGPT / Facebook / etc. via Open Graph + JSON-LD), sem depender de
 * JavaScript para ler o conteúdo.
 * Layout (CSS próprio inline, sem CDN): navbar, cards, dark mode por preferência do sistema.
 *
 * Painel admin em /painel-interno-9f3k7q2x (rota não divulgada; /admin e afins
 * respondem 404): login com a senha ADMIN_KEY (trocada por token curto na API),
 * gerar artigos, publicar, regenerar kit/imagens e excluir.
 *
 * Deploy: `wrangler deploy` (ou via GitHub Actions em .github/workflows/atualizar-blog.yml).
 */

const API_BASE_URL = "https://blog-turismo-api.onrender.com";

// Sessão do painel admin: nome do cookie + prefixo de rota das ações.
// Rota intencionalmente obscura — o painel não é linkado no site público e as
// rotas comuns (/admin, /painel, /dashboard) respondem 404.
const ADMIN_COOKIE = "admin_token";
export const ADMIN_ROOT = "/painel-interno-9f3k7q2x";

const SITE_NAME = "Blog Turismo";
const DEFAULT_TITLE = "Blog Turismo — Roteiros, Dicas e Guias de Destinos";
const DEFAULT_DESC =
  "Roteiros práticos, dicas e guias de viagem pelo Brasil e pelo mundo atualizados todos os dias.";

// Páginas públicas podem ser cacheadas por 5 min (Cloudflare + navegador).
// Conteúdo muda 1x/dia; cache curto reduz o custo de repetição sem estagnar.
const PUB_CACHE = { "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=86400" };
const POST_CACHE = { "Cache-Control": "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400" };

// ---------- Utilitários ----------

// Headers de segurança aplicados em todas as respostas.
// Scripts de terceiros entram por lista explícita: cada um abaixo abre só o
// próprio domínio no CSP (script-src/connect-src), nada de 'unsafe-inline'.

// Cloudflare Web Analytics (sem cookies). Preencha o token do painel para ativar.
const CF_BEACON_TOKEN = "";

// Travelpayouts Drive: monetiza links automaticamente. O loader é inline (hash fixado no CSP
// abaixo); carregado sob primeira interação humana (scroll, toque, cursor) para não acionar
// bloqueio do robots.txt do emrld.ltd durante a inspeção de crawlers e Googlebot.
const DRIVE_SRC = "https://emrld.ltd/NTc0Nzcw.js?t=574770";
export const DRIVE_INLINE = `(function(){var l=0;function n(){if(l)return;l=1;["scroll","pointerdown","touchstart","keydown","mousemove"].forEach(function(e){window.removeEventListener(e,n,{capture:true,passive:true})});var s=document.createElement("script");s.async=true;s.dataset.cmpAb="2";s.src="${DRIVE_SRC}";document.head.appendChild(s)}["scroll","pointerdown","touchstart","keydown","mousemove"].forEach(function(e){window.addEventListener(e,n,{capture:true,passive:true})})})();`;
export const DRIVE_HASH = "sha256-Xc3q4P4pFQyQKb8PuSgQpo6teVXGe7Y8n8ZK0AFm47U=";

// Travelpayouts White Label: metasearch de voos. O loader é inline (hash fixado no CSP
// abaixo); vazio desliga o script e os containers. O hash cobre o texto exato de
// WIDGET_INLINE — conferido pelo check "csp widget hash" no test-worker.mjs.
export const WIDGET_INLINE = "";
export const WIDGET_HASH = "";

// Alternância manual de tema claro/escuro. Script inline com hash no CSP (como o
// widget). Sem JS, o CSS segue a preferência do sistema; com JS, data-theme vence.
export const THEME_INLINE = `(function(){var k="tp-tema",r=document.documentElement;try{var s=localStorage.getItem(k);if(s)r.dataset.theme=s}catch(e){}function u(){var b=document.getElementById("tema");if(!b)return;var d=r.dataset.theme==="dark"||(!r.dataset.theme&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);b.textContent=d?"Modo claro":"Modo escuro";b.onclick=function(){var n=d?"light":"dark";r.dataset.theme=n;try{localStorage.setItem(k,n)}catch(e){}u()}}if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",u)}else{u()}})();`;
export const THEME_HASH = "sha256-aejoEmEiApCSMeJkvrNkMjycpRAGfEps4xH4XThsfQM=";

const cspList = (extra) => ["'self'", ...extra.filter(Boolean)].join(" ");
const CSP = `default-src 'self'; img-src * data:; media-src *; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests; script-src ${cspList([
  CF_BEACON_TOKEN && "https://static.cloudflareinsights.com",
  DRIVE_SRC && "https://emrld.ltd",
  DRIVE_INLINE && `'${DRIVE_HASH}'`,
  WIDGET_INLINE && "https://tpemd.com",
  WIDGET_INLINE && `'${WIDGET_HASH}'`,
  THEME_INLINE && `'${THEME_HASH}'`,
])}; connect-src ${cspList([
  CF_BEACON_TOKEN && "https://cloudflareinsights.com",
  DRIVE_SRC && "https://emrld.ltd",
  WIDGET_INLINE && "https://tpemd.com",
])}`;

const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
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
// Converte uploads crus para thumbnails 960px oficiais para evitar erro 429 de hotlink.
function thumb(u) {
  const s = String(u || "");
  if (/^https:\/\/(?:upload|thumb)\.wikimedia\.org\/wikipedia\/commons\/thumb\//.test(s)) {
    return s.replace(/\d+px-([^/]+)$/, `${THUMB_W}px-$1`);
  }
  const m = s.match(/^https:\/\/(?:upload|thumb)\.wikimedia\.org\/wikipedia\/commons\/([0-9a-f]\/[0-9a-f]{2}\/([^/?#]+))/i);
  if (m) {
    return `https://thumb.wikimedia.org/wikipedia/commons/thumb/${m[1]}/${THUMB_W}px-${m[2]}`;
  }
  return s;
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
        return `<img src="${esc(thumb(cleanImageUrl(src)))}" alt="${esc(alt || "foto")}" width="1200" height="675" loading="lazy" decoding="async" />`;
      })
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, t, href) => `<a href="${esc(href)}" rel="nofollow noopener">${esc(t)}</a>`);

  while (i < lines.length) {
    const l = lines[i];
    const img = l.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (img) {
      out.push(`<figure class="img"><img src="${esc(thumb(cleanImageUrl(img[2])))}" alt="${esc(img[1] || "foto")}" width="1200" height="675" loading="lazy" decoding="async" /></figure>`);
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
    // Tabela Markdown: linha que inicia e termina com | seguida por separador
    if (
      l.trim().startsWith("|") &&
      l.trim().endsWith("|") &&
      i + 1 < lines.length &&
      /^\|?(\s*:?-+:?\s*\|)+\s*$/.test(lines[i + 1].trim())
    ) {
      const headerLine = lines[i];
      const headers = headerLine.split("|").slice(1, -1).map((c) => inlineSafe(c.trim()));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) {
        const cells = lines[i].split("|").slice(1, -1).map((c) => inlineSafe(c.trim()));
        rows.push(cells);
        i++;
      }
      const thead = `<thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>`;
      out.push(`<div class="table-responsive my-4"><table class="table table-striped table-hover mb-0">${thead}${tbody}</table></div>`);
      continue;
    }
    // Citação (blockquote)
    if (/^>\s?/.test(l)) {
      const quotes = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quotes.push(inlineSafe(lines[i].replace(/^>\s?/, "")));
        i++;
      }
      out.push(`<blockquote><p>${quotes.join(" ")}</p></blockquote>`);
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
    <div class="d-flex align-items-center gap-3">
      <a class="navbar-brand fw-bold" href="/">Blog Turismo</a>
      <span class="navbar-text small opacity-75">Destinos, roteiros e dicas de viagem.</span>
    </div>
    <div class="d-flex align-items-center gap-2">
      <a class="nav-link small fw-semibold" href="/">Roteiros</a>
      <a class="nav-link small fw-semibold" href="/sobre">Sobre</a>
      <button id="tema" class="btn btn-sm btn-outline-light" type="button" aria-label="Alternar tema claro-escuro">Modo escuro</button>
    </div>
  </div>
</nav>`;
}

function adminNav() {
  return `<nav class="navbar navbar-dark blognav sticky-top py-3" aria-label="Navegação do painel">
  <div class="container d-flex flex-wrap align-items-center justify-content-between gap-2">
    <a class="navbar-brand fw-bold" href="${ADMIN_ROOT}">Blog Turismo <span class="badge text-bg-warning align-middle">admin</span></a>
    <form class="d-flex mb-0" method="post" action="${ADMIN_ROOT}/logout">
      <button class="btn btn-sm btn-outline-light" type="submit" aria-label="Sair do painel administrativo">Sair</button>
    </form>
  </div>
</nav>`;
}

function page(t) {
  const ogImage = t.image || (t.post && t.post.cover_image ? thumb(cleanImageUrl(t.post.cover_image)) : "");
  const preload = ogImage ? `<link rel="preload" as="image" fetchpriority="high" href="${esc(ogImage)}">` : "";
  const canonical = t.canonical || (t.admin ? t.origin + ADMIN_ROOT : t.origin + "/");
  const robots = t.robots || "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1";
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
<link rel="alternate" type="application/rss+xml" title="Blog Turismo RSS" href="/feed.xml">
${gscMeta}
<title>${esc(t.title)}</title>
<meta name="description" content="${esc(t.desc)}">
<link rel="canonical" href="${esc(canonical)}">
${(t.post || t.type === "article") ? `<link rel="preconnect" href="https://upload.wikimedia.org" crossorigin>` : ""}
${preload}
<meta property="og:type" content="${t.type}">
<meta property="og:locale" content="pt_BR">
<meta property="og:site_name" content="Blog Turismo">
<meta property="og:title" content="${esc(t.ogTitle || t.title)}">
<meta property="og:description" content="${esc(t.desc)}">
<meta property="og:url" content="${esc(canonical)}">
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="675">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(ogImage)}">` : `<meta name="twitter:card" content="summary_large_image">`}
${t.jsonld ? `<script type="application/ld+json">${t.jsonld}</script>` : ""}
<style>
:root {
  color-scheme: light;
  --brand-1:#0f766e;
  --brand-1-hover:#115e59;
  --brand-2:#d97706;
  --brand-gradient:linear-gradient(135deg,#0f766e 0%,#134e4a 100%);
  --bs-body-bg:#f8fafc;
  --bs-body-color:#1e293b;
  --bs-body-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --bs-body-font-size:1.05rem;
  --bs-body-line-height:1.75;
  --bs-link-color:#0f766e;
  --bs-link-hover-color:#115e59;
  --bs-link-decoration:none;
  --bs-border-radius:.85rem;
  --bs-border-radius-lg:1.25rem;
  --bs-card-bg:#ffffff;
  --bs-card-border-color:#e2e8f0;
  --bs-card-border-radius:1rem;
  --bs-secondary-color:#64748b;
  --bs-tertiary-bg:#f1f5f9;
  --shadow-soft:0 1px 3px rgba(15,23,42,.06),0 6px 16px -2px rgba(15,23,42,.05);
  --shadow-hover:0 4px 6px -1px rgba(15,23,42,.08),0 16px 28px -4px rgba(15,23,42,.1);
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --brand-1:#14b8a6;
  --brand-1-hover:#2dd4bf;
  --brand-2:#f59e0b;
  --brand-gradient:linear-gradient(135deg,#0d9488 0%,#0f766e 100%);
  --bs-body-bg:#090d16;
  --bs-body-color:#f1f5f9;
  --bs-link-color:#2dd4bf;
  --bs-link-hover-color:#5eead4;
  --bs-card-bg:#0f172a;
  --bs-card-border-color:#1e293b;
  --bs-secondary-color:#94a3b8;
  --bs-tertiary-bg:#1e293b;
  --shadow-soft:0 1px 3px rgba(0,0,0,.35),0 8px 20px -2px rgba(0,0,0,.45);
  --shadow-hover:0 8px 20px -2px rgba(0,0,0,.5),0 20px 36px -4px rgba(0,0,0,.6);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --brand-1:#14b8a6;
    --brand-1-hover:#2dd4bf;
    --brand-2:#f59e0b;
    --brand-gradient:linear-gradient(135deg,#0d9488 0%,#0f766e 100%);
    --bs-body-bg:#090d16;
    --bs-body-color:#f1f5f9;
    --bs-link-color:#2dd4bf;
    --bs-link-hover-color:#5eead4;
    --bs-card-bg:#0f172a;
    --bs-card-border-color:#1e293b;
    --bs-secondary-color:#94a3b8;
    --bs-tertiary-bg:#1e293b;
    --shadow-soft:0 1px 3px rgba(0,0,0,.35),0 8px 20px -2px rgba(0,0,0,.45);
    --shadow-hover:0 8px 20px -2px rgba(0,0,0,.5),0 20px 36px -4px rgba(0,0,0,.6);
  }
}
/* ---------- Base: substitui o bootstrap.min.css do CDN (só o que o site usa) ---------- */
:focus-visible { outline: 2px solid var(--brand-1); outline-offset: 3px; border-radius: 4px; }
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bs-body-bg);color:var(--bs-body-color);font-family:var(--bs-body-font-family);font-size:var(--bs-body-font-size);line-height:var(--bs-body-line-height);overflow-wrap:break-word;-webkit-font-smoothing:antialiased}
img{aspect-ratio:16/9;object-fit:cover}
a{color:var(--bs-link-color);transition:color .15s ease}
a:hover{color:var(--bs-link-hover-color)}
h1,h2,h3,h4,h5,h6{font-weight:700;line-height:1.26;letter-spacing:-.02em;margin:0 0 .5rem}
p{margin:0 0 1rem}
ul,ol{padding-left:1.5em;margin:0 0 1rem}
blockquote{margin:1.5rem 0;padding:1rem 1.35rem;border-left:4px solid var(--brand-1);background:var(--bs-tertiary-bg);border-radius:0 var(--bs-border-radius) var(--bs-border-radius) 0;font-style:italic;color:var(--bs-secondary-color)}
blockquote p:last-child{margin-bottom:0}
.container{width:100%;max-width:1160px;margin-inline:auto;padding-inline:1.25rem}
.row{display:grid;grid-template-columns:repeat(12,1fr);gap:1.5rem}
.row.g-0{gap:0}.row.g-2{gap:.5rem}.row.g-3{gap:1rem}.row.g-4{gap:1.5rem}
.col-12{grid-column:span 12}
.col-md-6{grid-column:span 12}
.col-md-4{grid-column:span 12}
.col-lg-3{grid-column:span 12}
.col-lg-4{grid-column:span 12}
.col-lg-8{grid-column:span 12}
.col-lg-9{grid-column:span 12}
.col-lg-12{grid-column:span 12}
@media (min-width:768px){
  .col-md-6{grid-column:span 6}
  .col-md-4{grid-column:span 4}
  .p-md-5{padding:2.75rem!important}
}
@media (min-width:992px){
  .col-lg-3{grid-column:span 3}
  .col-lg-4{grid-column:span 4}
  .col-lg-8{grid-column:span 8}
  .col-lg-9{grid-column:span 9}
  .col-lg-12{grid-column:span 12}
  .row.g-0 .col-lg-4{grid-column:span 4}
}
.navbar{display:flex;align-items:center;padding-block:.75rem}
.navbar-dark .navbar-brand,.navbar-dark .nav-link{color:#fff}
.navbar-brand{font-weight:800;font-size:1.18rem;letter-spacing:-.02em;text-decoration:none;display:inline-flex;align-items:center;gap:.45rem}
.navbar-brand::before{content:"✦";display:inline-flex;align-items:center;justify-content:center;width:1.65rem;height:1.65rem;border-radius:.45rem;background:rgba(255,255,255,.16);font-size:.9rem;line-height:1}
.nav-link{color:rgba(255,255,255,.88);text-decoration:none;padding:.3rem .55rem;border-radius:.45rem}
.nav-link:hover{color:#fff;background:rgba(255,255,255,.14)}
.navbar-text{color:rgba(255,255,255,.8)}
#tema::before{content:"☾ ";font-size:.95em}
:root[data-theme="dark"] #tema::before{content:"☀ "}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) #tema::before{content:"☀ "}}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.4rem;padding:.52rem 1.05rem;border:1px solid transparent;border-radius:.65rem;background:transparent;cursor:pointer;font:inherit;font-weight:600;line-height:1.4;text-decoration:none;text-align:center;transition:all .16s ease}
.btn-primary{background:var(--brand-1);color:#fff}.btn-primary:hover{background:var(--brand-1-hover);color:#fff}
.btn-dark{background:#1e293b;color:#fff}.btn-dark:hover{background:var(--brand-1);color:#fff}
:root[data-theme="dark"] .btn-dark{background:var(--brand-1);color:#090d16}
:root[data-theme="dark"] .btn-dark:hover{background:var(--brand-1-hover);color:#090d16}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .btn-dark{background:var(--brand-1);color:#090d16}}
.btn-outline-primary{color:var(--brand-1);border-color:var(--brand-1)}.btn-outline-primary:hover{background:var(--brand-1);color:#fff}
.btn-outline-secondary{color:var(--bs-secondary-color);border-color:var(--bs-secondary-color)}.btn-outline-secondary:hover{background:var(--bs-secondary-color);color:#fff}
.btn-outline-danger{color:#dc3545;border-color:#dc3545}.btn-outline-danger:hover{background:#dc3545;color:#fff}
.btn-outline-light{color:#fff;border-color:rgba(255,255,255,.45);background:rgba(255,255,255,.08)}.btn-outline-light:hover{background:rgba(255,255,255,.2);color:#fff}
.btn-sm{padding:.34rem .72rem;font-size:.86em}
.badge{display:inline-flex;align-items:center;padding:.42em .75em;font-size:.75em;font-weight:600;letter-spacing:.02em;line-height:1.1;white-space:nowrap;border-radius:.5em}
.rounded-pill{border-radius:50rem}
.text-bg-primary{background:var(--brand-1);color:#fff}
.text-bg-secondary{background:var(--bs-tertiary-bg);color:var(--bs-body-color);border:1px solid var(--bs-card-border-color)}
.text-bg-success{background:#198754;color:#fff}
.text-bg-warning,.text-bg-warning a{background:#ffc107;color:#1a222b}
.text-bg-danger{background:#dc3545;color:#fff}
.card{background:var(--bs-card-bg);border:1px solid var(--bs-card-border-color);border-radius:var(--bs-card-border-radius);display:flex;flex-direction:column}
.border-0{border:0!important}
.shadow-sm{box-shadow:var(--shadow-soft)}
.card-body{padding:1.35rem;flex:1 1 auto}
.card-title{margin-bottom:.55rem;font-weight:700;line-height:1.32}
.card-header{padding:1rem 1.35rem;border-bottom:1px solid var(--bs-card-border-color)}
.card-text{margin:0}
.breadcrumb{display:flex;flex-wrap:wrap;list-style:none;padding:0;margin:0 0 1.25rem;gap:.5rem;font-size:.9rem}
.breadcrumb-item a{color:var(--bs-secondary-color);text-decoration:none;font-weight:500}
.breadcrumb-item a:hover{color:var(--bs-link-color)}
.breadcrumb-item.active{color:var(--bs-body-color);font-weight:600}
.breadcrumb-item+.breadcrumb-item::before{content:"›";margin-right:.5rem;color:var(--bs-secondary-color)}
.form-label{display:block;margin:0 0 .5rem;font-weight:500}
.form-control{display:block;width:100%;padding:.55rem .8rem;border:1px solid var(--bs-card-border-color);border-radius:.6rem;background:var(--bs-card-bg);color:inherit;font:inherit}
.form-control:focus{outline:2px solid var(--brand-1);outline-offset:1px;border-color:transparent}
.alert{padding:1rem;border-radius:.8rem;border:1px solid transparent;margin:0 0 1rem}
.alert-danger{color:#842029;background:#f8d7da;border-color:#f5c2c7}
.alert-success{color:#0f5132;background:#d1e7dd;border-color:#badbcc}
.list-group{display:flex;flex-direction:column;list-style:none;padding:0;margin:0;background:var(--bs-card-bg);border:1px solid var(--bs-card-border-color);border-radius:var(--bs-card-border-radius);overflow:hidden}
.list-group-item{padding:.85rem 1.15rem;border-bottom:1px solid var(--bs-card-border-color)}
.list-group-item:last-child{border-bottom:0}
.ratio{position:relative;width:100%;overflow:hidden;background:var(--bs-tertiary-bg)}
.ratio-16x9::before{content:"";display:block;padding-top:56.25%}
.ratio>*{position:absolute;inset:0}
.list-unstyled{list-style:none;padding-left:0}
.d-grid{display:grid}
.table-responsive{overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:var(--bs-border-radius);border:1px solid var(--bs-card-border-color);margin-block:1.75rem;box-shadow:var(--shadow-soft)}
.table{width:100%;border-collapse:collapse;font-size:.95rem;text-align:left}
.table th,.table td{padding:.85rem 1.1rem;border-bottom:1px solid var(--bs-card-border-color)}
.table tbody tr:last-child td{border-bottom:0}
.table th{background:var(--bs-tertiary-bg);font-weight:700;font-size:.85rem;text-transform:uppercase;letter-spacing:.04em;color:var(--bs-secondary-color)}
.table-striped tbody tr:nth-of-type(odd){background-color:rgba(0,0,0,.018)}
:root[data-theme="dark"] .table-striped tbody tr:nth-of-type(odd){background-color:rgba(255,255,255,.02)}
.table-hover tbody tr:hover{background-color:rgba(13,110,135,.07)}
/* ---------- Utilidades ---------- */
.d-flex{display:flex}.d-inline-flex{display:inline-flex}.d-block{display:block}.flex-wrap{flex-wrap:wrap}.flex-column{flex-direction:column}.flex-grow-1{flex-grow:1}
.justify-content-between{justify-content:space-between}.justify-content-center{justify-content:center}
.align-items-center{align-items:center}.align-self-start{align-self:flex-start}
.gap-2{gap:.5rem}.gap-3{gap:1rem}
.p-3{padding:1rem}.p-4{padding:1.5rem}.p-5{padding:3rem}.py-3{padding-block:.9rem}.py-4{padding-block:2rem}.py-5{padding-block:3rem}.px-3{padding-inline:1rem}
.mb-0{margin-bottom:0}.mb-1{margin-bottom:.25rem}.mb-2{margin-bottom:.5rem}.mb-3{margin-bottom:1rem}.mb-4{margin-bottom:1.5rem}.mb-5{margin-bottom:3rem}.mt-2{margin-top:.5rem}.mt-3{margin-top:1rem}.mt-4{margin-top:1.5rem}.mt-5{margin-top:3rem}
.mx-auto{margin-inline:auto}.me-auto{margin-inline-end:auto}
.text-center{text-align:center}.text-start{text-align:left}.text-uppercase{text-transform:uppercase}.text-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.text-body-secondary{color:var(--bs-secondary-color)}
.link-body-emphasis{color:inherit;text-decoration:none}
.link-body-emphasis:hover{color:var(--bs-link-color)}
.link-secondary{color:var(--bs-secondary-color);text-decoration:none}
.link-secondary:hover{color:var(--bs-link-color)}
.text-decoration-none{text-decoration:none}
.fw-bold{font-weight:700}.fw-semibold{font-weight:600}.fs-4{font-size:1.5rem}
.h1{font-size:clamp(1.75rem,3vw,2.35rem)}.h2{font-size:clamp(1.5rem,2.5vw,2rem)}.h3{font-size:1.5rem}.h4{font-size:1.3rem}.h5{font-size:1.15rem}.h6{font-size:.95rem}
.small{font-size:.875em}.opacity-75{opacity:.82}
.h-100{height:100%}.w-100{width:100%}.min-vh-100{min-height:100vh}.overflow-hidden{overflow:hidden}.object-fit-cover{object-fit:cover}
.sticky-top{position:sticky;top:0;z-index:1020}.align-middle{vertical-align:middle}
.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.visually-hidden-focusable:not(:focus):not(:focus-within){position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.visually-hidden-focusable:focus{position:fixed;top:.75rem;left:.75rem;z-index:1100;padding:.5rem 1rem;background:var(--bs-card-bg);color:var(--bs-body-color);border-radius:.5rem;box-shadow:var(--shadow-hover);text-decoration:none;font-weight:600}
/* ---------- Customizações do site ---------- */
.blognav {
  background:rgba(15,23,42,.92);
  backdrop-filter:blur(16px);
  -webkit-backdrop-filter:blur(16px);
  border-bottom:1px solid rgba(255,255,255,.08);
  box-shadow:0 4px 20px rgba(0,0,0,.08);
}
:root[data-theme="dark"] .blognav {
  background:rgba(9,13,22,.92);
  border-bottom:1px solid rgba(255,255,255,.06);
}
html { scroll-padding-top: 84px; scroll-behavior: smooth; }
.progress { position:fixed; top:0; left:0; width:100%; height:4px; border-radius:0 2px 2px 0; transform:scaleX(0); transform-origin:0 50%;
  background:linear-gradient(90deg,var(--brand-1),var(--brand-2)); z-index:1050; pointer-events:none; }
.callout-tip { background:rgba(13,110,135,0.07); border-left:4px solid var(--brand-1); padding:1rem 1.25rem; border-radius:8px; margin:1.5rem 0; }
@supports (animation-timeline: scroll()) {
  .progress { animation:progress-grow linear; animation-timeline:scroll(root); }
}
@keyframes progress-grow { to { transform:scaleX(1); } }
.card.hero, .post-card, .card.toc { border:1px solid var(--bs-card-border-color)!important; }
.card.hero {
  background:linear-gradient(145deg,var(--bs-card-bg) 55%,var(--bs-tertiary-bg) 100%);
  box-shadow:var(--shadow-soft);
  transition:box-shadow .25s ease;
}
.card.hero:hover { box-shadow:var(--shadow-hover); }
.hero .cover-img { min-height:320px; transition:transform .45s cubic-bezier(.22,1,.36,1); }
.card.hero:hover .cover-img { transform:scale(1.03); }
.post-grid .ratio-16x9::before { padding-top:62.5%; }
.post-grid .cover-img { aspect-ratio:16/10; transition:transform .35s ease; }
.post-card { height:100%; overflow:hidden; transition:transform .22s ease, box-shadow .22s ease, border-color .22s ease; box-shadow:var(--shadow-soft); }
.post-card:hover { transform:translateY(-4px); box-shadow:var(--shadow-hover); }
.post-card:hover .cover-img { transform:scale(1.035); }
.post-grid .card-text { display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; line-height:1.6; }
.card-meta-footer { margin-top:auto; padding-top:.85rem; border-top:1px solid var(--bs-card-border-color); display:flex; align-items:center; justify-content:space-between; gap:.5rem; }
.post-card .btn { transition:transform 0.15s ease, background-color 0.15s ease, color 0.15s ease; }
.post-card:hover .btn { transform:translateX(2px); }
.section-kicker { display:inline-flex; align-items:center; gap:.5rem; letter-spacing:.08em; font-weight:700; }
.section-kicker::before { content:""; width:8px; height:8px; border-radius:50%; background:var(--brand-1); display:inline-block; }
.content { font-size:1.06rem; line-height:1.82; max-width:72ch; }
.post-summary-box { background:var(--bs-tertiary-bg); border-left:4px solid var(--brand-1); padding:1.25rem 1.5rem; border-radius:.85rem; margin-bottom:2.25rem; font-size:1.06rem; line-height:1.7; }
.content > p:first-of-type:not(:has(img))::first-letter { font-size:2.9em; float:left; margin:0.06em 0.14em 0 0; line-height:0.82; font-weight:800; color:var(--brand-1); }
.related .post-card { transition:transform .2s ease, box-shadow .2s ease; }
.related .post-card:hover { transform:translateY(-3px); box-shadow:var(--shadow-hover); }
.cover-img { display:block; width:100%; aspect-ratio:16/9; object-fit:cover; background:var(--bs-tertiary-bg); }
.post-cover { max-height:480px; }
.sidebar-sticky { position:sticky; top:92px; }
.toc-sticky { background:var(--bs-tertiary-bg); }
.toc a { display:flex; align-items:center; min-height:44px; line-height:1.4; padding:7px .5rem; border-radius:.45rem; color:var(--bs-secondary-color); font-weight:500; transition:background .15s ease, color .15s ease; }
.toc a:hover { background:var(--bs-card-bg); color:var(--bs-link-color); }
.kit { padding:1.25rem; background:var(--bs-tertiary-bg); border:1px solid var(--bs-card-border-color); border-radius:var(--bs-card-border-radius); }
.whatsapp-share { background:rgba(37,211,102,.08); border:1px solid rgba(37,211,102,.32); border-radius:1rem; }
.btn-whatsapp { background:#15803d; border-color:#15803d; color:#fff; }
.btn-whatsapp:hover { background:#166534; border-color:#166534; color:#fff; }
.not-found-box { max-width:540px; background:var(--bs-tertiary-bg); border:1px solid var(--bs-card-border-color); border-radius:var(--bs-border-radius-lg); }
.footer { border-top:1px solid var(--bs-card-border-color); background:var(--bs-tertiary-bg); margin-top:3rem; }
.content h1, .content h2, .content h3 { line-height:1.3; margin:1.85em 0 .6em; letter-spacing:-.02em; }
.content h2 { padding-bottom:.35rem; border-bottom:1px solid var(--bs-card-border-color); }
.content p { margin:.95em 0; }
.content img { width:100%; aspect-ratio:16/9; object-fit:cover; border-radius:14px; display:block; background:var(--bs-tertiary-bg); box-shadow:var(--shadow-soft); }
.content figure.img { margin:1.85em 0; }
.content ul, .content ol { padding-left:1.35em; margin:.95em 0; }
.content li { margin-bottom:.35em; }
code { white-space:pre-wrap; background:rgba(13,110,135,.1); padding:.15em .4em; border-radius:6px; font-size:.9em; }
.sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
@media (max-width: 767px) {
  .navbar-text { display:none; }
  .hero .cover-img { min-height:220px; }
  .p-4 { padding:1.25rem; }
  .py-4 { padding-block:1.25rem; }
  .kit { padding:1.15rem; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
hr { border:0; border-top:1px solid var(--bs-card-border-color); margin:2rem 0; opacity:0.6; }
@media print {
  .navbar, footer, .btn, .progress, .toc, .visually-hidden-focusable { display:none !important; }
  body { background:#fff !important; color:#000 !important; }
  .card { box-shadow:none !important; border:none !important; }
}
</style>
${!t.admin && DRIVE_INLINE ? `<script>${DRIVE_INLINE}</script>` : ""}
${!t.admin && WIDGET_INLINE ? `<script>${WIDGET_INLINE}</script>` : ""}
${!t.admin && THEME_INLINE ? `<script>${THEME_INLINE}</script>` : ""}
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
  <div class="container d-flex flex-wrap align-items-center justify-content-between gap-2">
    <div><a class="link-body-emphasis fw-bold" href="/">Blog Turismo</a> · Conteúdo informativo atualizado todos os dias</div>
    <div class="d-flex gap-3"><a class="link-secondary" href="/sobre">Sobre</a><a class="link-secondary" href="/privacidade">Privacidade</a><a class="link-secondary" href="/feed.xml">RSS</a></div>
  </div>
</footer>
</body>
</html>`;
}

// ---------- JSON-LD ----------

function blogJsonLd(origin = SITE_ORIGIN) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${origin}/#website`,
        "url": `${origin}/`,
        "name": "Blog Turismo",
        "alternateName": ["BlogTurismo", "Blog Turismo Brasil"],
        "description": DEFAULT_DESC,
        "inLanguage": "pt-BR",
        "publisher": {
          "@type": "Organization",
          "name": "Blog Turismo",
          "url": `${origin}/`
        }
      },
      {
        "@type": "Blog",
        "@id": `${origin}/#blog`,
        "url": `${origin}/`,
        "name": "Blog Turismo",
        "description": DEFAULT_DESC,
        "inLanguage": "pt-BR",
        "isPartOf": { "@id": `${origin}/#website` }
      }
    ]
  });
}

function postJsonLd(a, origin = SITE_ORIGIN) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        "itemListElement": [
          {
            "@type": "ListItem",
            "position": 1,
            "name": "Início",
            "item": `${origin}/`
          },
          {
            "@type": "ListItem",
            "position": 2,
            "name": a.title,
            "item": `${origin}/post/${a.slug}/`
          }
        ]
      },
      {
        "@type": "BlogPosting",
        "headline": a.title,
        "description": a.summary || a.meta_description,
        "image": a.cover_image ? cleanImageUrl(a.cover_image) : undefined,
        "datePublished": a.published_at,
        "dateModified": a.updated_at || a.published_at,
        "inLanguage": "pt-BR",
        "wordCount": a.content ? a.content.split(/\s+/).length : undefined,
        "keywords": (a.tags || []).map((tag) => String(tag).trim()).filter(Boolean).join(", ") || undefined,
        "mainEntityOfPage": { "@type": "WebPage", "@id": `${origin}/post/${a.slug}/` },
        "author": { "@type": "Organization", "name": "Blog Turismo" },
        "publisher": {
          "@type": "Organization",
          "name": "Blog Turismo",
          "logo": { "@type": "ImageObject", "url": `${origin}/favicon.svg` }
        }
      }
    ]
  });
}

// ---------- Acesso à API ----------

async function fetchWithRetry(url, options = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, options);
      if ([502, 503, 504].includes(res.status) && i < retries) {
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
        continue;
      }
      return res;
    } catch (err) {
      if (i < retries) {
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

async function fetchPosts(limit = 30, offset = 0) {
  const u = `${API_BASE_URL}/posts?status=published&limit=${limit}&offset=${offset}`;
  const res = await fetchWithRetry(u, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("API " + res.status);
  return res.json();
}

async function fetchAllPosts() {
  const all = [];
  let offset = 0;
  while (true) {
    const batch = await fetchPosts(200, offset);
    all.push(...batch);
    if (batch.length < 200) break;
    offset += batch.length;
  }
  return all;
}

async function fetchPost(slug) {
  const u = `${API_BASE_URL}/posts/${encodeURIComponent(slug)}`;
  const res = await fetchWithRetry(u, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const canonicalSlug = res.headers && typeof res.headers.get === "function" ? res.headers.get("X-Canonical-Slug") : null;
  const data = await res.json();
  if (canonicalSlug && canonicalSlug !== slug) {
    return { redirect: canonicalSlug };
  }
  if (data && data.slug && data.slug !== slug) {
    return { redirect: data.slug };
  }
  return data;
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

function relatedBadge(post, badgeClass = "text-bg-secondary") {
  const r = post && post.related_post;
  if (!r) return "";
  return `<a class="badge rounded-pill ${badgeClass} text-decoration-none" href="/post/${esc(r.slug)}/" title="Leia também">Leia também: ${esc(r.title)}</a>`;
}

function cardsHtml(posts) {
  return posts.map((p) => {
    const img = p.cover_image
      ? `<a class="d-block ratio ratio-16x9" href="/post/${esc(p.slug)}/" tabindex="-1" aria-hidden="true"><img class="cover-img object-fit-cover w-100" width="960" height="540" loading="lazy" src="${esc(thumb(cleanImageUrl(p.cover_image)))}" alt="" role="presentation" /></a>`
      : "";
    const rel = relatedBadge(p);
    const date = p.published_at ? `<time datetime="${esc(p.published_at)}">${new Date(p.published_at).toLocaleDateString("pt-BR")}</time>` : "";
    return `<article class="col-md-6 col-lg-4">
      <div class="card post-card h-100 border-0 shadow-sm">
        ${img}
        <div class="card-body d-flex flex-column">
          ${rel ? `<div class="mb-2">${rel}</div>` : ""}
          <h2 class="h5 card-title mb-2"><a class="text-decoration-none link-body-emphasis" href="/post/${esc(p.slug)}/">${esc(p.title)}</a></h2>
          <p class="card-text text-body-secondary flex-grow-1 small mb-3">${esc(p.summary || "")}</p>
          <div class="card-meta-footer small text-body-secondary">
            <span>${date}</span>
            <a class="btn btn-sm btn-outline-primary" href="/post/${esc(p.slug)}/">Ler artigo completo →</a>
          </div>
        </div>
      </div>
    </article>`;
  }).join("") || `<div class="col-12"><p class="text-body-secondary mb-0">Nenhum artigo publicado ainda.</p></div>`;
}

function heroHtml(p) {
  const date = p.published_at ? `<time datetime="${esc(p.published_at)}">${new Date(p.published_at).toLocaleDateString("pt-BR")}</time>` : "";
  return `<article class="card hero border-0 shadow-sm mb-5 overflow-hidden">
  <div class="row g-0">
    <div class="col-md-6 overflow-hidden">
      <a class="d-block h-100" href="/post/${esc(p.slug)}/" tabindex="-1" aria-hidden="true"><img class="cover-img object-fit-cover w-100 h-100" width="1200" height="675" loading="eager" fetchpriority="high" src="${esc(thumb(cleanImageUrl(p.cover_image)))}" alt="" role="presentation" /></a>
    </div>
    <div class="col-md-6 d-flex flex-column justify-content-center p-4 p-md-5">
      <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
        ${relatedBadge(p, "text-bg-primary") || `<span class="badge rounded-pill text-bg-primary">Turismo</span>`}
        ${date ? `<span class="small text-body-secondary">· ${date}</span>` : ""}
      </div>
      <h2 class="card-title h1 mb-3"><a class="text-decoration-none link-body-emphasis" href="/post/${esc(p.slug)}/">${esc(p.title)}</a></h2>
      <p class="card-text text-body-secondary mb-4">${esc(p.summary || "")}</p>
      <a class="btn btn-dark align-self-start" href="/post/${esc(p.slug)}/">Ler artigo completo →</a>
    </div>
  </div>
</article>`;
}

const HOME_PAGE_SIZE = 5;

async function home(request, origin, pageNum = 1) {
  const p = Math.max(1, pageNum | 0);
  const posts = (async () => {
    try {
      return await fetchPosts(50, (p - 1) * HOME_PAGE_SIZE);
    } catch (e) {
      // Fallback: ainda renderiza a página mas com aviso
      return [];
    }
  })();
  const all = await posts;
  const list = all.slice(0, HOME_PAGE_SIZE);
  // Contagem exata só quando o fetch não satura (limit 50); se saturar, mostra a
  // página sem número, pois o total é desconhecido. ponytail: single-request pagination.
  const exact = all.length < 50;
  const remaining = exact ? Math.max(0, all.length - HOME_PAGE_SIZE) : null;
  const nextHref = `${origin}/page/${p + 1}/`;
  const nav = [];
  if (p > 1) {
    nav.push(`<a class="btn btn-outline-primary" href="${origin}/page/${p - 1}/" rel="prev">Posts anteriores</a>`);
  }
  if ((exact && remaining > 0) || all.length === 50) {
    nav.push(`<a class="btn btn-primary" href="${esc(nextHref)}" rel="next">Ver mais posts${exact && remaining > 0 ? ` (${remaining} restantes)` : ""}</a>`);
  }
  let hero = "";
  let grid = list;
  let heroImage = "";
  if (p === 1 && list[0] && list[0].cover_image) {
    heroImage = thumb(cleanImageUrl(list[0].cover_image));
    hero = heroHtml(list[0]);
    grid = list.slice(1, HOME_PAGE_SIZE);
  }
  const body = `<h1 class="visually-hidden">Últimos artigos</h1>
${hero}
${list.length ? `<div class="d-flex align-items-center mb-3">
  <h2 class="h6 text-uppercase text-body-secondary section-kicker mb-0">Artigos recentes</h2>
</div>
<div class="row g-4 post-grid">${cardsHtml(grid)}</div>
${nav.length ? `<nav class="d-flex gap-2 justify-content-center mt-5" aria-label="Paginação">${nav.join("")}</nav>` : ""}` : `<p>Nenhum artigo publicado ainda.</p>`}`;
  return new Response(
    page({
      type: "website",
      title: p === 1 ? DEFAULT_TITLE : `Pág. ${p} — ${DEFAULT_TITLE}`,
      desc: DEFAULT_DESC,
      canonical: p === 1 ? origin + "/" : `${origin}/page/${p}/`,
      origin,
      image: heroImage,
      body,
      jsonld: blogJsonLd(origin),
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
<p>Alguns links levam a lojas e serviços parceiros (como Amazon e Booking.com). Ao comprar ou reservar por eles, o blog pode receber uma comissão <strong>sem nenhum custo adicional para você</strong>. O preço e as condições são os mesmos.</p>
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
      return `<div class="col-12 col-md-4 col-lg-12">
      <div class="card h-100 border-0 shadow-sm">
        <div class="card-body p-3">
          <span class="badge rounded-pill text-bg-primary mb-2" aria-hidden="true">${i + 1}</span>
          <h3 class="h6 mb-1"><a class="text-decoration-none link-body-emphasis" rel="sponsored nofollow noopener" href="${url}">${esc(item.name)}</a></h3>
          ${item.note ? `<p class="small text-body-secondary mb-2">${esc(item.note)}</p>` : ""}
          <a class="btn btn-sm btn-outline-primary w-100" rel="sponsored nofollow noopener" href="${url}">Ver na Amazon</a>
        </div>
      </div>
    </div>`;
    })
    .join("");
  return `<section class="kit mt-5" aria-label="Kit recomendado para essa viagem">
  <h2 class="h5 mb-1">Kit recomendado para essa viagem</h2>
  <p class="text-body-secondary small mb-3">Alguns links desta página são de afiliado da Amazon. Se você comprar por eles, o blog ganha uma pequena comissão sem custo extra para você.</p>
  <div class="row g-2">${items}</div>
</section>`;
}

function travelHtml(post) {
  const booking = TRAVEL_AFFILIATES.booking;
  if (!booking) return "";
  const dest = ((post.tags || [])[0] || post.title || "").trim();
  const q = encodeURIComponent(dest);
  return `<section class="kit mt-5" aria-label="Planeje a viagem">
  <h2 class="h4 mb-1">Planeje a viagem</h2>
  <p class="text-body-secondary small mb-3">Links de parceiros. Reservando por eles, o blog ganha uma pequena comissão sem custo extra para você.</p>
  <div class="d-flex flex-wrap gap-2 mb-4">
    <a class="btn btn-outline-primary" rel="sponsored nofollow noopener" href="https://www.booking.com/searchresults.html?aid=${encodeURIComponent(booking)}&ss=${q}">Ver hotéis em ${esc(dest)}</a>
  </div>
</section>`;
}

function relatedHtml(post) {
  const r = post && post.related_post;
  if (!r) return "";
  const cover = r.cover_image
    ? `<img class="cover-img w-100" loading="lazy" src="${esc(thumb(cleanImageUrl(r.cover_image)))}" alt="" role="presentation" />`
    : "";
  return `<section class="related mt-5" aria-label="Leia também">
  <h2 class="h4 mb-3">Leia também</h2>
  <div class="card post-card border-0 shadow-sm overflow-hidden">
    ${cover}
    <div class="card-body">
      <h3 class="h6 mb-2"><a class="text-decoration-none link-body-emphasis" href="/post/${esc(r.slug)}/">${esc(r.title)}</a></h3>
      ${r.summary ? `<p class="card-text text-body-secondary small mb-0">${esc(r.summary)}</p>` : ""}
      <a class="btn btn-sm btn-outline-primary mt-3" href="/post/${esc(r.slug)}/">Ler artigo completo</a>
    </div>
  </div>
</section>`;
}


function whatsappShareHtml(post, canonical) {
  const shareText = encodeURIComponent(`${post.title} — Veja este roteiro: ${canonical}`);
  const waUrl = `https://api.whatsapp.com/send?text=${shareText}`;
  return `<div class="whatsapp-share mt-4 p-4 text-center">
  <p class="mb-2 fw-semibold">Gostou deste roteiro? Compartilhe com quem vai viajar com você!</p>
  <a class="btn btn-whatsapp d-inline-flex align-items-center gap-2" target="_blank" rel="noopener noreferrer" href="${waUrl}">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981z"/></svg>
    Compartilhar no WhatsApp
  </a>
</div>`;
}

async function postPage(request, origin, slug, travelMarker) {
  const resData = await fetchPost(slug);
  if (!resData) {
    return new Response("Artigo não encontrado", {
      status: 404,
      statusText: "Not Found",
      headers: secured({ "Content-Type": "text/plain; charset=utf-8" }),
    });
  }
  if (resData.redirect) {
    return new Response(null, {
      status: 301,
      headers: { Location: `${origin}/post/${encodeURIComponent(resData.redirect)}/` },
    });
  }
  const post = resData;
  const title = post.meta_title || post.title || DEFAULT_TITLE;
  const desc = post.meta_description || post.summary || DEFAULT_DESC;
  const ogTitle = post.title;
  const canonical = `${origin}/post/${esc(post.slug)}/`;
  const date = post.published_at ? `<time datetime="${esc(post.published_at)}">${new Date(post.published_at).toLocaleDateString("pt-BR")}</time>` : "";
  const readTime = post.content
    ? Math.max(1, Math.round(post.content.split(/\s+/).length / 200))
    : null;
  const tags = relatedBadge(post);
  const toc = [];
  const content = mdToHtml(post.content, toc);
  const kit = kitHtml(post);
  const tocHtml = toc.length >= 2
    ? `<nav class="card toc border-0 shadow-sm toc-sticky p-3" aria-label="Neste artigo"><p class="small text-uppercase text-body-secondary mb-2">Neste artigo</p><ol class="list-unstyled small mb-0 d-grid gap-2">${toc.map((t) => `<li><a href="#${esc(t.id)}" class="text-decoration-none">${esc(t.text)}</a></li>`).join("")}</ol></nav>`
    : "";
  const sidebarHtml = `<aside class="col-lg-4"><div class="sidebar-sticky d-flex flex-column gap-3">${tocHtml}${kit}</div></aside>`;
  const meta = `<div class="d-flex flex-wrap align-items-center gap-2 text-body-secondary small mb-3">${tags ? `<span class="d-flex gap-2">${tags}</span>` : ""}${date ? `<span>${date}</span>` : ""}${readTime ? `<span>· ${readTime} min de leitura</span>` : ""}</div>`;

  const cover = post.cover_image ? thumb(cleanImageUrl(post.cover_image)) : "";
  const body = `<nav aria-label="breadcrumb"><ol class="breadcrumb">
  <li class="breadcrumb-item"><a href="/">Início</a></li>
  <li class="breadcrumb-item active" aria-current="page">${esc(post.title)}</li>
</ol></nav>
<article class="post post-single">
  <div class="card border-0 shadow-sm overflow-hidden">
    ${cover ? `<img class="cover-img w-100 post-cover" width="1200" height="675" loading="eager" fetchpriority="high" src="${esc(cover)}" alt="${esc(post.title)}" />` : ""}
    <div class="card-body p-4 p-md-5">
      ${meta}
      <h1 class="h2 mb-4">${esc(post.title)}</h1>
      ${post.summary ? `<div class="post-summary-box text-body-secondary"><strong>Resumo:</strong> ${esc(post.summary)}</div>` : ""}
      <div class="row g-4 layout">
        <div class="col-lg-8 content">${content}</div>
        ${sidebarHtml}
      </div>
      ${relatedHtml(post)}
      ${travelHtml(post)}
      ${whatsappShareHtml(post, canonical)}
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
      jsonld: postJsonLd(post, origin),
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
<div class="d-flex flex-wrap align-items-center gap-2 mb-4">
  <span class="badge rounded-pill text-bg-primary">Destino</span>
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
      robots: filtered.length ? "index, follow" : "noindex, follow",
      jsonld: blogJsonLd(origin),
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
      <button class="btn btn-primary w-100" type="submit" aria-label="Entrar no painel administrativo">Entrar</button>
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
      <button class="btn btn-outline-primary mt-2" type="submit" aria-label="Salvar nova senha de administrador">Salvar nova senha</button>
    </div>
  </form>
</details>
<form class="card border-0 shadow-sm mb-4" method="post" action="${ADMIN_ROOT}/generate">
  <div class="card-body">
    <h2 class="h5 mb-3">Gerar artigo</h2>
    <div class="row g-2">
      <div class="col"><input class="form-control" type="text" name="topic" placeholder="Tema (ex.: Roteiro de 2 dias em Paraty)" required minlength="3" maxlength="200"></div>
      <div class="col-auto"><button class="btn btn-primary" type="submit" aria-label="Gerar novo rascunho de artigo">Gerar rascunho</button></div>
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
  const slug = path.startsWith("/post/") ? path.slice(6) : path.replace(/^\//, "");
  if (!slug) return null;
  return decodeURIComponent(slug.split("/")[0]);
}

async function handleRoute(request, env, ctx, url, path, origin, method) {
  // Rotas antigas/óbvias de painel não existem: 404 para não revelar o painel.
  if (path === "/admin" || path === "/admin/" || path === "/painel" ||
      path === "/painel/" || path === "/dashboard" || path === "/dashboard/") {
    return new Response("Não encontrado", {
      status: 404,
      headers: secured({ "Content-Type": "text/plain; charset=utf-8" }),
    });
  }

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

    // Verificação do Google Search Console via arquivo HTML (apenas arquivo autorizado pelo proprietário)
    const gscFile = (env?.GOOGLE_VERIFICATION_FILE || "").trim();
    if (gscFile && path === `/${gscFile}`) {
      return new Response(`google-site-verification: ${gscFile}\n`, {
        headers: secured({ "Content-Type": "text/plain; charset=utf-8" }),
      });
    }

    // Verificação do IndexNow: o protocolo exige servir /<key>.txt com o texto
    // da chave. A chave vem do env (secret do worker); sem ela, a rota não existe.
    const iKey = (env?.INDEXNOW_KEY || "").trim();
    if (iKey && path === `/${iKey}.txt`) {
      return new Response(iKey, {
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
      let posts = [];
      let links = "";
      try {
        posts = await fetchAllPosts();
        for (const p of posts) {
          const mod = sitemapDate(p.updated_at || p.published_at);
          const modTag = mod ? `<lastmod>${mod}</lastmod>` : "";
          links += `<url><loc>${origin}/post/${esc(p.slug)}/</loc>${modTag}</url>`;
        }
      } catch (e) {
        // sitemap com só páginas estáticas se API indisponível
      }
      const totalPages = Math.max(1, Math.ceil(posts.length / HOME_PAGE_SIZE));
      let paginationLinks = "";
      const homeDate = sitemapDate(posts[0] && (posts[0].updated_at || posts[0].published_at));
      const homeModTag = homeDate ? `<lastmod>${homeDate}</lastmod>` : "";
      for (let i = 2; i <= totalPages; i++) {
        paginationLinks += `<url><loc>${origin}/page/${i}/</loc>${homeModTag}</url>`;
      }
      const tagSet = new Set();
      for (const p of posts) {
        for (const t of (p.tags || [])) {
          const s = String(t).trim();
          if (s) tagSet.add(s);
        }
      }
      let tagLinks = "";
      for (const t of tagSet) {
        tagLinks += `<url><loc>${origin}/tag/${esc(slugTag(t))}/</loc></url>`;
      }
      const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${origin}/</loc>${homeModTag}</url>
  <url><loc>${origin}/sobre</loc></url>
  <url><loc>${origin}/privacidade</loc></url>
${paginationLinks}${links}${tagLinks}</urlset>`;
      return new Response(body, { headers: secured({ "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=86400, s-maxage=86400" }) });
    }

    // Feed RSS 2.0: /feed.xml e /rss.xml
    if (path === "/feed.xml" || path === "/rss.xml") {
      let posts = [];
      try {
        const all = await fetchPosts(50, 0);
        const now = new Date();
        posts = all.filter(p => p.status === "published" && p.published_at && new Date(p.published_at) <= now).slice(0, 30);
      } catch (e) {
        posts = [];
      }
      const items = posts.map(p => {
        const coverUrl = p.cover_image ? cleanImageUrl(p.cover_image) : "";
        const enclosure = coverUrl ? `\n      <enclosure url="${esc(coverUrl)}" length="0" type="image/jpeg" />` : "";
        return `    <item>
      <title>${esc(p.title)}</title>
      <link>${origin}/post/${esc(p.slug)}/</link>
      <guid isPermaLink="true">${origin}/post/${esc(p.slug)}/</guid>
      <description>${esc(p.summary || p.meta_description || "")}</description>${enclosure}
      <pubDate>${p.published_at ? new Date(p.published_at).toUTCString() : new Date().toUTCString()}</pubDate>
    </item>`;
      }).join("\n");
      const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Blog Turismo</title>
    <link>${origin}/</link>
    <description>${DEFAULT_DESC}</description>
    <language>pt-BR</language>
    <atom:link href="${origin}${path}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>`;
      return new Response(rss, { headers: secured({ "Content-Type": "application/xml; charset=utf-8", ...PUB_CACHE }) });
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

    // Paginação da home: /page/<n>/
    if (path.startsWith("/page/")) {
      const n = path.match(/^\/page\/(\d+)\/$/) || path.match(/^\/page\/(\d+)$/);
      if (n) return home(request, origin, parseInt(n[1], 10));
      return new Response("Página não encontrada", {
        status: 404,
        headers: secured({ "Content-Type": "text/plain; charset=utf-8" }),
      });
    }

    // Home (default)
    if (path === "/" || path === "") {
      return home(request, origin);
    }

    // 404 para rotas inexistentes
    return new Response(
      page({
        type: "website",
        title: `Página não encontrada — ${DEFAULT_TITLE}`,
        desc: "A página que você procura não foi encontrada.",
        origin,
        body: `<nav aria-label="breadcrumb" class="mb-4"><ol class="breadcrumb"><li class="breadcrumb-item"><a href="/">Início</a></li><li class="breadcrumb-item active" aria-current="page">404</li></ol></nav>
<div class="text-center py-5">
  <h1 class="h2 mb-3">Página não encontrada (404)</h1>
  <p class="text-body-secondary mb-4">O artigo ou página que você procurou não existe ou mudou de endereço.</p>
  <div class="p-4 not-found-box text-start mx-auto mb-4">
    <h2 class="h6 fw-bold mb-3">Destinos populares que você pode gostar:</h2>
    <ul class="list-unstyled mb-0 d-grid gap-2">
      <li><a class="text-decoration-none" href="/tag/gramado/">🌲 Roteiros em Gramado e Serra Gaúcha</a></li>
      <li><a class="text-decoration-none" href="/tag/rio-de-janeiro/">🏖️ Melhores praias e dicas do Rio de Janeiro</a></li>
      <li><a class="text-decoration-none" href="/tag/fernando-de-noronha/">🐢 Guia prático de Fernando de Noronha</a></li>
    </ul>
  </div>
  <a class="btn btn-primary" href="/">Voltar para o início</a>
</div>`,
        robots: "noindex, follow",
      }),
      { status: 404, headers: secured({ "Content-Type": "text/html; charset=utf-8" }) }
    );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = (env && env.CUSTOM_DOMAIN) ? `https://${env.CUSTOM_DOMAIN}` : url.origin;
    const method = (request.method || "GET").toUpperCase();

    // Cache Edge da Cloudflare para rotas públicas GET
    const CACHE_VERSION = "v5";
    const isAdmin = path === ADMIN_ROOT || path.startsWith(ADMIN_ROOT + "/");
    const isCacheable = method === "GET" && !isAdmin && !path.startsWith("/admin");
    const edgeCache = (typeof caches !== "undefined" && caches && caches.default) ? caches.default : null;
    let cacheKey = null;

    if (isCacheable && edgeCache) {
      try {
        const cacheUrl = new URL(url.toString());
        cacheUrl.searchParams.set("__cv", CACHE_VERSION);
        cacheKey = new Request(cacheUrl.toString(), request);
        const cached = await edgeCache.match(cacheKey);
        if (cached) {
          return cached;
        }
      } catch (_) {}
    }

    const res = await handleRoute(request, env, ctx, url, path, origin, method);

    if (isCacheable && edgeCache && cacheKey && res && res.status === 200) {
      try {
        ctx?.waitUntil?.(edgeCache.put(cacheKey, res.clone()));
      } catch (_) {}
    }
    return res;
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