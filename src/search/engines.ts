import { call } from "api-anything";
import { parseHTML } from "linkedom";
import { ensureApiAnythingEnv } from "../api-anything-env.js";
import type { RawEngineResult, SearchTopic } from "../types.js";
import { unwrapResultUrl } from "./normalize.js";

const DEFAULT_TIMEOUT_MS = 8_000;

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

export interface EngineCallOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface EngineStatus {
  name: string;
  kind: "spec" | "catalog";
  source: string;
}

export const REGISTERED_PROVIDERS: EngineStatus[] = [
  { name: "ddg-lite", kind: "spec", source: "./sites/ddg-lite.json" },
  { name: "brave-search", kind: "spec", source: "./sites/brave-search.json" },
  { name: "mojeek", kind: "spec", source: "./sites/mojeek.json" },
  { name: "wikipedia", kind: "catalog", source: "api-anything/sites/wikipedia.json" },
  { name: "hacker-news", kind: "catalog", source: "api-anything/sites/hacker-news.json" },
  { name: "github", kind: "catalog", source: "api-anything/sites/github.json" },
];

function createCapturingFetch(baseFetch: typeof fetch): {
  fetchImpl: typeof fetch;
  getLastHtml: () => string;
  getLastStatus: () => number;
} {
  let lastHtml = "";
  let lastStatus = 0;

  const wrapped: typeof fetch = async (input, init) => {
    const response = await baseFetch(input, init);
    lastStatus = response.status;
    try {
      const cloned = response.clone();
      lastHtml = await cloned.text();
    } catch {
      lastHtml = "";
    }
    return response;
  };

  return {
    fetchImpl: wrapped,
    getLastHtml: () => lastHtml,
    getLastStatus: () => lastStatus,
  };
}

export function parseDdgLiteHtml(html: string): RawEngineResult[] {
  if (!html) return [];
  const { document } = parseHTML(html);
  const results: RawEngineResult[] = [];
  const links = document.querySelectorAll("a.result-link");

  if (links.length > 0) {
    for (const link of links) {
      const titleRow = link.closest("tr");
      if (titleRow?.classList?.contains("result-sponsored")) continue;

      const rawHref = link.getAttribute("href") ?? "";
      const url = unwrapResultUrl(rawHref);
      if (!url) continue;

      let snippet = "";
      let nextRow = titleRow?.nextElementSibling ?? null;
      // Walk up to 2 sibling rows to locate result-snippet (and detect sponsored rows)
      for (let i = 0; i < 2 && nextRow; i++) {
        if (nextRow.classList?.contains("result-sponsored")) {
          snippet = "__SPONSORED__";
          break;
        }
        const snippetCell = nextRow.querySelector("td.result-snippet, .result-snippet");
        if (snippetCell) {
          snippet = (snippetCell.textContent ?? "").replace(/\s+/g, " ").trim();
          break;
        }
        nextRow = nextRow.nextElementSibling;
      }
      if (snippet === "__SPONSORED__") continue;

      const title = (link.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!title) continue;
      results.push({ title, url, snippet, source: "ddg-lite" });
    }
    return results;
  }

  // Fallback for html.duckduckgo.com/html/ layout
  for (const card of document.querySelectorAll("#links div.result:not(.result--ad), div.result:not(.result--ad)")) {
    const anchor = card.querySelector("a.result__a");
    if (!anchor) continue;
    const url = unwrapResultUrl(anchor.getAttribute("href") ?? "");
    if (!url) continue;
    const title = (anchor.textContent ?? "").replace(/\s+/g, " ").trim();
    const snippetEl = card.querySelector(".result__snippet");
    const snippet = (snippetEl?.textContent ?? "").replace(/\s+/g, " ").trim();
    if (title) results.push({ title, url, snippet, source: "ddg-lite" });
  }

  return results;
}

export function parseBraveHtml(html: string): RawEngineResult[] {
  if (!html) return [];
  const { document } = parseHTML(html);
  const cards = document.querySelectorAll(
    "#search-page .snippet[data-type='web'], #results .snippet[data-type='web'], .snippet[data-type='web'], #results .snippet",
  );
  const results: RawEngineResult[] = [];

  for (const card of cards) {
    const anchor = card.querySelector("a[href^='http'], a.l1[href], a.result-header[href]");
    if (!anchor) continue;
    const url = unwrapResultUrl(anchor.getAttribute("href") ?? "");
    if (!url) continue;
    const titleEl = card.querySelector(".search-snippet-title, .title, .snippet-title, h3, h4");
    const title = (titleEl?.textContent ?? anchor.textContent ?? "").replace(/\s+/g, " ").trim();
    const snippetEl = card.querySelector(
      ".generic-snippet .content, .snippet-description, .snippet-content, .snippet-description-text",
    );
    const snippet = (snippetEl?.textContent ?? "").replace(/\s+/g, " ").trim();
    if (title) results.push({ title, url, snippet, source: "brave-search" });
  }

  return results;
}

