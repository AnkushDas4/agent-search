import { call, describeOperation, listSites, loadSite } from "api-anything";
import { ensureApiAnythingEnv } from "./api-anything-env.js";
import type { CatalogCallResponse, CatalogOperationSummary, CatalogResponse, CatalogSiteSummary } from "./types.js";

const DEFAULT_CATALOG_TIMEOUT_MS = 12_000;

export function getMarginaliaApiKey(): string {
  return process.env.MARGINALIA_API_KEY?.trim() || "public";
}

export function getSedniumBaseUrl(): string {
  return (process.env.SEDNIUM_NEWS_BASE_URL?.trim() || "https://news.sednium.com").replace(/\/+$/, "");
}

export function listOperations(siteName: string): CatalogOperationSummary[] {
  ensureApiAnythingEnv();
  const loaded = loadSite(siteName);
  if (!loaded) return [];
  const { site } = loaded;
  return site.operations
    .filter((op) => op.readOnly)
    .map((op) => {
      const described = describeOperation(site, op.name);
      return {
        operation: op.name,
        ...(op.description ? { description: op.description } : {}),
        readOnly: op.readOnly,
        minTier: op.minTier ?? 1,
        params: described.params as unknown as Record<string, unknown>,
        ...(described.output ? { output: described.output as unknown as Record<string, unknown> } : {}),
        ...(described.links?.length ? { links: described.links } : {}),
      };
    });
}

export function listCatalog(options: { site?: string; query?: string } = {}): CatalogResponse {
  ensureApiAnythingEnv();
  const siteFilter = options.site?.trim().toLowerCase();
  const queryFilter = options.query?.trim().toLowerCase();

  const names = siteFilter ? listSites().filter((n) => n.toLowerCase() === siteFilter) : listSites();
  const sites: CatalogSiteSummary[] = [];

  for (const name of names) {
    let loaded;
    try {
      loaded = loadSite(name);
    } catch {
      continue;
    }
    if (!loaded) continue;

    const { site, source } = loaded;
    const allOps = listOperations(name);

    let matchedOps = allOps;
    if (queryFilter) {
      const siteMetaMatches =
        site.name.toLowerCase().includes(queryFilter) ||
        (site.displayName ?? "").toLowerCase().includes(queryFilter) ||
        (site.description ?? "").toLowerCase().includes(queryFilter) ||
        site.baseUrl.toLowerCase().includes(queryFilter);

      if (!siteMetaMatches) {
        matchedOps = allOps.filter(
          (op) =>
            op.operation.toLowerCase().includes(queryFilter) ||
            (op.description ?? "").toLowerCase().includes(queryFilter),
        );
      }
      if (matchedOps.length === 0) continue;
    }

    sites.push({
      site: site.name,
      ...(site.displayName ? { displayName: site.displayName } : {}),
      baseUrl: site.baseUrl,
      ...(site.description ? { description: site.description } : {}),
      source,
      operations: matchedOps,
    });
  }

  const total_operations = sites.reduce((sum, s) => sum + s.operations.length, 0);
  return {
    total_sites: sites.length,
    total_operations,
    sites,
  };
}

function wrapMarginaliaFetch(baseFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("api2.marginalia-search.com")) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.delete("api-key");
      headers.set("API-Key", getMarginaliaApiKey());
      return baseFetch(input, { ...init, headers });
    }
    return baseFetch(input, init);
  };
}

export async function callCatalogOperation(
  input: { site: string; operation: string; params?: Record<string, unknown> },
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<CatalogCallResponse> {
  ensureApiAnythingEnv();

  let loaded;
  try {
    loaded = loadSite(input.site);
  } catch (err) {
    return {
      site: input.site,
      operation: input.operation,
      ok: false,
      class: "error" as const,
      reason: err instanceof Error ? err.message : String(err),
      ms: 0,
    };
  }

  const targetOp = loaded?.site.operations.find((o) => o.name === input.operation);
  if (targetOp && !targetOp.readOnly) {
    return {
      site: input.site,
      operation: input.operation,
      ok: false,
      class: "refused" as const,
      reason: `Operation "${input.operation}" on "${input.site}" is not read-only and cannot run on Tier-1 read catalog.`,
      ms: 0,
    };
  }

  const baseFetch = opts.fetchImpl ?? globalThis.fetch;
  const fetchImpl = input.site === "marginalia" ? wrapMarginaliaFetch(baseFetch) : opts.fetchImpl;

  const res = await call(input.site, input.operation, input.params ?? {}, {
    maxTier: 1,
    callOnly: true,
    timeoutMs: opts.timeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS,
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  return {
    site: input.site,
    operation: input.operation,
    ...res,
  };
}
