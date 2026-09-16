// Harness de teste local do Worker (Node >= 24). Sem dependências.
// Roda com: node worker/test-worker.mjs  (na raiz do repo)
import worker, { TRAVEL_AFFILIATES } from "./worker.js";

const SITE = "https://exemplo.workers.dev";

function fakePost(now = new Date().toISOString()) {
  return {
    id: 1,
    title: "Roteiro de 3 Dias em Gramado",
    slug: "roteiro-de-3-dias-em-gramado",
    summary: "O que fazer e onde comer em Gramado.",
    content:
      "## Por que visitar\n\n**Gramado** é linda.\n\n- Ver o Natal Luz\n- Provar fondue\n\n![Natal Luz](https://thumb.wikimedia.org/t1.jpg?utm_source=commons.wikimedia.org)\n\n### Dicas\n\nVeja [mais](https://exemplo.com/outro).\n\n1. Primeiro\n2. Segundo\n\n## Quando ir\n\nA melhor época é no inverno.",
    cover_image: "https://thumb.wikimedia.org/t2.jpg?utm_source=x",
    status: "published",
    published_at: now,
    updated_at: now,
    meta_title: "Roteiro 3 Dias Gramado SEO",
    meta_description: "Descrição SEO do roteiro.",
    tags: ["Gramado", "Serra Gaúcha"],
    category_id: null,
    keywords: ["gramado"],
    kit_recommendations: [
      { name: "Jaqueta corta-vento", note: "pra encarar o vento da serra à noite", query: "jaqueta corta vento" },
      { name: "Mochila de trilha", note: "leve para caminhar nos cânions", query: "mochila de trilha" },
    ],
    created_at: now,
  };
}

const posts = [fakePost(), {
  ...fakePost(),
  id: 2,
  slug: "segundo-rota",
  title: "Segunda Rota",
  cover_image: "https://upload.wikimedia.org/wikipedia/commons/thumb/8/8a/Cidades_2.jpg/1280px-Cidades_2.jpg",
}];

let lastAdminAuth = null;
let lastLoginBody = null;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const opts = init || {};
  if (url.endsWith("/auth/login")) {
    lastAdminAuth = opts?.headers?.Authorization || null;
    lastLoginBody = JSON.parse(opts.body || "{}");
    return jsonResponse({ token: "9999999999.abc", admin: true, expires_in: 86400 });
  }
  if (url.endsWith("/auth/change-password")) {
    lastAdminAuth = opts?.headers?.Authorization || null;
    const body = JSON.parse(opts.body || "{}");
    return body.current_password === "atual" ? jsonResponse(null, 204) : jsonResponse({ detail: "Senha atual inválida" }, 401);
  }
  if (url.endsWith("/posts/1/publish")) {
    lastAdminAuth = opts?.headers?.Authorization || null;
    return jsonResponse(posts[0]);
  }
  if (url.includes("/posts/roteiro-de-3-dias-em-gramado")) {
    return jsonResponse(posts[0]);
  }
  if (url.includes("/posts?status=published")) {
    return jsonResponse(posts);
  }
  return jsonResponse({ error: "not found" }, 404);
};

function jsonResponse(body, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  };
}

let failures = 0;
function check(label, cond) {
  console.log((cond ? "PASS" : "FAIL") + " - " + label);
  if (!cond) failures++;
}