export function parseMojeekHtml(html: string): RawEngineResult[] {
  if (!html) return [];
  const { document } = parseHTML(html);
  const items = document.querySelectorAll("ul.results-standard li, ul.results li, div.result");
  const results: RawEngineResult[] = [];

  for (const item of items) {
    const titleAnchor = item.querySelector("h2 a, a.title");
    const obAnchor = item.querySelector("a.ob[href]");
    const rawHref = titleAnchor?.getAttribute("href") ?? obAnchor?.getAttribute("href") ?? "";
    const url = unwrapResultUrl(rawHref);
    if (!url) continue;
    const title = (titleAnchor?.textContent ?? obAnchor?.textContent ?? "").replace(/\s+/g, " ").trim();
    const snippetEl = item.querySelector("p.s, p.snippet, .s");
    const snippet = (snippetEl?.textContent ?? "").replace(/\s+/g, " ").trim();
    if (title) results.push({ title, url, snippet, source: "mojeek" });
  }

  return results;
}

async function runDdgLite(query: string, opts: EngineCallOptions): Promise<RawEngineResult[]> {
  ensureApiAnythingEnv();
  const baseFetch = opts.fetchImpl ?? globalThis.fetch;
  const capture = createCapturingFetch(baseFetch);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const res = await call(
    "ddg-lite",
    "search",
    { query },
    {
      maxTier: 1,
      callOnly: true,
      timeoutMs,
      fetchImpl: capture.fetchImpl,
    },
  );

  const htmlFromSpec = capture.getLastHtml();
  if (htmlFromSpec) {
    const enriched = parseDdgLiteHtml(htmlFromSpec);
    if (enriched.length > 0) return enriched;
  }

  if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
    const mapped = (res.data as Array<Record<string, unknown>>)
      .map((row) => {
        const url = unwrapResultUrl(String(row.url ?? ""));
        const title = String(row.title ?? "").replace(/\s+/g, " ").trim();
        if (!url || !title) return null;
        return {
          title,
          url,
          snippet: String(row.snippet ?? "").replace(/\s+/g, " ").trim(),
          source: "ddg-lite",
        };
      })
      .filter((x): x is RawEngineResult => x !== null);
    if (mapped.length > 0) return mapped;
  }

  // Graceful direct-HTTP fallback across DDG Lite POST and DDG HTML GET
  const fallbackTargets: Array<{ url: string; init: RequestInit }> = [
    {
      url: "https://lite.duckduckgo.com/lite/",
      init: {
        method: "POST",
        headers: {
          ...DEFAULT_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://lite.duckduckgo.com",
          Referer: "https://lite.duckduckgo.com/",
        },
        body: `q=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(timeoutMs),
      },
    },
    {
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      init: {
        method: "GET",
        headers: DEFAULT_HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
      },
    },
  ];

  for (const target of fallbackTargets) {
    try {
      const fallbackRes = await baseFetch(target.url, target.init);
      if (!fallbackRes.ok || fallbackRes.status === 202) continue;
      const html = await fallbackRes.text();
      const parsed = parseDdgLiteHtml(html);
      if (parsed.length > 0) return parsed;
    } catch {
      // try next fallback
    }
  }

  return [];
}

async function runBraveSearch(query: string, opts: EngineCallOptions): Promise<RawEngineResult[]> {
  ensureApiAnythingEnv();
  const baseFetch = opts.fetchImpl ?? globalThis.fetch;
  const capture = createCapturingFetch(baseFetch);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const res = await call(
    "brave-search",
    "search",
    { query },
    {
      maxTier: 1,
      callOnly: true,
      timeoutMs,
      fetchImpl: capture.fetchImpl,
    },
  );

  if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
    const mapped = (res.data as Array<Record<string, unknown>>)
      .map((row) => {
        const url = unwrapResultUrl(String(row.url ?? ""));
        const title = String(row.title ?? "").replace(/\s+/g, " ").trim();
        if (!url || !title) return null;
        return {
          title,
          url,
          snippet: String(row.snippet ?? "").replace(/\s+/g, " ").trim(),
          source: "brave-search",
        };
      })
      .filter((x): x is RawEngineResult => x !== null);
    if (mapped.length > 0) return mapped;
  }

  const capturedHtml = capture.getLastHtml();
  if (capturedHtml) {
    const parsed = parseBraveHtml(capturedHtml);
    if (parsed.length > 0) return parsed;
  }

  try {
    const directRes = await baseFetch(`https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`, {
      method: "GET",
      headers: DEFAULT_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (directRes.ok) {
      return parseBraveHtml(await directRes.text());
    }
  } catch {
    // ignore fallback failure
  }

  return [];
}

async function runMojeek(query: string, opts: EngineCallOptions): Promise<RawEngineResult[]> {
  ensureApiAnythingEnv();
  const baseFetch = opts.fetchImpl ?? globalThis.fetch;
  const capture = createCapturingFetch(baseFetch);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const res = await call(
    "mojeek",
    "search",
    { query },
    {
      maxTier: 1,
      callOnly: true,
      timeoutMs,
      fetchImpl: capture.fetchImpl,
    },
  );

  if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
    const mapped = (res.data as Array<Record<string, unknown>>)
      .map((row) => {
        const url = unwrapResultUrl(String(row.url ?? ""));
        const title = String(row.title ?? "").replace(/\s+/g, " ").trim();
        if (!url || !title) return null;
        return {
          title,
          url,
          snippet: String(row.snippet ?? "").replace(/\s+/g, " ").trim(),
          source: "mojeek",
        };
      })
      .filter((x): x is RawEngineResult => x !== null);
    if (mapped.length > 0) return mapped;
  }

  const capturedHtml = capture.getLastHtml();
  if (capturedHtml) {
    const parsed = parseMojeekHtml(capturedHtml);
    if (parsed.length > 0) return parsed;
  }

  try {
    const directRes = await baseFetch(`https://www.mojeek.com/search?q=${encodeURIComponent(query)}&t=20`, {
      method: "GET",
      headers: DEFAULT_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (directRes.ok) {
      return parseMojeekHtml(await directRes.text());
    }
  } catch {
    // ignore fallback failure
  }

  return [];
}

export async function runWikipedia(query: string, opts: EngineCallOptions): Promise<RawEngineResult[]> {
  ensureApiAnythingEnv();
  const baseFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const res = await call(
    "wikipedia",
    "searchText",
    { q: query },
    {
      maxTier: 1,
      callOnly: true,
      timeoutMs,
      fetchImpl: baseFetch,
    },
  );

  if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
    const mapped = (res.data as Array<Record<string, unknown>>)
      .map((row) => {
        const url = unwrapResultUrl(String(row.url ?? ""));
        const title = String(row.title ?? "").replace(/\s+/g, " ").trim();
        if (!url || !title) return null;
        return {
          title: `${title} - Wikipedia`,
          url,
          snippet: String(row.snippet ?? "").replace(/\s+/g, " ").trim(),
          source: "wikipedia",
        };
      })
      .filter((x): x is RawEngineResult => x !== null);
    if (mapped.length > 0) return mapped;
  }

  // Fallback to Wikipedia MediaWiki search API
  try {
    const apiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=10&format=json&utf8=1`;
    const apiRes = await baseFetch(apiUrl, {
      headers: { Accept: "application/json", "User-Agent": DEFAULT_HEADERS["User-Agent"]! },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (apiRes.ok) {
      const json = (await apiRes.json()) as {
        query?: { search?: Array<{ title?: string; snippet?: string }> };
      };
      return (json.query?.search ?? [])
        .filter((item) => Boolean(item.title))
        .map((item) => ({
          title: `${item.title!} - Wikipedia`,
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title!.replace(/ /g, "_"))}`,
          snippet: (item.snippet ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
          source: "wikipedia",
        }));
    }
  } catch {
    // ignore fallback failure
  }

  return [];
}

