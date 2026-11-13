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
  { name: "startpage", kind: "spec", source: "./sites/startpage.json" },
  { name: "marginalia", kind: "spec", source: "./sites/marginalia.json" },
  { name: "qwant", kind: "spec", source: "./sites/qwant.json" },
  { name: "arxiv", kind: "spec", source: "./sites/arxiv.json" },
  { name: "wikipedia", kind: "catalog", source: "api-anything/sites/wikipedia.json" },
  { name: "hacker-news", kind: "catalog", source: "api-anything/sites/hacker-news.json" },
  { name: "github", kind: "catalog", source: "api-anything/sites/github.json" },
];

function stripHtmlTags(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

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

export function parseStartpageHtml(html: string): RawEngineResult[] {
  if (!html) return [];
  if (html.includes('id="anubis_challenge"') || html.includes("/sp/captcha")) {
    return [];
  }

  const { document } = parseHTML(html);
  const results: RawEngineResult[] = [];

  let cards = [...document.querySelectorAll(".w-gl__result")];
  if (cards.length === 0) {
    cards = [...document.querySelectorAll(".w-gl__result__main")];
  }
  if (cards.length === 0) {
    cards = [...document.querySelectorAll("#results > div.result, .mainline-results .result")];
  }

  for (const card of cards) {
    if (
      card.closest("#sponsored, .a-gl, .sponsored-results, [data-testid*='ad']") ||
      card.classList?.contains("a-gl") ||
      card.querySelector(".w-gl__label")
    ) {
      continue;
    }

    const candidateAnchors = [
      ...card.querySelectorAll("a.w-gl__result-title[href], a.result-link[href], h2 a[href], h3 a[href], a[href^='http']"),
    ];
    let url: string | null = null;
    let primaryAnchor: Element | null = null;
    for (const anchor of candidateAnchors) {
      const candidate = unwrapResultUrl(anchor.getAttribute("href") ?? "");
      if (candidate) {
        url = candidate;
        primaryAnchor = anchor;
        break;
      }
    }
    if (!url || !primaryAnchor) continue;

    const titleEl =
      card.querySelector("a.w-gl__result-title h3, a.w-gl__result-title h2, a.w-gl__result-title, a.result-link, h3, h2") ??
      primaryAnchor;
    const title = (titleEl.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!title) continue;

    const snippetEl = card.querySelector("p.w-gl__description, .w-gl__description, p.description, .result__snippet, p");
    const snippet = (snippetEl?.textContent ?? "").replace(/\s+/g, " ").trim();

    results.push({ title, url, snippet, source: "startpage" });
  }

  if (results.length > 0) return results;

  // Fallback: extract React SSR payload if Startpage embeds UIStartpage.AppSerpWeb JSON
  const marker = "React.createElement(UIStartpage.AppSerpWeb, {";
  const startIdx = html.indexOf(marker);
  if (startIdx >= 0) {
    const jsonStart = startIdx + marker.length - 1;
    const endIdx = html.indexOf("}})", jsonStart);
    if (endIdx > jsonStart) {
      try {
        const parsed = JSON.parse(`${html.slice(jsonStart, endIdx)}}}`) as {
          render?: {
            presenter?: {
              regions?: {
                mainline?: Array<{
                  display_type?: string;
                  results?: Array<{ clickUrl?: string; title?: string; description?: string }>;
                }>;
              };
            };
          };
        };
        for (const section of parsed.render?.presenter?.regions?.mainline ?? []) {
          if (section.display_type && section.display_type !== "web-google") continue;
          for (const item of section.results ?? []) {
            const url = unwrapResultUrl(item.clickUrl ?? "");
            const title = stripHtmlTags(item.title ?? "");
            if (!url || !title) continue;
            results.push({
              title,
              url,
              snippet: stripHtmlTags(item.description ?? ""),
              source: "startpage",
            });
          }
        }
      } catch {
        // ignore embedded JSON parse failure
      }
    }
  }

  return results;
}

export function parseMarginaliaJson(payload: unknown): RawEngineResult[] {
  let rows: Array<Record<string, unknown>> = [];
  if (Array.isArray(payload)) {
    rows = payload as Array<Record<string, unknown>>;
  } else if (payload && typeof payload === "object") {
    const obj = payload as { results?: unknown };
    if (Array.isArray(obj.results)) {
      rows = obj.results as Array<Record<string, unknown>>;
    }
  }

  const results: RawEngineResult[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const url = unwrapResultUrl(String(row.url ?? ""));
    const title = stripHtmlTags(String(row.title ?? ""));
    if (!url || !title) continue;
    const snippet = stripHtmlTags(String(row.description ?? row.snippet ?? ""));
    results.push({ title, url, snippet, source: "marginalia" });
  }
  return results;
}

export function parseQwantJson(payload: unknown): RawEngineResult[] {
  let mainline: unknown[] = [];

  if (Array.isArray(payload)) {
    mainline = payload;
  } else if (payload && typeof payload === "object") {
    const root = payload as {
      data?: {
        result?: {
          items?:
            | { mainline?: unknown[] }
            | unknown[];
        };
      };
      result?: {
        items?:
          | { mainline?: unknown[] }
          | unknown[];
      };
    };
    const itemsContainer = root.data?.result?.items ?? root.result?.items;
    if (Array.isArray(itemsContainer)) {
      mainline = [{ type: "web", items: itemsContainer }];
    } else if (itemsContainer && typeof itemsContainer === "object" && Array.isArray(itemsContainer.mainline)) {
      mainline = itemsContainer.mainline;
    }
  }

  const results: RawEngineResult[] = [];
  for (const block of mainline) {
    if (!block || typeof block !== "object") continue;
    const section = block as { type?: unknown; items?: unknown; url?: unknown; title?: unknown; desc?: unknown };

    // Handle direct flat items array if passed without mainline wrapper
    if (typeof section.url === "string" && typeof section.title === "string") {
      const url = unwrapResultUrl(section.url);
      const title = stripHtmlTags(section.title);
      if (url && title) {
        results.push({
          title,
          url,
          snippet: stripHtmlTags(String(section.desc ?? "")),
          source: "qwant",
        });
      }
      continue;
    }

    const blockType = typeof section.type === "string" ? section.type : "web";
    if (blockType !== "web") continue;
    if (!Array.isArray(section.items)) continue;

    for (const rawItem of section.items) {
      if (!rawItem || typeof rawItem !== "object") continue;
      const item = rawItem as Record<string, unknown>;
      const url = unwrapResultUrl(String(item.url ?? ""));
      const title = stripHtmlTags(String(item.title ?? ""));
      if (!url || !title) continue;
      const snippet = stripHtmlTags(String(item.desc ?? item.description ?? ""));
      results.push({ title, url, snippet, source: "qwant" });
    }
  }

  return results;
}

function normalizeArxivUrl(rawHref: string): string | null {
  const trimmed = rawHref.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/")) {
    return unwrapResultUrl(`https://arxiv.org${trimmed}`);
  }
  return unwrapResultUrl(trimmed);
}