async function run() {
  // Home
  const homeRes = await worker.fetch({ url: SITE + "/" }, {}, {});
  const home = await homeRes.text();
  check("home status 200", homeRes.status === 200);
  check("home lang pt-BR", /<html lang="pt-BR">/.test(home));
  check("home canonical", home.includes('rel="canonical" href="' + SITE + '/"'));
  check("home JSON-LD Blog", home.includes('"@type":"Blog"'));
  check("home JSON-LD script tag", home.includes('type="application/ld+json"'));
  check("home link artigo", home.includes('/post/roteiro-de-3-dias-em-gramado/'));
  check("home skip link", home.includes('Pular para o conteúdo principal'));
  check("home imagem role presentation", /role="presentation"/.test(home));
  check("home hero destaque", home.includes('class="card hero'));
  check("home grade de cards", home.includes('class="row g-4 post-grid"'));
  check("home secao recentes", home.includes('Artigos recentes'));
  check("home link favicon", home.includes('rel="icon"'));
  check("home sem CDN", !home.includes("cdn.jsdelivr.net"));
  check("home sem bootstrap JS", !home.includes("bootstrap.bundle"));
  check("home hero fetchpriority", /fetchpriority="high"/.test(home));
  check("home preload LCP", home.includes('<link rel="preload" as="image" fetchpriority="high"'));
  check("home thumb 960", home.includes("/960px-Cidades_2.jpg"));
  check("home cache-control", (homeRes.headers.get("Cache-Control") || "").includes("max-age=300"));
  check("home sem analytics (token vazio)", !home.includes("cloudflareinsights"));
  const homeCsp = homeRes.headers.get("Content-Security-Policy") || "";
  check("csp baseline", homeCsp.includes("default-src 'self'"));
  check("csp sem cloudflare (token vazio)", !homeCsp.includes("cloudflareinsights"));

  const llmsRes = await worker.fetch({ url: SITE + "/llms.txt" }, {}, {});
  const llms = await llmsRes.text();
  check("llms.txt 200", llmsRes.status === 200);
  check("llms.txt artigos", llms.includes("## Artigos") && llms.includes("/post/roteiro-de-3-dias-em-gramado/"));
  check("llms.txt institucional", llms.includes("/sobre") && llms.includes("/privacidade"));

  const icoRes = await worker.fetch({ url: SITE + "/favicon.svg" }, {}, {});
  const ico = await icoRes.text();
  check("favicon 200", icoRes.status === 200);
  check("favicon svg", ico.includes("<svg") && ico.includes("linearGradient"));
  check("favicon content type", icoRes.headers.get("Content-Type").includes("image/svg+xml"));

  // Post
  const postRes = await worker.fetch(
    { url: SITE + "/post/roteiro-de-3-dias-em-gramado/" },
    {},
    {}
  );
  const post = await postRes.text();
  check("post status 200", postRes.status === 200);
  check("post canonical", post.includes('rel="canonical" href="' + SITE + "/post/roteiro-de-3-dias-em-gramado/\""));
  check("post og:title", post.includes('<meta property="og:title" content="Roteiro de 3 Dias em Gramado">'));
  check("post title SEO", post.includes('<title>Roteiro 3 Dias Gramado SEO</title>'));
  check("post h2", /<h2 id="por-que-visitar">Por que visitar<\/h2>/.test(post));
  check("post strong", /<strong>Gramado<\/strong>/.test(post));
  check("post ul", /<ul><li>Ver o Natal Luz<\/li>/.test(post));
  check("post figure img", /<figure class="img"><img src="https:\/\/thumb\.wikimedia\.org\/t1\.jpg"/.test(post));
  check("post imagem cai query utm", !post.includes("utm_source"));
  check("post JSON-LD BlogPosting", post.includes('"@type":"BlogPosting"'));
  check("post h1", post.includes('<h1 class="h2 mb-4">Roteiro de 3 Dias em Gramado</h1>'));
  check("post volta ao blog", /\<li class="breadcrumb-item"\><a href="\/">Início<\/a>\<\/li\>/.test(post));
  check("post breadcrumb atual", post.includes('aria-current="page">Roteiro de 3 Dias em Gramado</li>'));
  check("post tempo de leitura", /min de leitura/.test(post));
  check("post toc", post.includes('class="card toc'));
  check("post toc ancora h2", post.includes('<h2 id="por-que-visitar">'));
  check("post toc link", post.includes('href="#por-que-visitar"') && post.includes('>Por que visitar</a>'));
  check("post progress bar", post.includes('class="progress"'));
  check("post sem CDN", !post.includes("cdn.jsdelivr.net"));
  check("post cover fetchpriority", /<img class="cover-img w-100 post-cover"[^>]*fetchpriority="high"/.test(post));
  check("post preload", post.includes('<link rel="preload" as="image"'));
  check("post cache-control 1h", (postRes.headers.get("Cache-Control") || "").includes("max-age=3600"));
  check("post layout center stage", post.includes('class="row g-4 layout"'));
  check("post kit afiliado", post.includes('class="kit mt-5"'));
  check("post kit item da IA", post.includes("Jaqueta corta-vento"));
  check("post kit item note", post.includes("encarar o vento da serra"));
  check("post kit tag amazon", post.includes("tag=blogturismo20-20"));
  check("post kit disclosure", post.includes("afiliado da Amazon"));
  check("post kit cta", post.includes("Ver na Amazon"));
  check("post kit sponsored", post.includes('rel="sponsored nofollow noopener"'));
  check("post sem bloco viagem (ids vazios)", !post.includes("Planeje a viagem"));

  // bloco de afiliados de viagem com IDs injetados
  TRAVEL_AFFILIATES.travelpayouts = "123456";
  TRAVEL_AFFILIATES.booking = "7890";
  const postAff = await (await worker.fetch({ url: SITE + "/post/roteiro-de-3-dias-em-gramado/" }, {}, {})).text();
  TRAVEL_AFFILIATES.travelpayouts = "";
  TRAVEL_AFFILIATES.booking = "";
  check("viagem aviasales marker", postAff.includes("aviasales.com/?marker=123456"));
  check("viagem aviasales subid", postAff.includes("subid=roteiro-de-3-dias-em-gramado"));
  check("viagem booking aid", postAff.includes("booking.com/searchresults.html?aid=7890"));
  check("viagem sponsored", postAff.includes('rel="sponsored nofollow noopener"'));

  const tagRes = await worker.fetch({ url: SITE + "/tag/gramado/" }, {}, {});
  const tag = await tagRes.text();
  check("tag status 200", tagRes.status === 200);
  check("tag titulo", tag.includes("Artigos: Gramado"));
  check("tag canonical", tag.includes('rel="canonical" href="' + SITE + "/tag/gramado/\""));

  const emptyTagRes = await worker.fetch({ url: SITE + "/tag/destino/" }, {}, {});
  const emptyTag = await emptyTagRes.text();
  check("tag vazia aviso", emptyTag.includes("Nenhum artigo publicado com essa tag ainda"));

  // 404
  const nfRes = await worker.fetch({ url: SITE + "/post/nao-existe/" }, {}, {});
  check("post inexistente 404", nfRes.status === 404);

  // robots.txt
  const robRes = await worker.fetch({ url: SITE + "/robots.txt" }, {}, {});
  const rob = await robRes.text();
  check("robots user-agent", rob.includes("User-agent: *"));
  check("robots sitemap", rob.includes("Sitemap: " + SITE + "/sitemap.xml"));

  // verificação do Google Search Console (URL prefix / arquivo HTML)
  const gRes = await worker.fetch({ url: SITE + "/googlea1b2c3d4e5f6a7b8.html" }, {}, {});
  const gBody = await gRes.text();
  check("gsc 200", gRes.status === 200);
  check("gsc body", gBody.trim() === "google-site-verification: googlea1b2c3d4e5f6a7b8.html");

  // sitemap.xml
  const smRes = await worker.fetch({ url: SITE + "/sitemap.xml" }, {}, {});
  const sm = await smRes.text();
  check("sitemap xml header", sm.startsWith("<?xml"));
  check("sitemap home loc", sm.includes("<loc>" + SITE + "/</loc>"));
  check("sitemap post loc", sm.includes(`<loc>${SITE}/post/roteiro-de-3-dias-em-gramado/</loc>`));
  check("sitemap lastmod YYYY-MM-DD", /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/.test(sm));
  check("sitemap lastmod sem horario", !/T\d{2}/.test(sm));
  check("sitemap sobre", sm.includes("<loc>" + SITE + "/sobre</loc>"));
  check("sitemap privacidade", sm.includes("<loc>" + SITE + "/privacidade</loc>"));

  // Páginas institucionais
  const sobreRes = await worker.fetch({ url: SITE + "/sobre" }, {}, {});
  const sobre = await sobreRes.text();
  check("sobre 200", sobreRes.status === 200);
  check("sobre autor", sobre.includes("Lucas"));
  check("sobre canonical", sobre.includes('rel="canonical" href="' + SITE + "/sobre\""));

  const privRes = await worker.fetch({ url: SITE + "/privacidade" }, {}, {});
  const priv = await privRes.text();
  check("privacidade 200", privRes.status === 200);
  check("privacidade sem cookies rastreamento", priv.includes("não usa cookies de rastreamento"));
  check("privacidade LGPD", priv.includes("LGPD"));
  check("privacidade afiliado", priv.includes("afiliado"));

  // Painel admin
  const adminNoCookie = await worker.fetch(new Request(SITE + "/admin"), {}, {});
  const adminPage = await adminNoCookie.text();
  check("admin login sem sessao", adminPage.includes('action="/admin/login"'));
  check("admin noindex", adminPage.includes('content="noindex, nofollow"'));
  check("admin login campo usuario", adminPage.includes('name="username"'));

  const loginRes = await worker.fetch(
    new Request(SITE + "/admin/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=teste123",
    }),
    {},
    {}
  );
  check("admin login 302", loginRes.status === 302);
  check("admin login envia usuario", lastLoginBody && lastLoginBody.username === "admin");
  const setCookie = loginRes.headers.get("Set-Cookie") || "";
  check("admin cookie sessao", setCookie.includes("admin_token=") && setCookie.includes("HttpOnly"));

  const dashRes = await worker.fetch(
    new Request(SITE + "/admin", { headers: { Cookie: "admin_token=9999999999.abc" } }),
    {},
    {}
  );
  const dash = await dashRes.text();
  check("admin dashboard gerar", dash.includes("Gerar artigo"));
  check("admin dashboard status", dash.includes("Rascunhos") && dash.includes("Agendados") && dash.includes("Publicados"));
  check("admin mostra post", dash.includes("Roteiro de 3 Dias em Gramado"));
  check("admin dashboard trocar senha", dash.includes("Trocar senha") && dash.includes('action="/admin/senha"'));

  const pubRes = await worker.fetch(
    new Request(SITE + "/admin/publish", {
      method: "POST",
      headers: { Cookie: "admin_token=9999999999.abc", "content-type": "application/x-www-form-urlencoded" },
      body: "id=1",
    }),
    {},
    {}
  );
  check("admin publicar 302", pubRes.status === 302);
  check("admin publicar usa token", lastAdminAuth === "Bearer 9999999999.abc");

  const senhaRes = await worker.fetch(
    new Request(SITE + "/admin/senha", {
      method: "POST",
      headers: { Cookie: "admin_token=9999999999.abc", "content-type": "application/x-www-form-urlencoded" },
      body: "current_password=atual&new_password=novasenha&confirm_password=novasenha",
    }),
    {},
    {}
  );
  check("admin trocar senha 302", senhaRes.status === 302);
  check("admin trocar senha usa token", lastAdminAuth === "Bearer 9999999999.abc");
  check("admin trocar senha mensagem", (senhaRes.headers.get("Location") || "").includes("msg="));

  const senhaErroRes = await worker.fetch(
    new Request(SITE + "/admin/senha", {
      method: "POST",
      headers: { Cookie: "admin_token=9999999999.abc", "content-type": "application/x-www-form-urlencoded" },
      body: "current_password=atual&new_password=novasenha&confirm_password=diferente",
    }),
    {},
    {}
  );
  check("admin trocar senha confere confirmacao", (senhaErroRes.headers.get("Location") || "").includes("erro="));

  const logoutRes = await worker.fetch(new Request(SITE + "/admin/logout", { method: "POST" }), {}, {});
  check("admin logout 302", logoutRes.status === 302);

  process.exit(failures ? 1 : 0);
}

run();