import type { SearchCache } from "../cache.js";
import {
  extractManyUrls,
  extractSingleUrl,
  type FetchPageOptions,
  mapWithConcurrency,
} from "../extract/readability.js";
import type {
  CrawlPageItem,
  CrawlRequest,
  CrawlResponse,
  ExtractFailedItem,
  ExtractRequest,
  ExtractResponse,
  RawEngineResult,
  ResearchCitation,
  ResearchRequest,
  ResearchResponse,
  ResearchSourceItem,
  SearchRequest,
  SearchResponse,
} from "../types.js";
import { fanOutSearchEngines, runGitHub, runHackerNews } from "./engines.js";
import { canonicalizeUrlForDedup, rankAndDeduplicateResults } from "./normalize.js";

export interface ServiceDeps {
  cache: SearchCache;
  fetchImpl?: typeof fetch;
  skipSsrfCheck?: boolean;
}

function makeSearchCacheKey(req: SearchRequest): string {
  return JSON.stringify({
    kind: "search",
    query: req.query.trim().toLowerCase(),
    max_results: req.max_results,
    search_depth: req.search_depth,
    topic: req.topic,
    include_domains: [...(req.include_domains ?? [])].map((d) => d.toLowerCase()).sort(),
    exclude_domains: [...(req.exclude_domains ?? [])].map((d) => d.toLowerCase()).sort(),
    include_raw_content: req.include_raw_content,
  });
}

function makeResearchCacheKey(req: ResearchRequest): string {
  return JSON.stringify({
    kind: "research",
    topic: req.topic.trim().toLowerCase(),
    max_sources: req.max_sources,
  });
}

export async function searchWeb(req: SearchRequest, deps: ServiceDeps): Promise<SearchResponse> {
  const startedAt = Date.now();
  const cacheKey = makeSearchCacheKey(req);
  const cached = deps.cache.get<Omit<SearchResponse, "cached" | "response_time_ms">>(cacheKey);
  if (cached) {
    return {
      ...cached,
      cached: true,
      response_time_ms: Date.now() - startedAt,
    };
  }

  const batches = await fanOutSearchEngines(req.query, req.topic, {
    fetchImpl: deps.fetchImpl,
  });

  const results = rankAndDeduplicateResults(batches, {
    includeDomains: req.include_domains,
    excludeDomains: req.exclude_domains,
    maxResults: req.max_results,
  });

  if ((req.search_depth === "advanced" || req.include_raw_content) && results.length > 0) {
    const topUrls = results.slice(0, Math.min(5, results.length)).map((r) => r.url);
    const extracted = await extractManyUrls(topUrls, "markdown", {
      fetchImpl: deps.fetchImpl,
      skipSsrfCheck: deps.skipSsrfCheck,
      concurrency: 5,
    });
    const byUrl = new Map<string, string>();
    for (const item of extracted.results) {
      byUrl.set(canonicalizeUrlForDedup(item.url), item.content);
    }
    for (let i = 0; i < Math.min(5, results.length); i++) {
      const result = results[i]!;
      const directIdx = topUrls.indexOf(result.url);
      const fromExact = extracted.results.find((e) => e.url === result.url)?.content;
      const fromCanonical = byUrl.get(canonicalizeUrlForDedup(result.url));
      const content = fromExact ?? fromCanonical ?? (directIdx >= 0 ? undefined : undefined);
      if (content) {
        result.content = content;
      }
    }
  }

  const payload = {
    query: req.query,
    results,
  };

  if (results.length > 0) {
    deps.cache.set(cacheKey, payload);
  }

  return {
    ...payload,
    cached: false,
    response_time_ms: Date.now() - startedAt,
  };
}

export async function extractUrls(req: ExtractRequest, deps: ServiceDeps): Promise<ExtractResponse> {
  return extractManyUrls(req.urls, req.format, {
    fetchImpl: deps.fetchImpl,
    skipSsrfCheck: deps.skipSsrfCheck,
    concurrency: 3,
  });
}

function matchesIncludePaths(candidateUrl: string, includePaths?: string[]): boolean {
  if (!includePaths || includePaths.length === 0) return true;
  try {
    const pathname = new URL(candidateUrl).pathname;
    return includePaths.some((pattern) => {
      const normalized = pattern.startsWith("/") ? pattern : `/${pattern}`;
      return pathname === normalized || pathname.startsWith(normalized) || pathname.includes(pattern);
    });
  } catch {
    return false;
  }
}

function normalizeCrawlUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  parsed.hash = "";
  return parsed.toString();
}

