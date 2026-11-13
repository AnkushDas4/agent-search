import { call } from "api-anything";
import { parseHTML } from "linkedom";
import { ensureApiAnythingEnv } from "../api-anything-env.js";
import { getMarginaliaApiKey, getSedniumBaseUrl } from "../catalog.js";
import type { RawEngineResult, SearchTopic } from "../types.js";
import { canonicalizeUrlForDedup, unwrapResultUrl } from "./normalize.js";

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
  kind: "spec" | "catalog" | "direct";
  source: string;
}

export const REGISTERED_PROVIDERS: EngineStatus[] = [
  { name: "ddg-lite", kind: "spec", source: "./sites/ddg-lite.json" },
  { name: "marginalia", kind: "spec", source: "./sites/marginalia.json" },
  { name: "arxiv", kind: "spec", source: "./sites/arxiv.json" },
  { name: "wikipedia", kind: "catalog", source: "api-anything/sites/wikipedia.json" },
  { name: "hacker-news", kind: "catalog", source: "api-anything/sites/hacker-news.json" },
  { name: "github", kind: "catalog", source: "api-anything/sites/github.json" },
  { name: "sednium-news", kind: "direct", source: "https://news.sednium.com/rss" },
  { name: "google-news-rss", kind: "direct", source: "https://news.google.com/rss/search" },
  { name: "stackexchange", kind: "direct", source: "https://api.stackexchange.com/2.3/search/advanced" },
  { name: "semantic-scholar", kind: "direct", source: "https://api.semanticscholar.org/graph/v1/paper/search" },
];

const QUERY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "how",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "over",
  "that",
  "the",
  "this",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
]);

const BROAD_CATEGORY_WORDS = new Set([
  "article",
  "articles",
  "breaking",
  "business",
  "current",
  "daily",
  "events",
  "feed",
  "global",
  "headline",
  "headlines",
  "india",
  "indian",
  "international",
  "latest",
  "news",
  "recent",
  "research",
  "science",
  "stories",
  "story",
  "tech",
  "technology",
  "today",
  "top",
  "trending",
  "update",
  "updates",
  "world",
]);

function decodeEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&rsquo;/g, "\u2019")
    .replace(/&lsquo;/g, "\u2018")
    .replace(/&rdquo;/g, "\u201D")
    .replace(/&ldquo;/g, "\u201C")
    .replace(/&mdash;/g, "\u2014")
    .replace(/&ndash;/g, "\u2013");
}

function stripHtmlTags(text: string): string {
  // Decode entities first in case description contains entity-escaped HTML tags, then strip tags and decode remaining entities
  const unwrapped = decodeEntities(text).replace(/<[^>]+>/g, " ");
  return decodeEntities(unwrapped).replace(/\s+/g, " ").trim();
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

export interface ParsedRssItem {
  title: string;
  link: string;
  pubDate: string;
  description: string;
  sourceName: string;
}

function extractXmlTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = re.exec(block);
  return m?.[1] ?? "";
}

export function parseRssItems(xml: string): ParsedRssItem[] {
  if (!xml) return [];
  const items: ParsedRssItem[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1] ?? "";
    const title = stripHtmlTags(extractXmlTag(block, "title"));
    const rawLink = decodeEntities(extractXmlTag(block, "link")).trim();
    const fallbackGuid = decodeEntities(extractXmlTag(block, "guid")).trim();
    const linkCandidate = rawLink || (fallbackGuid.startsWith("http") ? fallbackGuid : "");
    const link = unwrapResultUrl(linkCandidate);
    if (!title || !link) continue;

    const pubDate = stripHtmlTags(extractXmlTag(block, "pubDate"));
    const description = stripHtmlTags(extractXmlTag(block, "description"));
    const sourceName = stripHtmlTags(extractXmlTag(block, "source"));

    items.push({
      title,
      link,
      pubDate,
      description,
      sourceName,
    });
  }

  return items;
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

export function parseGoogleNewsRss(xml: string): RawEngineResult[] {
  return parseRssItems(xml).map((item) => {
    const meta = [item.sourceName, item.pubDate].filter(Boolean).join(" · ");
    return {
      title: item.title,
      url: item.link,
      snippet: meta || item.description,
      source: "google-news-rss",
    };
  });
}

export function parseStackExchangeJson(payload: unknown): RawEngineResult[] {
  if (!payload || typeof payload !== "object") return [];
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];

  const results: RawEngineResult[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as {
      title?: unknown;
      link?: unknown;
      score?: unknown;
      is_answered?: unknown;
      tags?: unknown;
    };
    const url = unwrapResultUrl(String(item.link ?? ""));
    const title = stripHtmlTags(String(item.title ?? ""));
    if (!url || !title) continue;

    const parts: string[] = ["Stack Overflow"];
    if (typeof item.score === "number") {
      parts.push(`score: ${item.score}`);
    }
    if (item.is_answered === true) {
      parts.push("answered");
    }
    if (Array.isArray(item.tags) && item.tags.length > 0) {
      parts.push(item.tags.slice(0, 4).map(String).join(", "));
    }

    results.push({
      title,
      url,
      snippet: parts.join(" · "),
      source: "stackexchange",
    });
  }

  return results;
}

