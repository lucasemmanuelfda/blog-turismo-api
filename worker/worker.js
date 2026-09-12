/**
 * Cloudflare Worker — Site do Blog Turismo IA (Server-Side Rendering)
 *
 * Serve o blog com HTML indexável por crawlers (Google) e por IA (ChatGPT / Facebook / etc.
 * via Open Graph + JSON-LD), sem depender de JavaScript no cliente.
 *
 * Deploy: `wrangler deploy` (ou via GitHub Actions em .github/workflows/deploy-worker.yml).
 */

const API_BASE_URL = "https://blog-turismo-api.onrender.com";

const DEFAULT_TITLE = "Blog Turismo IA";
const DEFAULT_DESC =
  "Destinos, roteiros e dicas de viagem atualizados todos os dias, gerados por IA.";

// ---------- Utilitários ----------

// Headers de segurança aplicados em todas as respostas.
// O site não usa JS nem iframes; script-src 'none' e frame-ancestors 'none' são seguros.
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src * data:; media-src *; style-src 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; upgrade-insecure-requests",
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
        return `<img src="${esc(cleanImageUrl(src))}" alt="${esc(alt || "foto")}" loading="lazy" decoding="async" />`;
      })
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, t, href) => `<a href="${esc(href)}" rel="nofollow noopener">${esc(t)}</a>`);

  while (i < lines.length) {
    const l = lines[i];
    const img = l.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (img) {
      out.push(`<figure class="img"><img src="${esc(cleanImageUrl(img[2]))}" alt="${esc(img[1] || "foto")}" loading="lazy" decoding="async" /></figure>`);
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

// ---------- Layout (template HTML compartilhado) ----------

function page(t) {
  const ogImage =
    cleanImageUrl(t.image) ||
    (t.post && t.post.cover_image ? cleanImageUrl(t.post.cover_image) : "");
  const canonical = t.canonical || t.origin + "/";
  const robotsMeta = t.robots ? `<meta name="robots" content="${t.robots}">` : "";
  const gscMeta = GOOGLE_SITE_VERIFICATION
    ? `<meta name="google-site-verification" content="${esc(GOOGLE_SITE_VERIFICATION)}">`
    : "";
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0f7490">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="shortcut icon" href="/favicon.svg">
${gscMeta}
<title>${esc(t.title)}</title>
<meta name="description" content="${esc(t.desc)}">
<link rel="canonical" href="${esc(canonical)}">
${robotsMeta}
<meta name="robots" content="index, follow">
<meta property="og:type" content="${t.type}">
<meta property="og:site_name" content="Blog Turismo IA">
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
  --bg:#f6f3ee; --card:#fff; --text:#20262e; --muted:#6b7683;
  --accent:#0e7490; --accent2:#6d28d9; --line:#e4e1da;
  --shadow:0 1px 2px rgba(24,32,40,.05), 0 12px 32px -12px rgba(24,32,40,.18);
  --radius:18px;
}
@media (prefers-color-scheme: dark) {
  :root { --bg:#10151c; --card:#182029; --text:#e4ebf2; --muted:#93a0ae; --line:#29323d;
    --shadow:0 1px 2px rgba(0,0,0,.3), 0 14px 36px -14px rgba(0,0,0,.5); }
}
* { box-sizing:border-box; }
html { scroll-behavior:smooth; }
body { margin:0; font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  font-size:16.5px; line-height:1.7; background:var(--bg); color:var(--text);
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; }
::selection { background:rgba(14,116,144,.25); }
a { color:var(--accent); }
:focus-visible { outline:3px solid var(--accent); outline-offset:2px; border-radius:4px; }
.header { position:relative; overflow:hidden; background:linear-gradient(140deg,#0f7490,#54139b 80%);
  color:#fff; padding:56px 20px 64px; text-align:center; }
.header::after { content:""; position:absolute; inset:0; pointer-events:none;
  background:radial-gradient(120% 120% at 80% -20%, rgba(255,255,255,.22), transparent 55%); }
.header h1 { position:relative; margin:0; font-size:clamp(1.9rem,6vw,2.8rem); font-weight:750; letter-spacing:-.5px; line-height:1.15; }
.header h1 a { color:#fff; text-decoration:none; }
.header h1 a:hover { text-decoration:underline; text-underline-offset:4px; }
.header p { position:relative; margin:10px auto 0; max-width:42ch; opacity:.92; font-size:1.06rem; }
.container { max-width:1000px; margin:-34px auto 64px; padding:0 18px; }
.post-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(285px,1fr)); gap:26px; align-items:stretch; }
.post-grid .post { margin:0; height:100%; display:flex; flex-direction:column; }
.post-grid .post .cover { height:200px; }
.post-grid .body { display:flex; flex-direction:column; flex:1; }
.post-grid .more { margin-top:auto; }
.hero { display:grid; grid-template-columns:1fr 1.05fr; margin-bottom:36px; background:var(--card);
  border:1px solid var(--line); border-radius:var(--radius); overflow:hidden; box-shadow:var(--shadow); }
.hero .cover { width:100%; height:100%; min-height:300px; object-fit:cover; }
.hero .body { padding:clamp(22px,4vw,40px); display:flex; flex-direction:column; justify-content:center; gap:16px; }
.hero .tag { align-self:flex-start; }
.hero h2 { margin:0; font-size:clamp(1.6rem,4vw,2.3rem); font-weight:750; line-height:1.15; letter-spacing:-.5px; }
.hero h2 a { color:inherit; text-decoration:none; }
.hero h2 a:hover { color:var(--accent); }
.hero .summary { margin:0; font-size:1.08rem; }
@media (max-width:820px) {
  .hero { grid-template-columns:1fr; }
  .hero .cover { min-height:200px; }
}
.section-title { margin:6px 0 24px; font-size:.82rem; text-transform:uppercase; letter-spacing:.08em;
  color:var(--muted); display:flex; align-items:center; gap:14px; }
.section-title::after { content:""; height:1px; flex:1; background:var(--line); }
.post { background:var(--card); border:1px solid var(--line); border-radius:var(--radius);
  box-shadow:var(--shadow); overflow:hidden; margin-bottom:30px; transition:transform .18s ease, box-shadow .18s ease; }
.post:hover { transform:translateY(-2px); box-shadow:0 2px 4px rgba(24,32,40,.06), 0 18px 40px -14px rgba(24,32,40,.22); }
.cover { width:100%; height:240px; object-fit:cover; display:block; background:var(--line); }
.post:hover .cover { filter:brightness(1.04); }
.body { padding:22px 26px 26px; }
.meta { display:flex; flex-wrap:wrap; align-items:center; gap:10px; font-size:.82rem; color:var(--muted); margin-bottom:12px; }
.tag { display:inline-block; background:rgba(14,116,144,.13); color:var(--accent); font-size:.74rem; font-weight:650; letter-spacing:.06em; text-transform:uppercase; padding:5px 12px; border-radius:999px; }
.post h2 { margin:0 0 8px; font-size:1.42rem; font-weight:720; line-height:1.3; letter-spacing:-.2px; }
.post h2 a { color:inherit; text-decoration:none; }
.post h2 a:hover { color:var(--accent); }
.summary { color:var(--muted); margin:0 0 18px; }
.more { display:inline-flex; align-items:center; gap:6px; font-weight:650; text-decoration:none; }
.more::after { content:"→"; transition:transform .15s ease; }
.more:hover::after { transform:translateX(3px); }
.crumb { margin:0 0 20px; font-size:.92rem; color:var(--muted); }
.crumb a { color:var(--muted); text-decoration:none; }
.crumb a:hover { color:var(--accent); text-decoration:underline; }
.crumb span[aria-current="page"] { color:var(--text); font-weight:650; }
.progress { position:fixed; top:0; left:0; width:100%; height:3px; transform:scaleX(0); transform-origin:0 50%;
  background:linear-gradient(90deg,var(--accent),var(--accent2)); z-index:20; pointer-events:none; }
@supports (animation-timeline: scroll()) {
  .progress { animation:progress-grow linear; animation-timeline:scroll(root); }
}
@keyframes progress-grow { to { transform:scaleX(1); } }
.page-title { margin:0 0 22px; font-size:clamp(1.5rem,4vw,2rem); letter-spacing:-.3px; }
.tag a { color:inherit; text-decoration:none; }
.toc { background:rgba(14,116,144,.06); border:1px solid var(--line); border-radius:14px;
  padding:16px 20px; height:fit-content; }
.toc-title { margin:0 0 8px; font-size:.8rem; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
.toc ol { margin:0; padding-left:1.2em; display:grid; gap:6px; }
.toc a { color:var(--accent); text-decoration:none; }
.toc a:hover { text-decoration:underline; }
.layout { display:grid; gap:30px; margin-top:2px; }
@media (min-width:1024px) {
  .layout { grid-template-columns:minmax(0,1fr) 230px; align-items:start; }
  .content { grid-column:1; grid-row:1; }
  .toc { grid-column:2; grid-row:1; position:sticky; top:88px; margin:0; }
}
.post-single { padding-bottom:10px; }
.post-single .cover { border-radius:var(--radius) var(--radius) 0 0; }
.post-single h1 { margin:.1em 0 .5em; font-size:clamp(1.7rem,4.5vw,2.3rem); line-height:1.22; letter-spacing:-.4px; }
.content { font-size:1.05rem; line-height:1.78; }
.content h1,.content h2,.content h3 { line-height:1.32; margin:1.7em 0 .55em; letter-spacing:-.2px; }
.content h1 { font-size:1.85rem; } .content h2 { font-size:1.42rem; } .content h3 { font-size:1.15rem; }
.content p { margin:.85em 0; }
.content .img, .content figure.img { margin:1.6em 0; }
.content img { width:100%; height:auto; aspect-ratio:16/9; object-fit:cover; border-radius:14px; display:block; background:var(--line); }
.content ul, .content ol { padding-left:1.3em; margin:.85em 0; }
.content li { margin:.35em 0; }
.content strong { font-weight:700; }
code { white-space:pre-wrap; background:rgba(14,116,144,.1); padding:.15em .4em; border-radius:6px; font-size:.9em; }
.kit { margin:2.4em 0 0; }
.kit h2 { font-size:1.28rem; letter-spacing:-.2px; margin:0 0 .3em; }
.kit-disclosure { color:var(--muted); font-size:.85em; line-height:1.6; margin:0 0 1.1em; }
.kit-grid { list-style:none; margin:0; padding:0; display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); }
.kit-card { display:flex; gap:14px; align-items:flex-start; background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:16px; box-shadow:var(--shadow); transition:transform .15s ease, box-shadow .15s ease; }
.kit-card:hover { transform:translateY(-2px); box-shadow:0 8px 24px -10px rgba(24,32,40,.3); }
.kit-num { flex:none; width:26px; height:26px; border-radius:50%; background:var(--accent); color:#fff; font-size:.85rem; font-weight:700; display:grid; place-items:center; }
.kit-info h3 { font-size:1rem; line-height:1.35; margin:0 0 .3em; }
.kit-info h3 a { color:var(--text); text-decoration:none; }
.kit-info p { color:var(--muted); font-size:.87em; line-height:1.55; margin:0 0 .55em; }
.kit-cta { display:inline-block; color:var(--accent); font-size:.85rem; font-weight:600; text-decoration:none; }
.kit-cta:hover { text-decoration:underline; }
.footer { text-align:center; color:var(--muted); font-size:.85em; padding:0 18px 44px; }
.footer a { color:var(--muted); text-decoration:none; border-bottom:1px dotted var(--muted); }
.sr { position:absolute; left:-10000px; top:auto; width:1px; height:1px; overflow:hidden; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation:none !important; transition:none !important; }
  html { scroll-behavior:auto; }
}
</style>
</head>
<body>
<a class="sr" href="#principal">Pular para o conteúdo principal</a>
<div class="progress" aria-hidden="true"></div>
<header class="header">
  <h1><a href="/">Blog Turismo IA</a></h1>
  <p>Destinos, roteiros e dicas de viagem.</p>
</header>
<main id="principal" class="container">
${t.body}
</main>
<footer class="footer"><a href="/">Blog Turismo IA</a> · Conteúdo informativo gerado automaticamente todos os dias. Fotos: Wikimedia Commons.</footer>
</body>
</html>`;
}

// ---------- JSON-LD ----------

function blogJsonLd() {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Blog",
    name: "Blog Turismo IA",
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
    author: { "@type": "Organization", name: "Blog Turismo IA" },
    publisher: { "@type": "Organization", name: "Blog Turismo IA" },
  });
}

// ---------- Carregamento de dados da API ----------

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

// ---------- Roteador (Home e Posts) ----------

// Slug funcional: prefixo até o ponto (a "trilha" nos links preserva o slug completo,
// mas o double slash é reescrito para dentro do path).
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

function slugTag(t) {
  return encodeURIComponent(String(t).toLowerCase().replace(/\s+/g, "-"));
}

function cardsHtml(posts) {
  return posts.map((p) => {
    const img = p.cover_image ? `<img class="cover" loading="lazy" src="${esc(cleanImageUrl(p.cover_image))}" alt="" role="presentation" />` : "";
    const tag = (p.tags && p.tags[0]) ? esc(p.tags[0]) : "Turismo";
    const tagLink = (p.tags && p.tags[0])
      ? `<span class="tag"><a href="/tag/${esc(slugTag(p.tags[0]))}/">${tag}</a></span>`
      : `<span class="tag">${tag}</span>`;
    const date = p.published_at ? `<time datetime="${esc(p.published_at)}">${new Date(p.published_at).toLocaleDateString("pt-BR")}</time>` : "";
    return `<article class="post">
      <a href="/post/${esc(p.slug)}/" aria-hidden="true" tabindex="-1">${img}</a>
      <div class="body">
        <div class="meta">${tagLink}${date ? `<span class="time">${date}</span>` : ""}</div>
        <h2><a href="/post/${esc(p.slug)}/">${esc(p.title)}</a></h2>
        <p class="summary">${esc(p.summary || "")}</p>
        <a class="more" href="/post/${esc(p.slug)}/">Ler artigo completo</a>
      </div>
    </article>`;
  }).join("") || "<p>Nenhum artigo publicado ainda.</p>";
}

async function home(request, origin) {
  let posts = [];
  try {
    posts = await fetchPosts();
  } catch (e) {
    // Fallback: ainda renderiza a página mas com aviso
  }
  let hero = "";
  let grid = posts;
  if (posts[0] && posts[0].cover_image) {
    const p = posts[0];
    hero = `<article class="hero">
      <a href="/post/${esc(p.slug)}/" aria-hidden="true" tabindex="-1"><img class="cover" loading="eager" src="${esc(cleanImageUrl(p.cover_image))}" alt="" role="presentation" /></a>
      <div class="body">
        <span class="tag">${esc((p.tags && p.tags[0]) || "Turismo")}</span>
        <h2><a href="/post/${esc(p.slug)}/">${esc(p.title)}</a></h2>
        <p class="summary">${esc(p.summary || "")}</p>
        <a class="more" href="/post/${esc(p.slug)}/">Ler artigo completo</a>
      </div>
    </article>`;
    grid = posts.slice(1);
  }
  const body = `<h1 class="sr">Últimos artigos</h1>
${hero}
<h2 class="section-title">Artigos recentes</h2>
<div class="post-grid">${cardsHtml(grid)}</div>`;
  return new Response(
    page({
      type: "website",
      title: DEFAULT_TITLE,
      desc: DEFAULT_DESC,
      canonical: origin + "/",
      origin,
      body,
      jsonld: blogJsonLd(),
    }),
    { headers: secured({ "Content-Type": "text/html; charset=utf-8" }) }
  );
}

const AMAZON_TAG = "blogturismo20-20";

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
      return `<li class="kit-card">
      <span class="kit-num" aria-hidden="true">${i + 1}</span>
      <div class="kit-info">
        <h3><a rel="nofollow noopener" href="${url}">${esc(item.name)}</a></h3>
        ${item.note ? `<p>${esc(item.note)}</p>` : ""}
        <a class="kit-cta" rel="nofollow noopener" href="${url}">Ver na Amazon<span aria-hidden="true"> →</span></a>
      </div>
    </li>`;
    })
    .join("");
  return `<section class="kit" aria-label="Kit recomendado para essa viagem">
  <h2>Kit recomendado para essa viagem</h2>
  <p class="kit-disclosure">Alguns links desta página são de afiliado da Amazon. Se você comprar por eles, o blog ganha uma pequena comissão sem custo extra para você.</p>
  <ul class="kit-grid">${items}</ul>
</section>`;
}

async function postPage(request, origin, slug) {
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
    return `<span class="tag"><a href="/tag/${esc(slugTag(t))}/">${esc(t)}</a></span>`;
  }).join("");
  const toc = [];
  const content = mdToHtml(post.content, toc);
  const tocHtml = toc.length >= 2
    ? `<nav class="toc" aria-label="Neste artigo"><p class="toc-title">Neste artigo</p><ol>${toc.map((t) => `<li><a href="#${esc(t.id)}">${esc(t.text)}</a></li>`).join("")}</ol></nav>`
    : "";

  const body = `<nav class="crumb" aria-label="Trilha de navegação"><a href="/">Início</a> <span aria-hidden="true">›</span> <span aria-current="page">${esc(post.title)}</span></nav>
    <article class="post post-single">
      ${post.cover_image ? `<img class="cover" loading="lazy" src="${esc(cleanImageUrl(post.cover_image))}" alt="${esc(post.title)}" />` : ""}
      <div class="body">
        <div class="meta">${tags || `<span class="tag">${esc(post.category || "Turismo")}</span>`}${date ? `<span class="time">${date}</span>` : ""}${readTime ? `<span class="time">· ${readTime} min de leitura</span>` : ""}</div>
        <h1>${esc(post.title)}</h1>
        <div class="layout">
          ${tocHtml}
          <div class="content">${content}</div>
        </div>
        ${kitHtml(post)}
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
      image: post.cover_image,
      post,
      body,
      jsonld: postJsonLd(post),
    }),
    { headers: secured({ "Content-Type": "text/html; charset=utf-8" }) }
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
  const body = `<nav class="crumb" aria-label="Trilha de navegação"><a href="/">Início</a> <span aria-hidden="true">›</span> <span aria-current="page">Artigos: ${esc(prettyTitle)}</span></nav>
    <h1 class="page-title">Artigos: ${esc(prettyTitle)}</h1>
    <div class="post-grid">${filtered.length ? cardsHtml(filtered) : "<p>Nenhum artigo publicado com essa tag ainda.</p>"}</div>`;
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
    { headers: secured({ "Content-Type": "text/html; charset=utf-8" }) }
  );
}

// ---------- Main / Fetch Handler ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = url.origin;

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
      if (slug) return postPage(request, origin, slug);
    }

    // Home (default)
    return home(request, origin);
  },
};