export async function crawlSite(req: CrawlRequest, deps: ServiceDeps): Promise<CrawlResponse> {
  const startedAt = Date.now();
  const maxDepth = Math.min(2, Math.max(0, req.max_depth));
  const limit = Math.min(10, Math.max(1, req.limit));
  const seedUrl = normalizeCrawlUrl(req.url);
  const seedOrigin = new URL(seedUrl).origin;

  const visited = new Set<string>([seedUrl]);
  const pages: CrawlPageItem[] = [];
  const failed: ExtractFailedItem[] = [];
  let frontier: Array<{ url: string; depth: number }> = [{ url: seedUrl, depth: 0 }];

  const fetchOpts: FetchPageOptions = {
    fetchImpl: deps.fetchImpl,
    skipSsrfCheck: deps.skipSsrfCheck,
  };

  while (frontier.length > 0 && pages.length < limit) {
    const remaining = limit - pages.length;
    const batch = frontier.slice(0, remaining);
    frontier = frontier.slice(remaining);

    const fetched = await mapWithConcurrency(batch, 2, async (target) => {
      try {
        const extracted = await extractSingleUrl(target.url, "markdown", fetchOpts);
        return { ok: true as const, target, extracted };
      } catch (err) {
        return {
          ok: false as const,
          target,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });

    const nextLevel: Array<{ url: string; depth: number }> = [];

    for (const outcome of fetched) {
      if (!outcome.ok) {
        failed.push({ url: outcome.target.url, error: outcome.error });
        continue;
      }

      const canonicalActual = normalizeCrawlUrl(outcome.extracted.url);
      visited.add(canonicalActual);

      pages.push({
        url: outcome.extracted.url,
        depth: outcome.target.depth,
        title: outcome.extracted.title,
        content: outcome.extracted.content,
        word_count: outcome.extracted.word_count,
      });

      if (outcome.target.depth < maxDepth && pages.length + nextLevel.length < limit * 2) {
        for (const link of outcome.extracted.links) {
          try {
            const normalized = normalizeCrawlUrl(link);
            if (new URL(normalized).origin !== seedOrigin) continue;
            if (visited.has(normalized)) continue;
            if (!matchesIncludePaths(normalized, req.include_paths)) continue;
            visited.add(normalized);
            nextLevel.push({ url: normalized, depth: outcome.target.depth + 1 });
          } catch {
            // skip invalid link
          }
        }
      }
    }

    if (nextLevel.length > 0) {
      frontier.push(...nextLevel);
    }
  }

  return {
    url: seedUrl,
    pages,
    total_pages: pages.length,
    failed,
    response_time_ms: Date.now() - startedAt,
  };
}

export function expandResearchTopic(topic: string): string[] {
  const clean = topic.trim();
  return [
    clean,
    `${clean} technical architecture implementation`,
    `${clean} latest updates 2026`,
  ];
}

function truncateExcerpt(markdown: string, maxChars = 4000): string {
  const clean = markdown.trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars).trimEnd()}\n\n[...truncated...]`;
}

export async function deepResearch(req: ResearchRequest, deps: ServiceDeps): Promise<ResearchResponse> {
  const startedAt = Date.now();
  const cacheKey = makeResearchCacheKey(req);
  const cached = deps.cache.get<Omit<ResearchResponse, "cached" | "response_time_ms">>(cacheKey);
  if (cached) {
    return {
      ...cached,
      cached: true,
      response_time_ms: Date.now() - startedAt,
    };
  }

  const queries = expandResearchTopic(req.topic);
  const engineOpts = { fetchImpl: deps.fetchImpl };

  const angleBatches = await Promise.all(queries.map((q) => fanOutSearchEngines(q, "general", engineOpts)));
  let allBatches: Array<{ source: string; items: RawEngineResult[] }> = angleBatches.flat();

  let ranked = rankAndDeduplicateResults(allBatches, {
    maxResults: Math.max(req.max_sources * 2, 10),
  });

  // If general web search returned few results (e.g., restricted sandbox or niche code topic),
  // supplement with GitHub & Hacker News catalog operations.
  if (ranked.length < req.max_sources) {
    const [ghRes, hnRes] = await Promise.allSettled([
      runGitHub(req.topic, engineOpts),
      runHackerNews(req.topic, false, engineOpts),
    ]);
    const extraBatches: Array<{ source: string; items: RawEngineResult[] }> = [
      { source: "github", items: ghRes.status === "fulfilled" ? ghRes.value : [] },
      { source: "hacker-news", items: hnRes.status === "fulfilled" ? hnRes.value : [] },
    ];
    allBatches = [...allBatches, ...extraBatches];
    ranked = rankAndDeduplicateResults(allBatches, {
      maxResults: Math.max(req.max_sources * 2, 10),
    });
  }

  const candidates = ranked.slice(0, req.max_sources);
  const extracted = await extractManyUrls(
    candidates.map((c) => c.url),
    "markdown",
    {
      fetchImpl: deps.fetchImpl,
      skipSsrfCheck: deps.skipSsrfCheck,
      concurrency: 3,
    },
  );

  const byCanonical = new Map<string, (typeof extracted.results)[number]>();
  for (const item of extracted.results) {
    byCanonical.set(canonicalizeUrlForDedup(item.url), item);
  }

  const sources: ResearchSourceItem[] = [];
  const citations: ResearchCitation[] = [];

  for (const candidate of candidates) {
    const hit =
      extracted.results.find((item) => item.url === candidate.url) ??
      byCanonical.get(canonicalizeUrlForDedup(candidate.url));
    if (!hit) continue;

    const index = sources.length + 1;
    const citation: ResearchCitation = {
      index,
      title: hit.title || candidate.title,
      url: hit.url,
      snippet: candidate.snippet,
      source: candidate.source,
      word_count: hit.word_count,
    };
    citations.push(citation);
    sources.push({
      ...citation,
      content: hit.content,
    });
  }

  const contextLines: string[] = [
    `# Research Context: ${req.topic}`,
    "",
    `## Search Angles`,
    ...queries.map((q, i) => `${i + 1}. \`${q}\``),
    "",
    `## Sources & Citations`,
    ...(citations.length > 0
      ? citations.map((c) => `- [${c.index}] [${c.title}](${c.url}) (${c.source}, ${c.word_count} words)`)
      : ["- No sources could be extracted."]),
    "",
    `## Extracted Findings`,
  ];

  for (const src of sources) {
    contextLines.push(
      "",
      `### [${src.index}] ${src.title}`,
      `URL: ${src.url}`,
      "",
      truncateExcerpt(src.content),
    );
  }

  const payload = {
    topic: req.topic,
    queries,
    citations,
    sources,
    context_markdown: contextLines.join("\n"),
    failed: extracted.failed,
  };

  if (sources.length > 0) {
    deps.cache.set(cacheKey, payload);
  }

  return {
    ...payload,
    cached: false,
    response_time_ms: Date.now() - startedAt,
  };
}
