// Harness de teste local do Worker (Node >= 24). Sem dependências.
// Roda com: node worker/test-worker.mjs  (na raiz do repo)
import worker from "./worker.js";

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
    created_at: now,
  };
}

const posts = [fakePost()];

globalThis.fetch = async (input) => {
  const url = String(input);
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
  check("home hero destaque", home.includes('class="hero"'));
  check("home grade de cards", home.includes('class="post-grid"'));
  check("home secao recentes", home.includes('Artigos recentes'));
  check("home link favicon", home.includes('rel="icon"'));

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
  check("post h1", /<h1>Roteiro de 3 Dias em Gramado<\/h1>/.test(post));
  check("post volta ao blog", /<a href="\/">Início<\/a>\s*<span aria-hidden="true">›<\/span>/.test(post));
  check("post breadcrumb atual", post.includes('aria-current="page">Roteiro de 3 Dias em Gramado</span>'));
  check("post tempo de leitura", /min de leitura/.test(post));
  check("post toc", post.includes('class="toc"'));
  check("post toc ancora h2", post.includes('<h2 id="por-que-visitar">'));
  check("post toc link", post.includes('href="#por-que-visitar">Por que visitar</a>'));
  check("post progress bar", post.includes('class="progress"'));
  check("post layout center stage", post.includes('class="layout"'));
  check("post kit afiliado", post.includes('class="kit"'));
  check("post kit tag amazon", post.includes("tag=blogturismo20-20"));
  check("post kit disclosure", post.includes("afiliado da Amazon"));

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

  process.exit(failures ? 1 : 0);
}

run();