export async function runHackerNews(
  query: string,
  byDate: boolean,
  opts: EngineCallOptions,
): Promise<RawEngineResult[]> {
  ensureApiAnythingEnv();
  const baseFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const op = byDate ? "searchByDate" : "search";

  const res = await call(
    "hacker-news",
    op,
    { query, type: "story", page: 0 },
    {
      maxTier: 1,
      callOnly: true,
      timeoutMs,
      fetchImpl: baseFetch,
    },
  );

  const mapHit = (hit: Record<string, unknown>): RawEngineResult | null => {
    const title = String(hit.title ?? "").replace(/\s+/g, " ").trim();
    if (!title) return null;
    const objectId = String(hit.objectID ?? "");
    const rawUrl = hit.url ? String(hit.url) : objectId ? `https://news.ycombinator.com/item?id=${objectId}` : "";
    const url = unwrapResultUrl(rawUrl);
    if (!url) return null;
    const points = hit.points !== undefined ? `${hit.points} points` : "";
    const comments = hit.num_comments !== undefined ? `${hit.num_comments} comments` : "";
    const author = hit.author ? `by ${hit.author}` : "";
    const snippet = [points, comments, author].filter(Boolean).join(" · ");
    return { title, url, snippet, source: "hacker-news" };
  };

  if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
    const mapped = (res.data as Array<Record<string, unknown>>)
      .map(mapHit)
      .filter((x): x is RawEngineResult => x !== null);
    if (mapped.length > 0) return mapped;
  }

  // Fallback to Algolia HN public REST API
  try {
    const endpoint = byDate ? "search_by_date" : "search";
    const apiUrl = `https://hn.algolia.com/api/v1/${endpoint}?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=15`;
    const apiRes = await baseFetch(apiUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (apiRes.ok) {
      const json = (await apiRes.json()) as { hits?: Array<Record<string, unknown>> };
      return (json.hits ?? []).map(mapHit).filter((x): x is RawEngineResult => x !== null);
    }
  } catch {
    // ignore fallback failure
  }

  return [];
}

