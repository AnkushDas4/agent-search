import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSite } from "api-anything";
import { GET as vercelGet, POST as vercelPost } from "../api/index.js";
import { createApp } from "../src/app.js";
import { SearchCache } from "../src/cache.js";
import {
  fanOutSearchEngines,
  parseBraveHtml,
  parseDdgLiteHtml,
  parseMojeekHtml,
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

const BRAVE_HTML = `<!DOCTYPE html>
<html><body>
  <main id="search-page">
    <div class="serp-columns">
      <div class="snippet svelte-jmfu5f" data-pos="1" data-type="web">
        <div class="result-body"><div class="result-content">
          <a href="https://hono.dev/docs/?utm_source=brave" class="l1">
            <div class="title search-snippet-title">Hono Documentation</div>
          </a>
          <div class="generic-snippet"><div class="content">Official Hono docs and guides for Node, Vercel, and Workers.</div></div>
        </div></div>
      </div>
      <div class="snippet svelte-jmfu5f" data-pos="2" data-type="web">
        <div class="result-body"><div class="result-content">
          <a href="https://nodejs.org/en" class="l1">
            <div class="title search-snippet-title">Node.js Runtime</div>
          </a>
          <div class="generic-snippet"><div class="content">JavaScript runtime built on Chrome V8.</div></div>
        </div></div>
      </div>
    </div>
  </main>
</body></html>`;

const MOJEEK_HTML = `<!DOCTYPE html>
<html><body>
  <ul class="results-standard">
    <li>
      <a class="ob" href="https://hono.dev/docs/">hono.dev/docs/</a>
      <h2><a class="title" href="https://hono.dev/docs/">Hono Docs (Mojeek)</a></h2>
      <p class="s">Build fast APIs with Hono across runtimes.</p>
    </li>
    <li>
      <a class="ob" href="https://modelcontextprotocol.io/introduction">modelcontextprotocol.io</a>
      <h2><a class="title" href="https://modelcontextprotocol.io/introduction">Model Context Protocol</a></h2>
      <p class="s">Open protocol standardizing context for LLMs.</p>
    </li>
  </ul>
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

function createMockFetch(options: { ddg202Once?: boolean } = {}): typeof fetch {
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

    if (url.startsWith("https://search.brave.com/search")) {
      return new Response(BRAVE_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.startsWith("https://www.mojeek.com/search")) {
      return new Response(MOJEEK_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
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

    if (url.startsWith("https://nodejs.org/")) {
      return new Response(
        ARTICLE_HTML("Node.js Runtime", "Node.js 22 provides native fetch and Web Streams APIs."),
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

test("site specs in ./sites/ validate cleanly against api-anything schema", () => {
  for (const name of ["ddg-lite", "brave-search", "mojeek"]) {
    const raw = JSON.parse(readFileSync(path.resolve("sites", `${name}.json`), "utf8"));
    const site = parseSite(raw);
    assert.equal(site.name, name);
    assert.equal(site.operations[0]?.readOnly, true);
    assert.equal(site.operations[0]?.minTier, 1);
  }
});

test("HTML parsers extract organic items, skip ads, and unwrap DuckDuckGo redirect URLs", () => {
  const ddg = parseDdgLiteHtml(DDG_LITE_HTML);
  assert.equal(ddg.length, 2);
  assert.equal(ddg[0]?.url, "https://hono.dev/docs/");
  assert.match(ddg[0]?.snippet ?? "", /ultrafast web framework/);

  const brave = parseBraveHtml(BRAVE_HTML);
  assert.equal(brave.length, 2);
  assert.equal(brave[0]?.title, "Hono Documentation");
  assert.match(brave[0]?.snippet ?? "", /Official Hono docs/);

  const mojeek = parseMojeekHtml(MOJEEK_HTML);
  assert.equal(mojeek.length, 2);
  assert.equal(mojeek[1]?.url, "https://modelcontextprotocol.io/introduction");

  assert.equal(
    unwrapResultUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fabc"),
    "https://example.com/abc",
  );
  assert.equal(unwrapResultUrl("https://duckduckgo.com/y.js?ad=1"), null);
  assert.equal(
    canonicalizeUrlForDedup("https://www.hono.dev/docs/?utm_source=brave#top"),
    "https://hono.dev/docs",
  );
});

test("multi-engine ranking boosts consensus URLs and respects domain filters", () => {
  const ranked = rankAndDeduplicateResults(
    [
      {
        source: "ddg-lite",
        items: [
          { title: "Hono", url: "https://hono.dev/docs/", snippet: "Short", source: "ddg-lite" },
          { title: "GitHub", url: "https://github.com/honojs/hono", snippet: "Repo", source: "ddg-lite" },
        ],
      },
      {
        source: "brave-search",
        items: [
          {
            title: "Node.js",
            url: "https://nodejs.org/en",
            snippet: "Runtime",
            source: "brave-search",
          },
          {
            title: "Hono Docs",
            url: "https://www.hono.dev/docs/?utm_source=brave",
            snippet: "Longer descriptive snippet from Brave",
            source: "brave-search",
          },
        ],
      },
    ],
    { maxResults: 10 },
  );

  assert.equal(ranked[0]?.url, "https://hono.dev/docs/");
  assert.equal(ranked[0]?.source, "ddg-lite, brave-search");
  assert.equal(ranked[0]?.snippet, "Longer descriptive snippet from Brave");

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

test("fanOutSearchEngines handles api-anything Tier-1 calls and falls back cleanly on HTTP 202", async () => {
  const testHome = mkdtempSync(path.join(os.tmpdir(), "agent-search-fanout-"));
  const prevHome = process.env.API_ANYTHING_HOME;
  process.env.API_ANYTHING_HOME = testHome;
  try {
    const mockFetch = createMockFetch({ ddg202Once: true });
    const batches = await fanOutSearchEngines("hono", "general", { fetchImpl: mockFetch });
    const bySource = Object.fromEntries(batches.map((b) => [b.source, b.items]));
    assert.equal(bySource["ddg-lite"]?.length, 2);
    assert.equal(bySource["brave-search"]?.length, 2);
    assert.equal(bySource["mojeek"]?.length, 2);
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
    assert.deepEqual(cache1.get("k1"), { v: 1 }); // touch k1 so k2 becomes LRU
    cache1.set("k3", { v: 3 }); // evicts k2 from memory
    assert.deepEqual(cache1.get("k3"), { v: 3 });

    // New instance reads persisted k1 from disk
    const cache2 = new SearchCache({ maxEntries: 2, ttlMs: 60_000, persistentDir: dir });
    assert.equal(cache2.getStats().backend, "disk+memory");
    assert.deepEqual(cache2.get("k1"), { v: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("REST API routes: /, /health, /openapi.json, /v1/search (GET/POST), /v1/extract, /v1/crawl, /v1/research, and auth", async () => {
  // Use an isolated temp API_ANYTHING_HOME for REST/MCP mock tests so ./data is untouched
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
    const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(scriptMatch?.[1], "expected inline script in playground HTML");
    assert.doesNotThrow(() => new Function(scriptMatch[1]!));

    // Health & OpenAPI
    const healthRes = await app.request("/health");
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as { status: string; providers: unknown[] };
    assert.equal(health.status, "ok");
    assert.ok(health.providers.length >= 6);

    const openApiRes = await app.request("/openapi.json");
    assert.equal(openApiRes.status, 200);
    const openApi = (await openApiRes.json()) as { openapi: string; paths: Record<string, unknown> };
    assert.equal(openApi.openapi, "3.1.0");
    assert.ok("/v1/search" in openApi.paths);
    assert.ok("/mcp" in openApi.paths);

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
      const unauth = await app.request("/v1/search?query=test");
      assert.equal(unauth.status, 401);

      const authHealth = await app.request("/health");
      assert.equal(authHealth.status, 200);

      const authed = await app.request("/v1/search?query=hono+framework&search_depth=advanced&max_results=5", {
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

test("Stateless Streamable HTTP MCP endpoint handles POST tools/list + tools/call and returns 405 on GET", async () => {
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
    assert.deepEqual(toolNames, ["crawl_site", "deep_research", "extract_url", "web_search"]);

    const callRes = await app.request("/mcp", {
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
          arguments: { query: "hono", max_results: 3 },
        },
      }),
    });
    assert.equal(callRes.status, 200);
    const callJson = (await callRes.json()) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    const parsedToolPayload = JSON.parse(callJson.result.content[0]!.text) as { results: unknown[] };
    assert.ok(parsedToolPayload.results.length >= 2);
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

test("Stdio MCP entrypoint responds to initialize and tools/list", async () => {
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
      ["crawl_site", "deep_research", "extract_url", "web_search"],
    );
  } finally {
    child.kill("SIGTERM");
    rmSync(testHome, { recursive: true, force: true });
  }
});