export function parseSemanticScholarJson(payload: unknown): RawEngineResult[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const results: RawEngineResult[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const paper = raw as {
      paperId?: unknown;
      title?: unknown;
      url?: unknown;
      abstract?: unknown;
      year?: unknown;
    };
    const fallbackUrl =
      typeof paper.paperId === "string" && paper.paperId.trim()
        ? `https://www.semanticscholar.org/paper/${paper.paperId.trim()}`
        : "";
    const url = unwrapResultUrl(String(paper.url ?? fallbackUrl));
    const title = stripHtmlTags(String(paper.title ?? ""));
    if (!url || !title) continue;

    const yearPrefix = typeof paper.year === "number" ? `[${paper.year}] ` : "";
    const abstract = paper.abstract ? stripHtmlTags(String(paper.abstract)) : "";
    results.push({
      title,
      url,
      snippet: `${yearPrefix}${abstract}`.trim(),
      source: "semantic-scholar",
    });
  }

  return results;
}

export function selectSedniumFeedPaths(query: string, topic: SearchTopic): string[] {
  if (topic === "code") {
    return ["/rss/technology"];
  }
  if (topic === "research") {
    return ["/rss/science"];
  }

  const paths = new Set<string>(["/rss"]);
  const lower = query.toLowerCase();

  if (/\b(india|indian|bengal|delhi|mumbai)\b/i.test(lower)) {
    paths.add("/rss/india");
  }
  if (/\b(world|global|international|geopolitics|europe|asia|middle\s+east|ukraine|china)\b/i.test(lower)) {
    paths.add("/rss/world");
  }
  if (/\b(business|economy|economic|market|markets|finance|financial|stock|stocks|startup|trade|earnings)\b/i.test(lower)) {
    paths.add("/rss/business");
  }

  return [...paths];
}

export function parseSedniumRssAndFilter(xmlFeeds: Array<{ path: string; xml: string }>, query: string): RawEngineResult[] {
  const seenUrls = new Set<string>();
  const collected: Array<{ item: ParsedRssItem; path: string; feedRank: number }> = [];

  for (const feed of xmlFeeds) {
    const parsed = parseRssItems(feed.xml);
    parsed.forEach((item, idx) => {
      const canonical = canonicalizeUrlForDedup(item.link);
      if (seenUrls.has(canonical)) return;
      seenUrls.add(canonical);
      collected.push({ item, path: feed.path, feedRank: idx });
    });
  }

  if (collected.length === 0) return [];

  const allTokens = (query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).filter((t) => !QUERY_STOPWORDS.has(t));
  const specificTokens = allTokens.filter((t) => !BROAD_CATEGORY_WORDS.has(t));
  const isBroadQuery = specificTokens.length === 0;
  const searchTokens = specificTokens.length > 0 ? specificTokens : allTokens;
  const normalizedPhrase = query.trim().toLowerCase();

  const toEngineResult = (item: ParsedRssItem): RawEngineResult => {
    const prefix = item.pubDate ? `[${item.pubDate}] ` : "";
    return {
      title: item.title,
      url: item.link,
      snippet: `${prefix}${item.description}`.trim(),
      source: "sednium-news",
    };
  };

  const scored = collected.map((entry, idx) => {
    const titleLower = entry.item.title.toLowerCase();
    const descLower = entry.item.description.toLowerCase();
    let score = 0;

    if (normalizedPhrase.length >= 4 && (titleLower.includes(normalizedPhrase) || descLower.includes(normalizedPhrase))) {
      score += 4;
    }

    for (const token of searchTokens) {
      if (titleLower.includes(token)) score += 3;
      else if (descLower.includes(token)) score += 1;
    }

    // Prefer targeted category subfeed (/rss/india, /rss/world, /rss/business) on broad multi-feed fetches
    const subfeedBonus = entry.path !== "/rss" ? 0.5 : 0;
    return { entry, idx, score, subfeedBonus };
  });

  const matched = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score + b.subfeedBonus - (a.score + a.subfeedBonus) || a.idx - b.idx);

  if (matched.length > 0) {
    if (!isBroadQuery) {
      return matched.slice(0, 15).map((m) => toEngineResult(m.entry.item));
    }
    const used = new Set(matched.map((m) => m.idx));
    const remaining = scored
      .filter((s) => !used.has(s.idx))
      .sort((a, b) => b.subfeedBonus - a.subfeedBonus || a.idx - b.idx);
    return [...matched, ...remaining].slice(0, 10).map((m) => toEngineResult(m.entry.item));
  }

  if (isBroadQuery) {
    return scored
      .sort((a, b) => b.subfeedBonus - a.subfeedBonus || a.idx - b.idx)
      .slice(0, 10)
      .map((s) => toEngineResult(s.entry.item));
  }

  return [];
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