export async function runGitHub(query: string, opts: EngineCallOptions): Promise<RawEngineResult[]> {
  ensureApiAnythingEnv();
  const baseFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const res = await call(
    "github",
    "searchRepos",
    { q: query },
    {
      maxTier: 1,
      callOnly: true,
      timeoutMs,
      fetchImpl: baseFetch,
    },
  );

  if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
    const mapped = (res.data as Array<Record<string, unknown>>)
      .map((row) => {
        const owner = String(row.owner ?? "").trim();
        const name = String(row.name ?? "").trim();
        if (!owner || !name) return null;
        const lang = row.language ? ` (${row.language})` : "";
        const stars = row.stars !== undefined ? ` ★ ${row.stars}` : "";
        const desc = String(row.description ?? "")
          .replace(/<[^>]+>/g, "")
          .replace(/\s+/g, " ")
          .trim();
        return {
          title: `${owner}/${name}${lang}`,
          url: `https://github.com/${owner}/${name}`,
          snippet: `${desc}${stars}`.trim(),
          source: "github",
        };
      })
      .filter((x): x is RawEngineResult => x !== null);
    if (mapped.length > 0) return mapped;
  }

  // Fallback to GitHub public REST repository search API
  try {
    const apiUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=10`;
    const apiRes = await baseFetch(apiUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "agent-search/1.0",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (apiRes.ok) {
      const json = (await apiRes.json()) as {
        items?: Array<{
          full_name?: string;
          html_url?: string;
          description?: string;
          stargazers_count?: number;
          language?: string;
        }>;
      };
      return (json.items ?? [])
        .filter((item) => Boolean(item.full_name && item.html_url))
        .map((item) => ({
          title: `${item.full_name!}${item.language ? ` (${item.language})` : ""}`,
          url: item.html_url!,
          snippet: `${item.description ?? ""}${item.stargazers_count !== undefined ? ` ★ ${item.stargazers_count}` : ""}`.trim(),
          source: "github",
        }));
    }
  } catch {
    // ignore fallback failure
  }

  return [];
}

export async function fanOutSearchEngines(
  query: string,
  topic: SearchTopic,
  opts: EngineCallOptions = {},
): Promise<Array<{ source: string; items: RawEngineResult[] }>> {
  const tasks: Array<{ source: string; promise: Promise<RawEngineResult[]> }> = [
    { source: "ddg-lite", promise: runDdgLite(query, opts) },
    { source: "brave-search", promise: runBraveSearch(query, opts) },
    { source: "mojeek", promise: runMojeek(query, opts) },
  ];

  if (topic === "general") {
    tasks.push({ source: "wikipedia", promise: runWikipedia(query, opts) });
  } else if (topic === "news") {
    tasks.push({ source: "hacker-news", promise: runHackerNews(query, true, opts) });
  } else if (topic === "code") {
    tasks.push({ source: "github", promise: runGitHub(query, opts) });
    tasks.push({ source: "hacker-news", promise: runHackerNews(query, false, opts) });
  }

  const settled = await Promise.allSettled(tasks.map((t) => t.promise));
  return tasks.map((task, idx) => {
    const outcome = settled[idx];
    return {
      source: task.source,
      items: outcome?.status === "fulfilled" ? outcome.value : [],
    };
  });
}
