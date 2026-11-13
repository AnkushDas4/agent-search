import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { allowLocalhostFetch } from "../config.js";
import type { ExtractFailedItem, ExtractFormat, ExtractResultItem } from "../types.js";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 12_000;

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

const ASSET_EXTENSION_RE =
  /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff|pdf|zip|tar|gz|bz2|xz|7z|rar|css|mjs|cjs|js|map|woff2?|ttf|eot|otf|mp4|webm|mov|mp3|wav|ogg|m4a|exe|dmg|deb|rpm)(?:$|\?)/i;

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "::" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }

  // IPv4 private/reserved ranges
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return true;
    }
  }

  // IPv6 private/link-local/ULA
  if (host.includes(":")) {
    if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("::ffff:127.")) {
      return true;
    }
  }

  return false;
}

export function assertSafePublicUrl(rawUrl: string, skipCheck = false): URL {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  if (!skipCheck && !allowLocalhostFetch() && isPrivateOrLoopbackHost(parsed.hostname)) {
    throw new Error(`Blocked private or loopback address: ${parsed.hostname}`);
  }
  return parsed;
}

export interface FetchPageResult {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
}

export interface FetchPageOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  skipSsrfCheck?: boolean;
}

export async function fetchPageWithRedirects(
  rawUrl: string,
  options: FetchPageOptions = {},
): Promise<FetchPageResult> {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let currentUrl = assertSafePublicUrl(rawUrl, options.skipSsrfCheck).toString();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchFn(currentUrl, {
      method: "GET",
      headers: BROWSER_HEADERS,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new Error(`Redirect HTTP ${res.status} missing Location header`);
      }
      const nextUrl = new URL(location, currentUrl).toString();
      currentUrl = assertSafePublicUrl(nextUrl, options.skipSsrfCheck).toString();
      continue;
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText || "Error"}`);
    }

    const contentType = (res.headers.get("content-type") ?? "text/html").toLowerCase();
    const contentLength = Number.parseInt(res.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new Error(`Response too large (${contentLength} bytes)`);
    }

    const body = await readBodyLimited(res, MAX_RESPONSE_BYTES);
    return {
      finalUrl: res.url || currentUrl,
      status: res.status,
      contentType,
      body,
    };
  }

  throw new Error(`Too many redirects (> ${MAX_REDIRECTS})`);
}

async function readBodyLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error(`Response exceeded ${maxBytes} byte limit`);
    }
    return text;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error(`Response exceeded ${maxBytes} byte limit`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function createTurndownService(baseUrl: string): TurndownService {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
  });

  turndown.remove(["script", "style", "noscript", "iframe"]);
  turndown.addRule("stripSvg", {
    filter: (node) => node.nodeName.toLowerCase() === "svg",
    replacement: () => "",
  });

  turndown.addRule("absoluteLinks", {
    filter: (node) => node.nodeName === "A" && Boolean((node as unknown as Element).getAttribute?.("href")),
    replacement: (content, node) => {
      const el = node as unknown as Element;
      const rawHref = el.getAttribute("href") ?? "";
      const text = content.trim();
      if (!text) return "";
      let href = rawHref;
      try {
        href = new URL(rawHref, baseUrl).toString();
      } catch {
        // Keep raw href if invalid
      }
      return `[${text}](${href})`;
    },
  });

  return turndown;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToExtractedContent(
  html: string,
  pageUrl: string,
  format: ExtractFormat = "markdown",
): { title: string; content: string; word_count: number; links: string[] } {
  const { document } = parseHTML(html);

  // Collect same-origin links before Readability mutates the DOM
  const links = extractLinksFromDocument(document as unknown as Document, pageUrl);

  // Ensure base URL exists for Readability link resolution
  try {
    const head = document.querySelector("head");
    if (head && !document.querySelector("base")) {
      const baseEl = document.createElement("base");
      baseEl.setAttribute("href", pageUrl);
      head.appendChild(baseEl);
    }
  } catch {
    // ignore DOM mutation errors
  }

  const rawTitle = document.querySelector("title")?.textContent?.trim() || "";

  // Clone or parse fresh doc for Readability because Readability mutates nodes
  const { document: readabilityDoc } = parseHTML(html);
  let article: ReturnType<Readability<string>["parse"]> = null;
  try {
    const reader = new Readability(readabilityDoc as unknown as Document, {
      charThreshold: 120,
    });
    article = reader.parse();
  } catch {
    article = null;
  }

  const title = (article?.title || rawTitle || pageUrl).replace(/\s+/g, " ").trim();

  if (format === "text") {
    let text = article?.textContent?.trim() ?? "";
    if (text.length < 40) {
      const fallbackEl =
        document.querySelector("main") ?? document.querySelector("article") ?? document.querySelector("body") ?? document.documentElement;
      for (const garbage of fallbackEl?.querySelectorAll("script, style, noscript, svg") ?? []) {
        garbage.remove();
      }
      text = fallbackEl?.textContent ?? "";
    }
    const cleanText = normalizeWhitespace(text);
    return {
      title,
      content: cleanText,
      word_count: countWords(cleanText),
      links,
    };
  }

  let articleHtml = article?.content ?? "";
  if (!articleHtml || articleHtml.replace(/<[^>]+>/g, "").trim().length < 40) {
    const fallbackEl =
      document.querySelector("main") ?? document.querySelector("article") ?? document.querySelector("body") ?? document.documentElement;
    if (fallbackEl) {
      for (const garbage of fallbackEl.querySelectorAll("script, style, noscript, svg")) {
        garbage.remove();
      }
      articleHtml = fallbackEl.innerHTML ?? "";
    }
  }

  const turndown = createTurndownService(pageUrl);
  const markdown = normalizeWhitespace(turndown.turndown(articleHtml || html));

  return {
    title,
    content: markdown,
    word_count: countWords(markdown),
    links,
  };
}

function extractLinksFromDocument(document: Document, baseUrl: string): string[] {
  let seedOrigin: string;
  try {
    seedOrigin = new URL(baseUrl).origin;
  } catch {
    return [];
  }

  const discovered: string[] = [];
  const seen = new Set<string>();
  const anchors = document.querySelectorAll("a[href]");

  for (const anchor of anchors) {
    const href = anchor.getAttribute("href")?.trim();
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("javascript:")) {
      continue;
    }
    try {
      const resolved = new URL(href, baseUrl);
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
      if (resolved.origin !== seedOrigin) continue;
      resolved.hash = "";
      const clean = resolved.toString();
      if (ASSET_EXTENSION_RE.test(resolved.pathname)) continue;
      if (!seen.has(clean)) {
        seen.add(clean);
        discovered.push(clean);
      }
    } catch {
      // skip invalid URLs
    }
  }

  return discovered;
}

export async function extractSingleUrl(
  rawUrl: string,
  format: ExtractFormat = "markdown",
  options: FetchPageOptions = {},
): Promise<ExtractResultItem & { links: string[] }> {
  const page = await fetchPageWithRedirects(rawUrl, options);

  if (page.contentType.includes("text/plain") || page.contentType.includes("text/markdown")) {
    const clean = normalizeWhitespace(page.body);
    return {
      url: page.finalUrl,
      title: page.finalUrl,
      content: clean,
      word_count: countWords(clean),
      links: [],
    };
  }

  if (page.contentType.includes("application/json")) {
    let formatted = page.body;
    try {
      formatted = JSON.stringify(JSON.parse(page.body), null, 2);
    } catch {
      // keep raw
    }
    const content = format === "markdown" ? `\`\`\`json\n${formatted}\n\`\`\`` : formatted;
    return {
      url: page.finalUrl,
      title: page.finalUrl,
      content,
      word_count: countWords(content),
      links: [],
    };
  }

  const extracted = htmlToExtractedContent(page.body, page.finalUrl, format);
  return {
    url: page.finalUrl,
    title: extracted.title,
    content: extracted.content,
    word_count: extracted.word_count,
    links: extracted.links,
  };
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx]!, idx);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function extractManyUrls(
  urls: string[],
  format: ExtractFormat = "markdown",
  options: FetchPageOptions & { concurrency?: number } = {},
): Promise<{ results: ExtractResultItem[]; failed: ExtractFailedItem[] }> {
  const concurrency = options.concurrency ?? 3;
  const settled = await mapWithConcurrency(urls, concurrency, async (url) => {
    try {
      const extracted = await extractSingleUrl(url, format, options);
      return {
        ok: true as const,
        item: {
          url: extracted.url,
          title: extracted.title,
          content: extracted.content,
          word_count: extracted.word_count,
        },
      };
    } catch (err) {
      return {
        ok: false as const,
        failed: {
          url,
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  });

  const results: ExtractResultItem[] = [];
  const failed: ExtractFailedItem[] = [];
  for (const entry of settled) {
    if (entry.ok) results.push(entry.item);
    else failed.push(entry.failed);
  }
  return { results, failed };
}
