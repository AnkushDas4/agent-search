import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSite } from "api-anything";
import { GET as vercelGet, POST as vercelPost } from "../api/index.js";
import { createApp } from "../src/app.js";
import { SearchCache } from "../src/cache.js";
import { callCatalogOperation, listCatalog } from "../src/catalog.js";
import {
  fanOutSearchEngines,
  parseArxivHtml,
  parseDdgLiteHtml,
  parseGoogleNewsRss,
  parseMarginaliaJson,
  parseRssItems,
  parseSedniumRssAndFilter,
  parseSemanticScholarJson,
  parseStackExchangeJson,
  selectSedniumFeedPaths,
} from "../src/search/engines.js";
import { canonicalizeUrlForDedup, rankAndDeduplicateResults, unwrapResultUrl } from "../src/search/normalize.js";

const DDG_LITE_HTML = `<!DOCTYPE html>
<html><body>
  <table>
    <tr><td>1.</td><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fhono.dev%2Fdocs%2F">Hono - Ultrafast web framework</a></td></tr>
    <tr><td></td><td class="result-snippet">Hono is a small, simple, and ultrafast web framework for the Edges.</td></tr>
    <tr class="result-sponsored"><td>Ad</td><td><a class="result-link" href="https://ads.example.com">Sponsored Result</a></td></tr>
    <tr class="result-sponsored"><td></td><td class="result-snippet">Should be skipped.</td></tr>
    <tr><td>2.</td><td><a class="result-link" href="https://github.com/honojs/hono">honojs/hono - GitHub</a></td></tr>
    <tr><td></td><td class="result-snippet">Web framework built on Web Standards.</td></tr>
  </table>
</body></html>`;

const MARGINALIA_JSON = {
  license: "CC BY-NC-SA 4.0",
  query: "hono",
  results: [
    {
      url: "https://hono.dev/docs/",
      title: "Hono Docs (Marginalia)",
      description: "Independent index description of Hono web framework.",
    },
    {
      url: "https://modelcontextprotocol.io/introduction",
      title: "Model Context Protocol",
      description: "Open protocol standardizing context for LLMs.",
    },
  ],
};

const STACKEXCHANGE_JSON = {
  items: [
    {
      title: "How to deploy &quot;Hono&quot; with Node.js &amp; TypeScript?",
      link: "https://stackoverflow.com/questions/78000001/deploy-hono-typescript",
      score: 42,
      is_answered: true,
      tags: ["typescript", "hono"],
    },
    {
      title: "Hono middleware error handling best practices",
      link: "https://stackoverflow.com/questions/78000002/hono-middleware",
      score: 19,
      is_answered: false,
      tags: ["node.js", "hono"],
    },
  ],
};

const SEMANTIC_SCHOLAR_JSON = {
  total: 2,
  data: [
    {
      paperId: "204e3073870fae3d05bcbc2f6a8e263d9b72e776",
      title: "Attention Is All You Need",
      url: "https://www.semanticscholar.org/paper/204e3073870fae3d05bcbc2f6a8e263d9b72e776",
      abstract: "We propose a new simple network architecture, the Transformer, based solely on attention mechanisms.",
      year: 2017,
    },
    {
      paperId: "abc123456789",
      title: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks",
      abstract: "RAG models combine parametric and non-parametric memory for language generation.",
      year: 2020,
    },
  ],
};

const SEDNIUM_MAIN_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Sednium News</title>
  <item>
    <title>Global AI Standards Summit Opens in Geneva</title>
    <link>https://news.sednium.com/story/global-ai-summit</link>
    <pubDate>Thu, 13 Nov 2026 07:30:00 GMT</pubDate>
    <description><![CDATA[<p>Regulators and engineers discuss open agent protocols.</p>]]></description>
  </item>
  <item>
    <title>Hono Edge Benchmarks Released</title>
    <link>https://news.sednium.com/story/hono-benchmarks</link>
    <pubDate>Thu, 13 Nov 2026 06:00:00 GMT</pubDate>
    <description>New benchmarks highlight low-latency TypeScript routing.</description>
  </item>
</channel></rss>`;

const SEDNIUM_INDIA_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Sednium India</title>
  <item>
    <title>Kolkata and Asansol Corridor Sees New Tech Hub Investment</title>
    <link>https://news.sednium.com/story/bengal-tech-hub</link>
    <pubDate>Thu, 13 Nov 2026 08:15:00 GMT</pubDate>
    <description>West Bengal announces industrial and digital infrastructure expansion.</description>
  </item>
</channel></rss>`;

const SEDNIUM_TECH_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Sednium Technology</title>
  <item>
    <title>Hono 4.x Adopts Web Standards Streamable MCP Patterns</title>
    <link>https://news.sednium.com/tech/hono-mcp</link>
    <pubDate>Thu, 13 Nov 2026 09:00:00 GMT</pubDate>
    <description>Lightweight TypeScript server frameworks accelerate edge tooling.</description>
  </item>
