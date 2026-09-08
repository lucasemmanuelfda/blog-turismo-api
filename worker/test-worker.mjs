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
      "## Por que visitar\n\n**Gramado** é linda.\n\n- Ver o Natal Luz\n- Provar fondue\n\n![Natal Luz](https://thumb.wikimedia.org/t1.jpg?utm_source=commons.wikimedia.org)\n\n### Dicas\n\nVeja [mais](https://exemplo.com/outro).\n\n1. Primeiro\n2. Segundo",
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
  check("post h2", /<h2>Por que visitar<\/h2>/.test(post));
  check("post strong", /<strong>Gramado<\/strong>/.test(post));
  check("post ul", /<ul><li>Ver o Natal Luz<\/li>/.test(post));
  check("post figure img", /<figure class="img"><img src="https:\/\/thumb\.wikimedia\.org\/t1\.jpg"/.test(post));
  check("post imagem cai query utm", !post.includes("utm_source"));
  check("post JSON-LD BlogPosting", post.includes('"@type":"BlogPosting"'));
  check("post h1", /<h1 style="font-size:2rem/.test(post));

  // 404
  const nfRes = await worker.fetch({ url: SITE + "/post/nao-existe/" }, {}, {});
  check("post inexistente 404", nfRes.status === 404);

  // robots.txt
  const robRes = await worker.fetch({ url: SITE + "/robots.txt" }, {}, {});
  const rob = await robRes.text();
  check("robots user-agent", rob.includes("User-agent: *"));
  check("robots sitemap", rob.includes("Sitemap: " + SITE + "/sitemap.xml"));

  // sitemap.xml
  const smRes = await worker.fetch({ url: SITE + "/sitemap.xml" }, {}, {});
  const sm = await smRes.text();
  check("sitemap xml header", sm.startsWith("<?xml"));
  check("sitemap home loc", sm.includes("<loc>" + SITE + "/</loc>"));
  check("sitemap post loc", sm.includes(`<loc>${SITE}/post/roteiro-de-3-dias-em-gramado/</loc>`));

  process.exit(failures ? 1 : 0);
}

run();