async function runMarginalia(query: string, opts: EngineCallOptions): Promise<RawEngineResult[]> {
  ensureApiAnythingEnv();
  const baseFetch = opts.fetchImpl ?? globalThis.fetch;
  const apiKey = getMarginaliaApiKey();

  // Inject dynamic MARGINALIA_API_KEY header while preserving response capture
  let lastHtml = "";
  let lastStatus = 0;
  const capturingApiKeyFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.delete("api-key");
    headers.set("API-Key", apiKey);
    const response = await baseFetch(input, { ...init, headers });
    lastStatus = response.status;
    try {
      lastHtml = await response.clone().text();
    } catch {
      lastHtml = "";
    }
    return response;
  };

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const res = await call(
    "marginalia",
    "search",
    { query },
    {
      maxTier: 1,
      callOnly: true,
      timeoutMs,
      fetchImpl: capturingApiKeyFetch,
    },
  );

  if (res.ok && res.data) {
    const parsed = parseMarginaliaJson(res.data);
    if (parsed.length > 0) return parsed;
  }

  // Rate-limited (HTTP 429/503): return gracefully without retrying
  if (lastStatus === 429 || lastStatus === 503) {
    return [];
  }

  if (lastHtml && lastStatus >= 200 && lastStatus < 300) {
    try {
      const parsed = parseMarginaliaJson(JSON.parse(lastHtml));
      if (parsed.length > 0) return parsed;
    } catch {
      // ignore invalid JSON
    }
  }

  try {
    const directRes = await baseFetch(
      `https://api2.marginalia-search.com/search?query=${encodeURIComponent(query)}&count=10`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "API-Key": apiKey,
          "User-Agent": "agent-search/1.0 (+https://github.com/AnkushDas4/agent-search)",
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (directRes.status === 429 || directRes.status === 503) {
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

async function runSedniumNews(query: string, topic: SearchTopic, opts: EngineCallOptions): Promise<RawEngineResult[]> {
  const baseFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = getSedniumBaseUrl();
  const feedPaths = selectSedniumFeedPaths(query, topic);

  const fetchedFeeds = await Promise.allSettled(
    feedPaths.map(async (feedPath) => {
      const res = await baseFetch(`${baseUrl}${feedPath}`, {
        method: "GET",
        headers: {
          Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
          "User-Agent": "agent-search/1.0 (+https://github.com/AnkushDas4/agent-search)",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { path: feedPath, xml: "" };
      return { path: feedPath, xml: await res.text() };
    }),
  );

  const xmlFeeds = fetchedFeeds
    .filter((f): f is PromiseFulfilledResult<{ path: string; xml: string }> => f.status === "fulfilled" && Boolean(f.value.xml))
    .map((f) => f.value);

  if (xmlFeeds.length === 0) return [];
  return parseSedniumRssAndFilter(xmlFeeds, query);
}

async function runGoogleNewsRss(query: string, opts: EngineCallOptions): Promise<RawEngineResult[]> {
  const baseFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await baseFetch(url, {
      method: "GET",
      headers: {
        Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        "User-Agent": "agent-search/1.0 (+https://github.com/AnkushDas4/agent-search)",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    return parseGoogleNewsRss(await res.text());
  } catch {
    return [];
  }
}

async function runStackExchange(query: string, opts: EngineCallOptions): Promise<RawEngineResult[]> {
  const baseFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=10`;
    const res = await baseFetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "agent-search/1.0 (+https://github.com/AnkushDas4/agent-search)",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    return parseStackExchangeJson(await res.json());
  } catch {
    return [];
  }
}

async function runSemanticScholar(query: string, opts: EngineCallOptions): Promise<RawEngineResult[]> {
  const baseFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=10&fields=title,url,abstract,year`;
    const res = await baseFetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "agent-search/1.0 (+https://github.com/AnkushDas4/agent-search)",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    return parseSemanticScholarJson(await res.json());
  } catch {
    return [];
  }
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
      { source: "marginalia", promise: runMarginalia(query, opts) },
      { source: "wikipedia", promise: runWikipedia(query, opts) },
    );
  } else if (topic === "code") {
    tasks.push(
      { source: "github", promise: runGitHub(query, opts) },
      { source: "stackexchange", promise: runStackExchange(query, opts) },
      { source: "hacker-news", promise: runHackerNews(query, false, opts) },
      { source: "ddg-lite", promise: runDdgLite(query, opts) },
      { source: "sednium-news", promise: runSedniumNews(query, "code", opts) },
    );
  } else if (topic === "news") {
    tasks.push(
      { source: "sednium-news", promise: runSedniumNews(query, "news", opts) },
      { source: "google-news-rss", promise: runGoogleNewsRss(query, opts) },
      { source: "hacker-news", promise: runHackerNews(query, true, opts) },
      { source: "ddg-lite", promise: runDdgLite(query, opts) },
    );
  } else if (topic === "research") {
    tasks.push(
      { source: "semantic-scholar", promise: runSemanticScholar(query, opts) },
      { source: "arxiv", promise: runArxiv(query, opts) },
      { source: "wikipedia", promise: runWikipedia(query, opts) },
      { source: "sednium-news", promise: runSedniumNews(query, "research", opts) },
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