</channel></rss>`;

const SEDNIUM_SCIENCE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Sednium Science</title>
  <item>
    <title>Sparse Transformers Lower Memory Overhead in Long-Context Models</title>
    <link>https://news.sednium.com/science/sparse-transformers</link>
    <pubDate>Thu, 13 Nov 2026 08:45:00 GMT</pubDate>
    <description>Researchers demonstrate efficient attention scaling for multi-step reasoning.</description>
  </item>
</channel></rss>`;

const GOOGLE_NEWS_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Google News</title>
  <item>
    <title>Bengal Tech Corridor Expands - Reuters</title>
    <link>https://news.google.com/rss/articles/CBMiWWh0dHBzOi8vZXhhbXBsZS5jb20vYmVuZ2Fs?oc=5</link>
    <pubDate>Thu, 13 Nov 2026 08:20:00 GMT</pubDate>
    <source url="https://www.reuters.com">Reuters</source>
    <description>&lt;a href="https://news.google.com/rss/articles/..."&gt;Bengal Tech Corridor Expands&lt;/a&gt;</description>
  </item>
  <item>
    <title>Global AI Standards Summit - AP News</title>
    <link>https://news.sednium.com/story/global-ai-summit?utm_source=gnews</link>
    <pubDate>Thu, 13 Nov 2026 07:45:00 GMT</pubDate>
    <source url="https://apnews.com">AP News</source>
  </item>
</channel></rss>`;

const ARXIV_HTML = `<!DOCTYPE html>
<html><body>
  <ol class="breathe-horizontal">
    <li class="arxiv-result">
      <div class="is-marginless">
        <p class="list-title is-inline-block">
          <a href="https://arxiv.org/abs/1706.03762">arXiv:1706.03762</a>
          <span>[<a href="https://arxiv.org/pdf/1706.03762">pdf</a>]</span>
        </p>
      </div>
      <p class="title is-5 mathjax">
        Attention Is All You Need
      </p>
      <p class="abstract mathjax">
        <span class="abstract-short has-text-grey-dark mathjax">
          The dominant sequence transduction models are based on complex recurrent networks… ▽ More
        </span>
        <span class="abstract-full has-text-grey-dark mathjax">
          The dominant sequence transduction models are based on complex recurrent or convolutional neural networks. △ Less
        </span>
      </p>
    </li>
    <li class="arxiv-result">
      <div class="is-marginless">
        <p class="list-title is-inline-block">
          <a href="/abs/2401.01234">arXiv:2401.01234</a>
        </p>
      </div>
      <p class="title is-5 mathjax">Retrieval Augmented Agents</p>
      <p class="abstract mathjax">
        <span class="abstract-short has-text-grey-dark mathjax">
          Agents combining search and extraction achieve higher accuracy. ▽ More
        </span>
      </p>
    </li>
  </ol>
</body></html>`;

const ARTICLE_HTML = (title: string, body: string, links: string[] = []) => `<!DOCTYPE html>
<html lang="en">
<head><title>${title}</title></head>
<body>
  <header><nav><a href="/ignore-nav">Nav</a></nav></header>
  <main>
    <article>
      <h1>${title}</h1>
      <p>${body}</p>
      <p>Additional technical paragraph explaining architecture, concurrency limits, and clean HTML-to-Markdown extraction with Mozilla Readability and Turndown.</p>
      ${links.map((l) => `<p><a href="${l}">Link to ${l}</a></p>`).join("\n")}
    </article>
  </main>
  <footer>Copyright Example</footer>