export function parseArxivHtml(html: string): RawEngineResult[] {
  if (!html) return [];
  const { document } = parseHTML(html);
  const cards = document.querySelectorAll("li.arxiv-result");
  const results: RawEngineResult[] = [];

  for (const card of cards) {
    const absAnchor =
      card.querySelector("p.list-title a[href*='/abs/']") ??
      card.querySelector("p.list-title a[href]") ??
      card.querySelector("a[href*='/abs/']");
    if (!absAnchor) continue;

    const url = normalizeArxivUrl(absAnchor.getAttribute("href") ?? "");
    if (!url) continue;

    const titleEl = card.querySelector("p.title");
    const title = (titleEl?.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!title) continue;

    const fullAbs = card.querySelector("p.abstract span.abstract-full");
    const shortAbs = card.querySelector("p.abstract span.abstract-short");
    const rawAbstract = (fullAbs?.textContent ?? shortAbs?.textContent ?? card.querySelector("p.abstract")?.textContent ?? "")
      .replace(/[△▽]\s*(Less|More)\s*$/i, "")
      .replace(/\s+(Less|More)\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();

    results.push({
      title,
      url,
      snippet: rawAbstract,
      source: "arxiv",
    });
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

async function runStartpage(query: string, opts: EngineCallOptions): Promise<RawEngineResult[]> {
  ensureApiAnythingEnv();
  const baseFetch = opts.fetchImpl ?? globalThis.fetch;
  const capture = createCapturingFetch(baseFetch);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const res = await call(
    "startpage",
    "search",
    { query },
    {
      maxTier: 1,
      callOnly: true,
      timeoutMs,
      fetchImpl: capture.fetchImpl,
    },
  );

  const capturedHtml = capture.getLastHtml();
  if (capturedHtml) {
    const parsed = parseStartpageHtml(capturedHtml);
    if (parsed.length > 0) return parsed;
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
          source: "startpage",
        };
      })
      .filter((x): x is RawEngineResult => x !== null);
    if (mapped.length > 0) return mapped;
  }

  try {
    const directRes = await baseFetch(
      `https://www.startpage.com/sp/search?query=${encodeURIComponent(query)}`,
      {
        method: "GET",
        headers: {
          ...DEFAULT_HEADERS,
          Referer: "https://www.startpage.com/",
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (directRes.ok) {
      return parseStartpageHtml(await directRes.text());
    }
  } catch {
    // ignore fallback failure
  }

  return [];
}

async function runMarginalia(query: string, opts: EngineCallOptions): Promise<RawEngineResult[]> {
  ensureApiAnythingEnv();
  const baseFetch = opts.fetchImpl ?? globalThis.fetch;
  const capture = createCapturingFetch(baseFetch);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const res = await call(
    "marginalia",
    "search",
    { query },
    {
      maxTier: 1,
      callOnly: true,
      timeoutMs,
      fetchImpl: capture.fetchImpl,
    },
  );

  if (res.ok && res.data) {
    const parsed = parseMarginaliaJson(res.data);
    if (parsed.length > 0) return parsed;
  }

  const lastStatus = capture.getLastStatus();
  // Rate-limited (HTTP 503/429): return gracefully without hammering the public endpoint
  if (lastStatus === 503 || lastStatus === 429) {
    return [];
  }

  const capturedBody = capture.getLastHtml();
  if (capturedBody && lastStatus >= 200 && lastStatus < 300) {
    try {
      const parsed = parseMarginaliaJson(JSON.parse(capturedBody));
      if (parsed.length > 0) return parsed;
    } catch {
      // ignore invalid JSON
    }
  }

  try {
    const directRes = await baseFetch(
      `https://api.marginalia.nu/public/search/${encodeURIComponent(query)}?count=10`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "agent-search/1.0 (+https://github.com/AnkushDas4/agent-search)",
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (directRes.status === 503 || directRes.status === 429) {
      return [];
    }
    if (directRes.ok) {
      return parseMarginaliaJson(await directRes.json());
    }
  } catch {
    // ignore fallback failure
  }

  return [];
}

async function runQwant(query: string, opts: EngineCallOptions): Promise<RawEngineResult[]> {
  ensureApiAnythingEnv();
  const baseFetch = opts.fetchImpl ?? globalThis.fetch;
  const capture = createCapturingFetch(baseFetch);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const res = await call(
    "qwant",
    "search",
    { query },
    {
      maxTier: 1,
      callOnly: true,
      timeoutMs,
      fetchImpl: capture.fetchImpl,
    },
  );

  if (res.ok && res.data) {
    const parsed = parseQwantJson(res.data);
    if (parsed.length > 0) return parsed;
  }

  const capturedBody = capture.getLastHtml();
  if (capturedBody && capture.getLastStatus() >= 200 && capture.getLastStatus() < 300) {
    try {
      const parsed = parseQwantJson(JSON.parse(capturedBody));
      if (parsed.length > 0) return parsed;
    } catch {
      // ignore invalid JSON
    }
  }

  try {
    const apiUrl = `https://api.qwant.com/v3/search/web?q=${encodeURIComponent(query)}&count=10&locale=en_US&t=web&uiv=4`;
    const directRes = await baseFetch(apiUrl, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        Origin: "https://www.qwant.com",
        Referer: "https://www.qwant.com/",
        "User-Agent": DEFAULT_HEADERS["User-Agent"]!,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (directRes.ok) {
      return parseQwantJson(await directRes.json());
    }
  } catch {
    // ignore fallback failure
  }

  return [];
}

async function runArxiv(query: string, opts: EngineCallOptions): Promise<RawEngineResult[]> {
  ensureApiAnythingEnv();
  const baseFetch = opts.fetchImpl ?? globalThis.fetch;
  const capture = createCapturingFetch(baseFetch);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const res = await call(
    "arxiv",
    "search",
    { query },
    {
      maxTier: 1,
      callOnly: true,
      timeoutMs,
      fetchImpl: capture.fetchImpl,
    },
  );

  const capturedHtml = capture.getLastHtml();
  if (capturedHtml) {
    const parsed = parseArxivHtml(capturedHtml);
    if (parsed.length > 0) return parsed;
  }

  if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
    const mapped = (res.data as Array<Record<string, unknown>>)
      .map((row) => {
        const url = normalizeArxivUrl(String(row.url ?? ""));
        const title = String(row.title ?? "").replace(/\s+/g, " ").trim();
        if (!url || !title) return null;
        const snippet = String(row.snippet ?? "")
          .replace(/[△▽]\s*(Less|More)\s*$/i, "")
          .replace(/\s+/g, " ")
          .trim();
        return { title, url, snippet, source: "arxiv" };
      })
      .filter((x): x is RawEngineResult => x !== null);
    if (mapped.length > 0) return mapped;
  }

  try {
    const directRes = await baseFetch(
      `https://arxiv.org/search/?query=${encodeURIComponent(query)}&searchtype=all`,
      {
        method: "GET",
        headers: {
          ...DEFAULT_HEADERS,
          Referer: "https://arxiv.org/",
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (directRes.ok) {
      return parseArxivHtml(await directRes.text());
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
  const tasks: Array<{ source: string; promise: Promise<RawEngineResult[]> }> = [];

  if (topic === "general") {
    tasks.push(
      { source: "ddg-lite", promise: runDdgLite(query, opts) },
      { source: "startpage", promise: runStartpage(query, opts) },
      { source: "marginalia", promise: runMarginalia(query, opts) },
      { source: "qwant", promise: runQwant(query, opts) },
      { source: "wikipedia", promise: runWikipedia(query, opts) },
    );
  } else if (topic === "news") {
    tasks.push(
      { source: "ddg-lite", promise: runDdgLite(query, opts) },
      { source: "startpage", promise: runStartpage(query, opts) },
      { source: "qwant", promise: runQwant(query, opts) },
      { source: "hacker-news", promise: runHackerNews(query, true, opts) },
    );
  } else if (topic === "code") {
    tasks.push(
      { source: "ddg-lite", promise: runDdgLite(query, opts) },
      { source: "marginalia", promise: runMarginalia(query, opts) },
      { source: "github", promise: runGitHub(query, opts) },
      { source: "hacker-news", promise: runHackerNews(query, false, opts) },
    );
  } else if (topic === "research") {
    tasks.push(
      { source: "arxiv", promise: runArxiv(query, opts) },
      { source: "wikipedia", promise: runWikipedia(query, opts) },
      { source: "startpage", promise: runStartpage(query, opts) },
    );
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
