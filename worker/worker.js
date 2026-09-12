/**
 * Cloudflare Worker — Site do Blog Turismo IA (Server-Side Rendering)
 *
 * Serve o blog com HTML indexável por crawlers (Google) e por IA (ChatGPT / Facebook / etc.
 * via Open Graph + JSON-LD), sem depender de JavaScript no cliente.
 *
 * COMO USAR:
 *  1. Abra https://dash.cloudflare.com → Workers & Pages → seu Worker.
 *  2. No editor, apague o conteúdo anterior e cole TODAS as linhas deste arquivo.
 *  3. Troque a constante API_BASE_URL abaixo se necessário.
 *  4. Deploy. Pronto: Google/Gerentes de IA já leem o site sem JS.
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

// Guarda só o esquema+host para montar URLs absolutas (canonical / og:url)
// origin fixo de referência (apenas para construir URLs absolutas de schema.org).
// Não usamos window (não existe no Worker).
const SITE_ORIGIN = "https://blog-turismo-api.lucasemmanuel2005.workers.dev";

// Token de verificação do Google Search Console (método "HTML tag").
// Preencher com o content da meta gerada pelo GSC, ex.: "ab12cd34ef56ab78",
// e config para publicar no <head>: <meta name="google-site-verification" content="ab12cd34ef56ab78">
const GOOGLE_SITE_VERIFICATION = "5r8Ci2K7Dr-x1L1pogJ4qXrXxTQHxzURb2w9djRXs0o";

function originOfUrl(u) {
  try {
    const nu = new URL(u);
    return nu.origin;
  } catch {
    return "";
  }
}

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

function mdToHtml(md) {
  if (!md) return "";
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
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
      out.push(`<h${lvl}>${inlineSafe(h[2])}</h${lvl}>`);
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
:root { --bg:#f4f6f9; --card:#fff; --text:#1c2733; --muted:#64748b; --accent:#0e7490; --accent2:#6d28d9; --line:#e2e8f0; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f172a; --card:#1e293b; --text:#e2e8f0; --muted:#94a3b8; --line:#334155; } }
* { box-sizing:border-box; }
body { margin:0; font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--text); line-height:1.65; }
a { color:var(--accent); }
.header { background:linear-gradient(135deg,#0e7490,#6d28d9 75%); color:#fff; padding:48px 20px 56px; text-align:center; }
.header a { color:#fff; text-decoration:none; }
.header h1 { margin:0; font-size:clamp(1.8rem,5vw,2.6rem); }
.container { max-width:820px; margin:-28px auto 60px; padding:0 16px; }
.post { background:var(--card); border:1px solid var(--line); border-radius:16px; box-shadow:0 10px 30px rgba(15,23,42,.08); overflow:hidden; margin-bottom:28px; }
.cover { width:100%; height:260px; object-fit:cover; display:block; background:var(--line); }
.body { padding:22px 24px 24px; }
.category { display:inline-block; background:rgba(14,116,144,.12); color:var(--accent); font-size:.78rem; font-weight:600; text-transform:uppercase; padding:4px 10px; border-radius:999px; margin-bottom:12px; }
.post h2 { margin:0 0 6px; font-size:1.45rem; line-height:1.25; }
.post h2 a { color:inherit; text-decoration:none; }
.post h2 a:hover { text-decoration:underline; }
.post .summary { color:#475569; margin:0 0 18px; }
@media (prefers-color-scheme: dark) { .post .summary { color:#cbd5e1; } }
.btn { display:inline-block; cursor:pointer; font-weight:600; color:#fff; background:linear-gradient(135deg,var(--accent),var(--accent2)); border:0; border-radius:999px; padding:10px 22px; font-size:.92rem; text-decoration:none; }
.btn:hover { filter:brightness(1.08); }
.content h1,.content h2,.content h3 { line-height:1.3; margin:1.6em 0 .5em; }
.content h1 { font-size:2rem; } .content h2 { font-size:1.5rem; } .content h3 { font-size:1.2rem; }
.content p { margin:.75em 0; }
.content .img, .content figure.img { margin:1.4em 0; }
.content img { width:100%; height:auto; aspect-ratio:16/9; object-fit:cover; border-radius:12px; display:block; background:var(--line); }
.content ul, .content ol { padding-left:1.4em; margin:.75em 0; }
.content li { margin:.3em 0; }
.footer { text-align:center; color:var(--muted); font-size:.85em; padding:0 16px 40px; }
.sr { position:absolute; left:-10000px; top:auto; width:1px; height:1px; overflow:hidden; }
code{white-space:pre-wrap;}
</style>
</head>
<body>
<a class="sr" href="#principal">Pular para o conteúdo principal</a>
<header class="header">
  <h1><a href="/">Blog Turismo IA</a></h1>
  <p>Destinos, roteiros e dicas de viagem.</p>
</header>
<main id="principal" class="container">
${t.body}
</main>
<footer class="footer">Conteúdo informativo gerado automaticamente todos os dias. Fotos: Wikimedia Commons.</footer>
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

// ---------- Carrregamento de dados da API ----------

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

async function home(request, origin) {
  let posts = [];
  try {
    posts = await fetchPosts();
  } catch (e) {
    // Fallback: ainda renderiza a página mas com aviso
  }
  const cards = posts.map((p) => {
    const img = p.cover_image ? `<img class="cover" loading="lazy" src="${esc(cleanImageUrl(p.cover_image))}" alt="" role="presentation" />` : "";
    const tag = (p.tags && p.tags[0]) ? esc(p.tags[0]) : "Turismo";
    const date = p.published_at ? new Date(p.published_at).toLocaleDateString("pt-BR") : "";
    return `<article class="post">
      <a href="/post/${esc(p.slug)}/" aria-hidden="true" tabindex="-1">${img}</a>
      <div class="body">
        <span class="category">${tag}</span>
        <h2><a href="/post/${esc(p.slug)}/">${esc(p.title)}</a></h2>
        <p class="summary">${esc(p.summary || "")}</p>
        <div class="meta">${date ? `<time datetime="${esc(p.published_at)}">${date}</time>` : ""}</div>
        <a class="btn" href="/post/${esc(p.slug)}/">Ler artigo completo</a>
      </div>
    </article>`;
  }).join("") || "<p>Nenhum artigo publicado ainda.</p>";

  const body = `<h1 class="sr">Últimos artigos</h1>${cards}`;
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
  const tags = (post.tags || []).map((tag) => `<span class="category">${esc(String(tag).trim())}</span>`).join("");

  const body = `<article class="post">
    <div class="body">
      ${tags || `<span class="category">${esc(post.category || "Turismo")}</span>`}
      <h1 style="font-size:2rem;margin:.3em 0 .2em;">${esc(post.title)}</h1>
      <div class="meta">${date}</div>
      <div class="content">${mdToHtml(post.content)}</div>
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

    // Slug real: /post/<slug>/
    if (path.startsWith("/post/")) {
      const slug = handleSlugUrl(origin, path);
      if (slug) return postPage(request, origin, slug);
    }

    // Home (default)
    return home(request, origin);
  },
};