</body>
</html>`;

interface MockFetchOptions {
  ddg202Once?: boolean;
  marginaliaStatus?: number;
  sedniumError?: boolean;
  onMarginaliaHeaders?: (headers: Headers) => void;
}

function createMockFetch(options: MockFetchOptions = {}): typeof fetch {
  let ddgCount = 0;
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.startsWith("https://lite.duckduckgo.com/lite/")) {
      ddgCount++;
      if (options.ddg202Once && ddgCount === 1 && (init?.method ?? "GET") === "GET") {
        return new Response("<html><body>anomaly challenge</body></html>", {
          status: 202,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response(DDG_LITE_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.startsWith("https://api2.marginalia-search.com/search")) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      options.onMarginaliaHeaders?.(headers);
      if (options.marginaliaStatus) {
        return new Response("Rate Limited", { status: options.marginaliaStatus });
      }
      return new Response(JSON.stringify(MARGINALIA_JSON), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.includes("/rss/india")) {
      if (options.sedniumError) throw new Error("Simulated Sednium network error");
      return new Response(SEDNIUM_INDIA_RSS, { status: 200, headers: { "content-type": "application/rss+xml" } });
    }
    if (url.includes("/rss/technology")) {
      if (options.sedniumError) return new Response("Upstream Down", { status: 502 });
      return new Response(SEDNIUM_TECH_RSS, { status: 200, headers: { "content-type": "application/rss+xml" } });
    }
    if (url.includes("/rss/science")) {
      if (options.sedniumError) return new Response("Upstream Down", { status: 502 });
      return new Response(SEDNIUM_SCIENCE_RSS, { status: 200, headers: { "content-type": "application/rss+xml" } });
    }
    if (url.endsWith("/rss") || url.includes("/rss/world") || url.includes("/rss/business")) {
      if (options.sedniumError) return new Response("Upstream Down", { status: 503 });
      return new Response(SEDNIUM_MAIN_RSS, { status: 200, headers: { "content-type": "application/rss+xml" } });
    }

    if (url.startsWith("https://news.google.com/rss/search")) {
      return new Response(GOOGLE_NEWS_RSS, { status: 200, headers: { "content-type": "application/rss+xml" } });
    }

    if (url.startsWith("https://api.stackexchange.com/2.3/search/advanced")) {
      return new Response(JSON.stringify(STACKEXCHANGE_JSON), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.startsWith("https://api.semanticscholar.org/graph/v1/paper/search")) {
      return new Response(JSON.stringify(SEMANTIC_SCHOLAR_JSON), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.startsWith("https://arxiv.org/search/")) {
      return new Response(ARXIV_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.startsWith("https://arxiv.org/abs/")) {
      return new Response(
        ARTICLE_HTML("Attention Is All You Need", "Transformer sequence transduction architecture paper on arXiv."),
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    if (url.startsWith("https://en.wikipedia.org/w/")) {
      return new Response(
        JSON.stringify({
          query: {
            search: [
              { title: "Web framework", snippet: "Software framework designed to support web applications." },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.startsWith("https://api.github.com/search/repositories")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              full_name: "honojs/hono",
              html_url: "https://github.com/honojs/hono",
              description: "Web framework built on Web Standards",
              stargazers_count: 32000,
              language: "TypeScript",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.startsWith("https://hn.algolia.com/api/v1/")) {
      return new Response(
        JSON.stringify({
          hits: [
            {
              objectID: "42000",
              title: "Show HN: Hono Web Framework",
              url: "https://hono.dev/docs/",
              points: 250,
              num_comments: 42,
              author: "yusukebe",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.startsWith("https://hono.dev/docs/")) {
      return new Response(
        ARTICLE_HTML(
          "Hono Documentation",
          "Hono is an ultrafast web framework built on Web Standards supporting Node.js, Vercel, and Cloudflare Workers.",
          ["/docs/getting-started", "https://external.example.com/out"],
        ),
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    if (url.startsWith("https://hono.dev/docs/getting-started")) {
      return new Response(
        ARTICLE_HTML(
          "Getting Started with Hono",
          "Install hono and @hono/node-server to run a standalone server or export handle(app) for Vercel.",
          ["/blog/release"],
        ),
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    if (url.startsWith("https://hono.dev/blog/release")) {
      return new Response(
        ARTICLE_HTML("Hono Blog Release", "Should be excluded when include_paths=['/docs']."),
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    if (url.startsWith("https://github.com/honojs/hono")) {
      return new Response(
        ARTICLE_HTML(
          "honojs/hono Repository",
          "Fast, lightweight, Web-standards web framework repository on GitHub.",
        ),
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    if (url.startsWith("https://modelcontextprotocol.io/")) {
      return new Response(
        ARTICLE_HTML(
          "Model Context Protocol",
          "Streamable HTTP transport enables stateless MCP deployments over standard HTTP POST.",
        ),
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    if (url.startsWith("https://broken.example.com/")) {
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    }

    return new Response("Not Found", { status: 404, statusText: "Not Found" });
  };
}

test("site specs in ./sites/ validate cleanly and dead startpage/qwant specs are removed", () => {
  assert.equal(existsSync(path.resolve("sites", "startpage.json")), false);
  assert.equal(existsSync(path.resolve("sites", "qwant.json")), false);

  for (const name of ["ddg-lite", "marginalia", "arxiv"]) {
    const raw = JSON.parse(readFileSync(path.resolve("sites", `${name}.json`), "utf8"));
    const site = parseSite(raw);
    assert.equal(site.name, name);
    assert.ok(site.operations.every((op) => op.readOnly && op.minTier === 1));
  }

  const arxivSite = parseSite(JSON.parse(readFileSync(path.resolve("sites", "arxiv.json"), "utf8")));
  const arxivOps = arxivSite.operations.map((o) => o.name);
  for (const expected of ["search", "getPaper", "listNew", "listRecent", "searchPapers"]) {
    assert.ok(arxivOps.includes(expected), `missing arxiv op ${expected}`);
  }
});

test("provider parsers extract RSS, JSON, HTML items and unwrap redirect URLs", () => {
  const ddg = parseDdgLiteHtml(DDG_LITE_HTML);
  assert.equal(ddg.length, 2);
  assert.equal(ddg[0]?.url, "https://hono.dev/docs/");

  const marginalia = parseMarginaliaJson(MARGINALIA_JSON);
  assert.equal(marginalia.length, 2);
  assert.equal(marginalia[0]?.title, "Hono Docs (Marginalia)");

  const rssItems = parseRssItems(SEDNIUM_MAIN_RSS);
  assert.equal(rssItems.length, 2);
  assert.equal(rssItems[0]?.link, "https://news.sednium.com/story/global-ai-summit");
  assert.equal(rssItems[0]?.description, "Regulators and engineers discuss open agent protocols.");

  // Sednium routing + query matching + broad fallback
  assert.deepEqual(selectSedniumFeedPaths("Bengal economy update", "news"), ["/rss", "/rss/india", "/rss/business"]);
  assert.deepEqual(selectSedniumFeedPaths("world geopolitics", "news"), ["/rss", "/rss/world"]);
  assert.deepEqual(selectSedniumFeedPaths("hono", "code"), ["/rss/technology"]);
  assert.deepEqual(selectSedniumFeedPaths("transformers", "research"), ["/rss/science"]);

  const matchedSednium = parseSedniumRssAndFilter(
    [{ path: "/rss", xml: SEDNIUM_MAIN_RSS }, { path: "/rss/india", xml: SEDNIUM_INDIA_RSS }],
    "Bengal tech hub",
  );
  assert.equal(matchedSednium.length, 1);
  assert.equal(matchedSednium[0]?.url, "https://news.sednium.com/story/bengal-tech-hub");

  const broadSednium = parseSedniumRssAndFilter(
    [{ path: "/rss", xml: SEDNIUM_MAIN_RSS }, { path: "/rss/india", xml: SEDNIUM_INDIA_RSS }],
    "india news",
  );
  assert.equal(broadSednium.length, 3);
  assert.equal(broadSednium[0]?.url, "https://news.sednium.com/story/bengal-tech-hub");

  const gnews = parseGoogleNewsRss(GOOGLE_NEWS_RSS);
  assert.equal(gnews.length, 2);
  assert.match(gnews[0]?.snippet ?? "", /Reuters/);

  const stack = parseStackExchangeJson(STACKEXCHANGE_JSON);
  assert.equal(stack.length, 2);
  assert.equal(stack[0]?.title, 'How to deploy "Hono" with Node.js & TypeScript?');
  assert.match(stack[0]?.snippet ?? "", /score: 42 · answered/);

  const s2 = parseSemanticScholarJson(SEMANTIC_SCHOLAR_JSON);
  assert.equal(s2.length, 2);
  assert.equal(s2[0]?.title, "Attention Is All You Need");
  assert.match(s2[0]?.snippet ?? "", /^\[2017\]/);
  assert.equal(s2[1]?.url, "https://www.semanticscholar.org/paper/abc123456789");

  const arxiv = parseArxivHtml(ARXIV_HTML);
  assert.equal(arxiv.length, 2);
  assert.equal(arxiv[0]?.url, "https://arxiv.org/abs/1706.03762");
  assert.ok(!(arxiv[0]?.snippet ?? "").includes("Less"));
  assert.equal(arxiv[1]?.url, "https://arxiv.org/abs/2401.01234");
  assert.ok(!(arxiv[1]?.snippet ?? "").includes("More"));

  assert.equal(
    unwrapResultUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fabc"),
    "https://example.com/abc",
  );
  assert.equal(unwrapResultUrl("https://duckduckgo.com/y.js?ad=1"), null);
  assert.equal(
    canonicalizeUrlForDedup("https://www.hono.dev/docs/?utm_source=gnews#top"),
    "https://hono.dev/docs",
  );
});

test("multi-engine ranking boosts consensus URLs and respects domain filters", () => {
  const ranked = rankAndDeduplicateResults(
    [
      {
        source: "sednium-news",
        items: [
          {
            title: "Global AI Standards Summit",
            url: "https://news.sednium.com/story/global-ai-summit",
            snippet: "Regulators and engineers discuss open agent protocols.",
            source: "sednium-news",
          },
          {
            title: "Local Update",
            url: "https://news.sednium.com/story/local",
            snippet: "Local item",
            source: "sednium-news",
          },
        ],
      },
      {
        source: "google-news-rss",
        items: [
          {
            title: "Other Story",
            url: "https://example.com/other",
            snippet: "Other",
            source: "google-news-rss",
          },
          {
            title: "Global AI Standards Summit - AP News",
            url: "https://news.sednium.com/story/global-ai-summit?utm_source=gnews",
            snippet: "AP News",
            source: "google-news-rss",
          },
        ],
      },
    ],
    { maxResults: 10 },
  );

  assert.equal(ranked[0]?.url, "https://news.sednium.com/story/global-ai-summit");
  assert.equal(ranked[0]?.source, "sednium-news, google-news-rss");

  const filtered = rankAndDeduplicateResults(
    [
      {
        source: "ddg-lite",
        items: [
          { title: "Hono", url: "https://hono.dev/docs/", snippet: "", source: "ddg-lite" },
          { title: "GitHub", url: "https://github.com/honojs/hono", snippet: "", source: "ddg-lite" },
        ],
      },
    ],
    { includeDomains: ["github.com"], maxResults: 10 },
  );
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.url, "https://github.com/honojs/hono");
});

test("fanOutSearchEngines routes general, code, news, and research topics and handles errors gracefully", async () => {
  const testHome = mkdtempSync(path.join(os.tmpdir(), "agent-search-fanout-"));
  const prevHome = process.env.API_ANYTHING_HOME;
  const prevMargKey = process.env.MARGINALIA_API_KEY;
  const prevSednium = process.env.SEDNIUM_NEWS_BASE_URL;
  process.env.API_ANYTHING_HOME = testHome;
  process.env.MARGINALIA_API_KEY = "custom-marg-key";
  process.env.SEDNIUM_NEWS_BASE_URL = "https://custom-sednium.example.org";

  try {
    let seenMarginaliaKey: string | null = null;
    const mockFetch = createMockFetch({
      ddg202Once: true,
      onMarginaliaHeaders: (h) => {
        seenMarginaliaKey = h.get("API-Key");
      },
    });

    const generalBatches = await fanOutSearchEngines("hono", "general", { fetchImpl: mockFetch });
    const byGeneral = Object.fromEntries(generalBatches.map((b) => [b.source, b.items]));
    assert.deepEqual(Object.keys(byGeneral).sort(), ["ddg-lite", "marginalia", "wikipedia"]);
    assert.equal(byGeneral["ddg-lite"]?.length, 2);
    assert.equal(byGeneral.marginalia?.length, 2);
    assert.equal(byGeneral.wikipedia?.length, 1);
    assert.equal(seenMarginaliaKey, "custom-marg-key");

    // Rate-limited Marginalia (HTTP 429 & 503) returns empty without breaking other engines
    for (const status of [429, 503]) {
      const degradedFetch = createMockFetch({ marginaliaStatus: status });
      const degradedBatches = await fanOutSearchEngines("hono", "general", { fetchImpl: degradedFetch });
      const byDegraded = Object.fromEntries(degradedBatches.map((b) => [b.source, b.items]));
      assert.equal(byDegraded.marginalia?.length, 0);
      assert.equal(byDegraded["ddg-lite"]?.length, 2);
    }

    const codeBatches = await fanOutSearchEngines("hono", "code", { fetchImpl: mockFetch });
    const byCode = Object.fromEntries(codeBatches.map((b) => [b.source, b.items]));
    assert.deepEqual(
      Object.keys(byCode).sort(),
      ["ddg-lite", "github", "hacker-news", "sednium-news", "stackexchange"],
    );
    assert.equal(byCode.github?.length, 1);
    assert.equal(byCode.stackexchange?.length, 2);
    assert.equal(byCode["hacker-news"]?.length, 1);
    assert.equal(byCode["ddg-lite"]?.length, 2);
    assert.equal(byCode["sednium-news"]?.length, 1);

    const newsBatches = await fanOutSearchEngines("Bengal tech hub", "news", { fetchImpl: mockFetch });
    const byNews = Object.fromEntries(newsBatches.map((b) => [b.source, b.items]));
    assert.deepEqual(
      Object.keys(byNews).sort(),
      ["ddg-lite", "google-news-rss", "hacker-news", "sednium-news"],
    );
    assert.equal(byNews["sednium-news"]?.length, 1);
    assert.equal(byNews["google-news-rss"]?.length, 2);
    assert.equal(byNews["hacker-news"]?.length, 1);
    assert.equal(byNews["ddg-lite"]?.length, 2);

    // Sednium failure falls back cleanly to [] without crashing topic="news"
    const sedniumBrokenFetch = createMockFetch({ sedniumError: true });
    const newsFallback = await fanOutSearchEngines("latest news", "news", { fetchImpl: sedniumBrokenFetch });
    const byNewsFallback = Object.fromEntries(newsFallback.map((b) => [b.source, b.items]));
    assert.equal(byNewsFallback["sednium-news"]?.length, 0);
    assert.equal(byNewsFallback["google-news-rss"]?.length, 2);

    const researchBatches = await fanOutSearchEngines("attention transformers", "research", {
      fetchImpl: mockFetch,
    });
    const byResearch = Object.fromEntries(researchBatches.map((b) => [b.source, b.items]));
    assert.deepEqual(
      Object.keys(byResearch).sort(),
      ["arxiv", "sednium-news", "semantic-scholar", "wikipedia"],
    );
    assert.equal(byResearch["semantic-scholar"]?.length, 2);
    assert.equal(byResearch.arxiv?.length, 2);
    assert.equal(byResearch.wikipedia?.length, 1);
    assert.equal(byResearch["sednium-news"]?.length, 1);
  } finally {
    if (prevHome === undefined) delete process.env.API_ANYTHING_HOME;
    else process.env.API_ANYTHING_HOME = prevHome;
    if (prevMargKey === undefined) delete process.env.MARGINALIA_API_KEY;
    else process.env.MARGINALIA_API_KEY = prevMargKey;
    if (prevSednium === undefined) delete process.env.SEDNIUM_NEWS_BASE_URL;
    else process.env.SEDNIUM_NEWS_BASE_URL = prevSednium;
    rmSync(testHome, { recursive: true, force: true });
  }
});

test("api-anything catalog exposes 114+ sites and pins execution to maxTier 1", async () => {
  const testHome = mkdtempSync(path.join(os.tmpdir(), "agent-search-cat-"));
  const prevHome = process.env.API_ANYTHING_HOME;
  process.env.API_ANYTHING_HOME = testHome;
  try {
    const full = listCatalog();
    assert.ok(full.total_sites >= 114, `expected >= 114 sites, got ${full.total_sites}`);
    assert.ok(full.total_operations >= 300);

    const arxivOnly = listCatalog({ site: "arxiv" });
    assert.equal(arxivOnly.total_sites, 1);
    const arxivOps = arxivOnly.sites[0]?.operations.map((o) => o.operation) ?? [];
    for (const op of ["search", "getPaper", "searchPapers"]) {
      assert.ok(arxivOps.includes(op));
    }

    const callRes = await callCatalogOperation(
      { site: "marginalia", operation: "search", params: { query: "hono" } },
      { fetchImpl: createMockFetch() },
    );
    assert.equal(callRes.ok, true);
    assert.ok(Array.isArray(callRes.data));

    // Bundled minTier: 2 operation must be refused when pinned to maxTier: 1
    const tierBlocked = await callCatalogOperation(
      { site: "courtlistener", operation: "searchOpinions", params: { q: "copyright" } },
      { fetchImpl: createMockFetch() },
    );
    assert.equal(tierBlocked.ok, false);
    assert.equal(tierBlocked.class, "blocked");
    assert.match(tierBlocked.reason ?? "", /capped at 1/);
  } finally {
    if (prevHome === undefined) delete process.env.API_ANYTHING_HOME;
    else process.env.API_ANYTHING_HOME = prevHome;
    rmSync(testHome, { recursive: true, force: true });
  }
});

test("SearchCache supports LRU eviction, TTL expiration, and persistent JSON disk cache", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-search-cache-test-"));
  try {
    const cache1 = new SearchCache({ maxEntries: 2, ttlMs: 60_000, persistentDir: dir });
    cache1.set("k1", { v: 1 });
    cache1.set("k2", { v: 2 });
    assert.deepEqual(cache1.get("k1"), { v: 1 });
    cache1.set("k3", { v: 3 });
    assert.deepEqual(cache1.get("k3"), { v: 3 });

    const cache2 = new SearchCache({ maxEntries: 2, ttlMs: 60_000, persistentDir: dir });
    assert.equal(cache2.getStats().backend, "disk+memory");
    assert.deepEqual(cache2.get("k1"), { v: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("REST API routes: /, /health, /openapi.json, /v1/search, /v1/extract, /v1/crawl, /v1/research, /v1/catalog, and auth", async () => {
  const testAaHome = mkdtempSync(path.join(os.tmpdir(), "agent-search-aa-"));
  const prevHome = process.env.API_ANYTHING_HOME;
  process.env.API_ANYTHING_HOME = testAaHome;
  try {
    const cache = new SearchCache({ maxEntries: 64, ttlMs: 60_000 });
    const app = createApp({ cache, fetchImpl: createMockFetch() });

    // Web UI
    const uiRes = await app.request("/");
    assert.equal(uiRes.status, 200);
    const html = await uiRes.text();
    assert.match(html, /#09090b/);
    assert.match(html, /#06b6d4/);
    assert.match(html, /<option value="research">research<\/option>/);
    assert.match(html, /\/v1\/catalog/);
    assert.match(html, /sednium-news, google-news-rss, semantic-scholar, arxiv/);
    const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(scriptMatch?.[1], "expected inline script in playground HTML");
    assert.doesNotThrow(() => new Function(scriptMatch[1]!));

    // Health & OpenAPI
    const healthRes = await app.request("/health");
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as { status: string; providers: Array<{ name: string }> };
    assert.equal(health.status, "ok");
    const providerNames = health.providers.map((p) => p.name);
    for (const expected of [
      "ddg-lite",
      "marginalia",
      "wikipedia",
      "github",
      "stackexchange",
      "hacker-news",
      "sednium-news",
      "google-news-rss",
      "semantic-scholar",
      "arxiv",
    ]) {
      assert.ok(providerNames.includes(expected), `missing provider ${expected}`);
    }

    const openApiRes = await app.request("/openapi.json");
    assert.equal(openApiRes.status, 200);
    const openApi = (await openApiRes.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { schemas: { SearchRequest: { properties: { topic: { enum: string[] } } } } };
    };
    assert.equal(openApi.openapi, "3.1.0");
    for (const p of ["/v1/search", "/v1/catalog", "/v1/catalog/call", "/mcp"]) {
      assert.ok(p in openApi.paths, `missing OpenAPI path ${p}`);
    }
    assert.deepEqual(
      openApi.components.schemas.SearchRequest.properties.topic.enum,
      ["general", "news", "code", "research"],
    );

    // GET /v1/catalog & POST /v1/catalog/call
    const catalogRes = await app.request("/v1/catalog");
    assert.equal(catalogRes.status, 200);
    const catalogJson = (await catalogRes.json()) as { total_sites: number; total_operations: number };
    assert.ok(catalogJson.total_sites >= 114);
    assert.ok(catalogJson.total_operations >= 300);

    const catalogFilterRes = await app.request("/v1/catalog?site=marginalia");
    assert.equal(catalogFilterRes.status, 200);
    const catalogFilterJson = (await catalogFilterRes.json()) as {
      total_sites: number;
      sites: Array<{ site: string; operations: Array<{ operation: string }> }>;
    };
    assert.equal(catalogFilterJson.total_sites, 1);
    assert.equal(catalogFilterJson.sites[0]?.operations[0]?.operation, "search");

    const catalogMissingRes = await app.request("/v1/catalog?site=does-not-exist-xyz");
    assert.equal(catalogMissingRes.status, 404);

    const catalogCallRes = await app.request("/v1/catalog/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site: "marginalia", operation: "search", params: { query: "hono" } }),
    });
    assert.equal(catalogCallRes.status, 200);
    const catalogCallJson = (await catalogCallRes.json()) as { ok: boolean; data: Array<{ url: string }> };
    assert.equal(catalogCallJson.ok, true);
    assert.ok(catalogCallJson.data.length >= 1);

    // POST /v1/search (advanced -> attaches Markdown content)
    const searchRes = await app.request("/v1/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "hono framework", search_depth: "advanced", max_results: 5 }),
    });
    assert.equal(searchRes.status, 200);
    const searchJson = (await searchRes.json()) as {
      cached: boolean;
      results: Array<{ url: string; content?: string; source: string }>;
    };
    assert.equal(searchJson.cached, false);
    assert.ok(searchJson.results.length >= 3);
    assert.ok(searchJson.results[0]?.content && searchJson.results[0].content.length > 20);

    // GET /v1/search cache hit check
    const searchGetRes = await app.request("/v1/search?query=hono+framework&search_depth=advanced&max_results=5");
    assert.equal(searchGetRes.status, 200);
    const searchGetJson = (await searchGetRes.json()) as { cached: boolean };
    assert.equal(searchGetJson.cached, true);

    // POST /v1/search with topic="research" (hits semantic-scholar + arxiv + wikipedia + sednium-news)
    const researchTopicRes = await app.request("/v1/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "transformers", topic: "research", max_results: 10 }),
    });
    assert.equal(researchTopicRes.status, 200);
    const researchTopicJson = (await researchTopicRes.json()) as {
      results: Array<{ url: string; source: string }>;
    };
    assert.ok(researchTopicJson.results.some((r) => r.source.includes("semantic-scholar")));
    assert.ok(researchTopicJson.results.some((r) => r.source.includes("arxiv")));

    // POST /v1/extract (including SSRF block & 404 failure)
    const extractRes = await app.request("/v1/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        urls: ["https://hono.dev/docs/", "https://broken.example.com/missing", "http://127.0.0.1:8080/secret"],
        format: "markdown",
      }),
    });
    assert.equal(extractRes.status, 200);
    const extractJson = (await extractRes.json()) as {
      results: Array<{ url: string; content: string; word_count: number }>;
      failed: Array<{ url: string; error: string }>;
    };
    assert.equal(extractJson.results.length, 1);
    assert.ok(extractJson.results[0]!.word_count > 10);
    assert.equal(extractJson.failed.length, 2);

    // POST /v1/crawl (same-origin BFS + include_paths)
    const crawlRes = await app.request("/v1/crawl", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://hono.dev/docs/",
        max_depth: 1,
        limit: 5,
        include_paths: ["/docs"],
      }),
    });
    assert.equal(crawlRes.status, 200);
    const crawlJson = (await crawlRes.json()) as {
      total_pages: number;
      pages: Array<{ url: string; depth: number }>;
    };
    assert.equal(crawlJson.total_pages, 2);
    assert.ok(crawlJson.pages.every((p) => p.url.startsWith("https://hono.dev/docs")));

    // POST /v1/research
    const researchRes = await app.request("/v1/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "hono web framework", max_sources: 3 }),
    });
    assert.equal(researchRes.status, 200);
    const researchJson = (await researchRes.json()) as {
      queries: string[];
      citations: Array<{ index: number; url: string }>;
      context_markdown: string;
    };
    assert.equal(researchJson.queries.length, 3);
    assert.ok(researchJson.citations.length >= 1);
    assert.match(researchJson.context_markdown, /\[1\]/);

    // Optional Bearer auth enforcement
    const prevKey = process.env.SEARCH_API_KEY;
    process.env.SEARCH_API_KEY = "test-secret-token";
    try {
      assert.equal((await app.request("/v1/search?query=test")).status, 401);
      assert.equal((await app.request("/v1/catalog")).status, 401);
      assert.equal((await app.request("/health")).status, 200);

      const authed = await app.request("/v1/catalog?site=github", {
        headers: { Authorization: "Bearer test-secret-token" },
      });
      assert.equal(authed.status, 200);
    } finally {
      if (prevKey === undefined) delete process.env.SEARCH_API_KEY;
      else process.env.SEARCH_API_KEY = prevKey;
    }
  } finally {
    if (prevHome === undefined) delete process.env.API_ANYTHING_HOME;
    else process.env.API_ANYTHING_HOME = prevHome;
    rmSync(testAaHome, { recursive: true, force: true });
  }
});

test("Stateless Streamable HTTP MCP endpoint exposes web_search + catalog tools and returns 405 on GET", async () => {
  const testHome = mkdtempSync(path.join(os.tmpdir(), "agent-search-mcp-"));
  const prevHome = process.env.API_ANYTHING_HOME;
  process.env.API_ANYTHING_HOME = testHome;
  try {
    const app = createApp({ cache: new SearchCache(), fetchImpl: createMockFetch() });

    const getRes = await app.request("/mcp", { method: "GET" });
    assert.equal(getRes.status, 405);

    const listRes = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    assert.equal(listRes.status, 200);
    const listJson = (await listRes.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const toolNames = listJson.result.tools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, [
      "call_catalog",
      "crawl_site",
      "deep_research",
      "extract_url",
      "list_catalog",
      "web_search",
    ]);

    const searchCallRes = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "web_search",
          arguments: { query: "transformers", topic: "research", max_results: 6 },
        },
      }),
    });
    assert.equal(searchCallRes.status, 200);
    const searchCallJson = (await searchCallRes.json()) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    const parsedSearch = JSON.parse(searchCallJson.result.content[0]!.text) as {
      results: Array<{ source: string }>;
    };
    assert.ok(parsedSearch.results.some((r) => r.source.includes("semantic-scholar")));
    assert.ok(parsedSearch.results.some((r) => r.source.includes("arxiv")));

    const listCatRes = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_catalog", arguments: { site: "arxiv" } },
      }),
    });
    assert.equal(listCatRes.status, 200);
    const listCatJson = JSON.parse(
      ((await listCatRes.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text,
    ) as { total_sites: number; sites: Array<{ site: string }> };
    assert.equal(listCatJson.total_sites, 1);
    assert.equal(listCatJson.sites[0]?.site, "arxiv");

    const callCatRes = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "call_catalog",
          arguments: { site: "marginalia", operation: "search", params: { query: "hono" } },
        },
      }),
    });
    assert.equal(callCatRes.status, 200);
    const callCatJson = JSON.parse(
      ((await callCatRes.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text,
    ) as { ok: boolean; data: Array<{ url: string }> };
    assert.equal(callCatJson.ok, true);
    assert.ok(callCatJson.data.length >= 1);
  } finally {
    if (prevHome === undefined) delete process.env.API_ANYTHING_HOME;
    else process.env.API_ANYTHING_HOME = prevHome;
    rmSync(testHome, { recursive: true, force: true });
  }
});

test("Vercel handler executes cleanly with VERCEL=1 and writes nothing outside /tmp", async () => {
  const prevVercel = process.env.VERCEL;
  const prevHome = process.env.API_ANYTHING_HOME;
  process.env.VERCEL = "1";
  delete process.env.API_ANYTHING_HOME;
  try {
    const res = await vercelGet(new Request("https://example.vercel.app/health"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { runtime: string; cache: { backend: string } };
    assert.equal(body.runtime, "vercel");
    assert.equal(body.cache.backend, "memory");
    const apiHome = process.env["API_ANYTHING_HOME"] ?? "";
    assert.ok(apiHome.startsWith(os.tmpdir()));

    const catRes = await vercelGet(new Request("https://example.vercel.app/v1/catalog"));
    assert.equal(catRes.status, 200);
    const catBody = (await catRes.json()) as { total_sites: number };
    assert.ok(catBody.total_sites >= 114);

    const mcp405 = await vercelGet(new Request("https://example.vercel.app/mcp"));
    assert.equal(mcp405.status, 405);

    const mcpPost = await vercelPost(
      new Request("https://example.vercel.app/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
      }),
    );
    assert.equal(mcpPost.status, 200);
  } finally {
    if (prevVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prevVercel;
    if (prevHome === undefined) delete process.env.API_ANYTHING_HOME;
    else process.env.API_ANYTHING_HOME = prevHome;
  }
});

test("Stdio MCP entrypoint responds to initialize and tools/list with catalog tools", async () => {
  const testHome = mkdtempSync(path.join(os.tmpdir(), "agent-search-stdio-"));
  const child = spawn(process.execPath, ["dist/mcp-stdio.js"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, API_ANYTHING_HOME: testHome, CACHE_DIR: path.join(testHome, "cache") },
  });

  try {
    const lines: string[] = [];
    const collectPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stdio MCP timeout")), 10_000);
      let buf = "";
      child.stdout.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const line of parts) {
          if (line.trim()) lines.push(line.trim());
        }
        if (lines.length >= 2) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      })}\n`,
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);

    await collectPromise;
    child.kill("SIGTERM");

    const responses = lines.map((l) => JSON.parse(l) as { id?: number; result?: { tools?: Array<{ name: string }> } });
    const listResp = responses.find((r) => r.id === 2);
    assert.ok(listResp?.result?.tools);
    assert.deepEqual(
      listResp.result.tools.map((t) => t.name).sort(),
      ["call_catalog", "crawl_site", "deep_research", "extract_url", "list_catalog", "web_search"],
    );
  } finally {
    child.kill("SIGTERM");
    rmSync(testHome, { recursive: true, force: true });
  }
});
