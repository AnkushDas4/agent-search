import type { RawEngineResult, SearchResultItem } from "../types.js";

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "fbclid",
  "yclid",
  "mc_cid",
  "mc_eid",
  "ref_src",
]);

const ENGINE_WEIGHTS: Record<string, number> = {
  "ddg-lite": 1.0,
  startpage: 1.0,
  qwant: 1.0,
  marginalia: 0.9,
  arxiv: 1.05,
  github: 1.05,
  "hacker-news": 0.95,
  wikipedia: 0.9,
};

export function unwrapResultUrl(rawUrl: string): string | null {
  let trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("javascript:") || trimmed.startsWith("mailto:")) {
    return null;
  }

  if (trimmed.startsWith("//")) {
    trimmed = `https:${trimmed}`;
  } else if (trimmed.startsWith("/l/?")) {
    trimmed = `https://duckduckgo.com${trimmed}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  // Filter DuckDuckGo internal ad click-tracking URLs
  if (parsed.hostname.endsWith("duckduckgo.com")) {
    if (parsed.pathname === "/y.js") return null;
    if (parsed.pathname === "/l/" || parsed.pathname === "/l") {
      const target = parsed.searchParams.get("uddg");
      if (!target) return null;
      try {
        const decoded = decodeURIComponent(target);
        return unwrapResultUrl(decoded);
      } catch {
        return null;
      }
    }
  }

  // Filter Startpage ad/captcha redirects and unwrap Startpage proxy/redirect URLs if present
  if (parsed.hostname.endsWith("startpage.com")) {
    if (parsed.pathname.startsWith("/sp/captcha") || parsed.pathname.startsWith("/do/")) return null;
    if (parsed.pathname.startsWith("/sp/")) {
      const target = parsed.searchParams.get("url") ?? parsed.searchParams.get("u");
      if (target) {
        return unwrapResultUrl(target);
      }
      return null;
    }
  }
  if (
    parsed.hostname.includes("clickserve") ||
    (parsed.hostname.endsWith("bing.com") && parsed.pathname.startsWith("/aclick"))
  ) {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  return parsed.toString();
}

export function canonicalizeUrlForDedup(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.searchParams.sort();
    let pathname = parsed.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }
    const qs = parsed.searchParams.toString();
    return `${parsed.protocol}//${host}${parsed.port ? `:${parsed.port}` : ""}${pathname}${qs ? `?${qs}` : ""}`;
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

function normalizeDomainPattern(pattern: string): string {
  let cleaned = pattern.trim().toLowerCase();
  if (cleaned.startsWith("http://") || cleaned.startsWith("https://")) {
    try {
      cleaned = new URL(cleaned).hostname.toLowerCase();
    } catch {
      // keep cleaned
    }
  }
  cleaned = cleaned.split("/")[0] ?? cleaned;
  return cleaned.replace(/^www\./, "");
}

export function matchesDomainFilter(
  rawUrl: string,
  includeDomains?: string[],
  excludeDomains?: string[],
): boolean {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }

  const hostMatches = (pattern: string): boolean => {
    const normalized = normalizeDomainPattern(pattern);
    if (!normalized) return false;
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  };

  if (includeDomains && includeDomains.length > 0) {
    if (!includeDomains.some(hostMatches)) return false;
  }

  if (excludeDomains && excludeDomains.length > 0) {
    if (excludeDomains.some(hostMatches)) return false;
  }

  return true;
}

interface AggregatedEntry {
  title: string;
  url: string;
  snippet: string;
  sources: Set<string>;
  rawScore: number;
}

export function rankAndDeduplicateResults(
  engineBatches: Array<{ source: string; items: RawEngineResult[] }>,
  options: {
    includeDomains?: string[];
    excludeDomains?: string[];
    maxResults: number;
  },
): SearchResultItem[] {
  const byCanonical = new Map<string, AggregatedEntry>();

  for (const batch of engineBatches) {
    const weight = ENGINE_WEIGHTS[batch.source] ?? 0.9;
    batch.items.forEach((item, rank) => {
      const cleanUrl = unwrapResultUrl(item.url);
      if (!cleanUrl) return;
      if (!matchesDomainFilter(cleanUrl, options.includeDomains, options.excludeDomains)) return;

      const canonical = canonicalizeUrlForDedup(cleanUrl);
      const positionScore = weight / (1 + rank * 0.15);
      const cleanTitle = item.title.replace(/\s+/g, " ").trim() || cleanUrl;
      const cleanSnippet = item.snippet.replace(/\s+/g, " ").trim();

      const existing = byCanonical.get(canonical);
      if (!existing) {
        byCanonical.set(canonical, {
          title: cleanTitle,
          url: cleanUrl,
          snippet: cleanSnippet,
          sources: new Set([batch.source]),
          rawScore: positionScore,
        });
      } else {
        if (!existing.sources.has(batch.source)) {
          existing.sources.add(batch.source);
          existing.rawScore += positionScore;
        }
        if (cleanSnippet.length > existing.snippet.length) {
          existing.snippet = cleanSnippet;
        }
        if (existing.title === existing.url && cleanTitle !== cleanUrl) {
          existing.title = cleanTitle;
        } else if (cleanTitle.length > existing.title.length && existing.title.length < 18) {
          existing.title = cleanTitle;
        }
      }
    });
  }

  const scored = [...byCanonical.values()].map((entry) => {
    const consensusBoost = entry.sources.size > 1 ? (entry.sources.size - 1) * 0.45 : 0;
    return {
      ...entry,
      finalScore: entry.rawScore + consensusBoost,
    };
  });

  scored.sort((a, b) => b.finalScore - a.finalScore);
  const topScore = scored[0]?.finalScore || 1;

  return scored.slice(0, options.maxResults).map((entry) => ({
    title: entry.title,
    url: entry.url,
    snippet: entry.snippet,
    score: Math.min(1, Math.round((entry.finalScore / topScore) * 10000) / 10000),
    source: [...entry.sources].join(", "),
  }));
}
