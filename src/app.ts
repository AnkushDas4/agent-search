import { timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ensureApiAnythingEnv } from "./api-anything-env.js";
import { SearchCache } from "./cache.js";
import { APP_VERSION, getCacheMaxEntries, getCacheTtlMs, getSearchApiKey, isVercelRuntime } from "./config.js";
import { createMcpServer } from "./mcp.js";
import { buildOpenApiSpec } from "./openapi.js";
import { REGISTERED_PROVIDERS } from "./search/engines.js";
import { crawlSite, deepResearch, extractUrls, type ServiceDeps, searchWeb } from "./search/service.js";
import {
  CrawlRequestSchema,
  ExtractRequestSchema,
  ResearchRequestSchema,
  SearchRequestSchema,
} from "./types.js";
import { renderPlaygroundHtml } from "./ui.js";

export interface AppOptions {
  cache?: SearchCache;
  fetchImpl?: typeof fetch;
  skipSsrfCheck?: boolean;
}

function constantTimeTokenMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function parseQueryList(values: string[]): string[] | undefined {
  const parts = values
    .flatMap((v) => v.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function parseBooleanQuery(value: string | undefined): boolean {
  if (!value) return false;
  return /^(1|true|yes)$/i.test(value.trim());
}

export function createApp(options: AppOptions = {}): Hono {
  ensureApiAnythingEnv();

  const startedAt = Date.now();
  const cache =
    options.cache ??
    new SearchCache({
      maxEntries: getCacheMaxEntries(),
      ttlMs: getCacheTtlMs(),
    });

  const deps: ServiceDeps = {
    cache,
    fetchImpl: options.fetchImpl,
    skipSsrfCheck: options.skipSsrfCheck,
  };

  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "Accept", "MCP-Protocol-Version"],
    }),
  );

  // Optional Bearer auth on /v1/* and /mcp
  const authMiddleware = async (c: Parameters<Parameters<Hono["use"]>[1]>[0], next: () => Promise<void>) => {
    const apiKey = getSearchApiKey();
    if (!apiKey) {
      await next();
      return;
    }

    const authHeader = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (!match || !constantTimeTokenMatch(match[1]!, apiKey)) {
      return c.json(
        {
          error: "Unauthorized",
          message: "Valid Authorization: Bearer <SEARCH_API_KEY> header is required.",
        },
        401,
      );
    }

    await next();
  };

  app.use("/v1/*", authMiddleware);
  app.use("/mcp", authMiddleware);

  // Web Playground UI
  app.get("/", (c) => {
    return c.html(renderPlaygroundHtml(Boolean(getSearchApiKey())));
  });

  // Health Check
  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      version: APP_VERSION,
      runtime: isVercelRuntime() ? "vercel" : "node",
      node_version: process.version,
      auth_enabled: Boolean(getSearchApiKey()),
      providers: REGISTERED_PROVIDERS,
      cache: cache.getStats(),
      uptime_ms: Date.now() - startedAt,
    });
  });

  // OpenAPI 3.1 Specification
  app.get("/openapi.json", (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json(buildOpenApiSpec(origin));
  });

  // GET /v1/search
  app.get("/v1/search", async (c) => {
    const q = c.req.query("query") ?? "";
    const rawMax = c.req.query("max_results");
    const rawInclude = c.req.queries("include_domains") ?? [];
    const rawExclude = c.req.queries("exclude_domains") ?? [];

    const parsed = SearchRequestSchema.safeParse({
      query: q,
      ...(rawMax !== undefined ? { max_results: Number(rawMax) } : {}),
      ...(c.req.query("search_depth") ? { search_depth: c.req.query("search_depth") } : {}),
      ...(c.req.query("topic") ? { topic: c.req.query("topic") } : {}),
      ...(rawInclude.length > 0 ? { include_domains: parseQueryList(rawInclude) } : {}),
      ...(rawExclude.length > 0 ? { exclude_domains: parseQueryList(rawExclude) } : {}),
      ...(c.req.query("include_raw_content") !== undefined
        ? { include_raw_content: parseBooleanQuery(c.req.query("include_raw_content")) }
        : {}),
    });

    if (!parsed.success) {
      return c.json({ error: "Invalid request parameters", details: parsed.error.flatten() }, 400);
    }

    const result = await searchWeb(parsed.data, deps);
    return c.json(result);
  });

  // POST /v1/search
  app.post("/v1/search", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON request body" }, 400);
    }

    const parsed = SearchRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
    }

    const result = await searchWeb(parsed.data, deps);
    return c.json(result);
  });

  // POST /v1/extract
  app.post("/v1/extract", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON request body" }, 400);
    }

    const parsed = ExtractRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
    }

    const result = await extractUrls(parsed.data, deps);
    return c.json(result);
  });

  // POST /v1/crawl
  app.post("/v1/crawl", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON request body" }, 400);
    }

    const parsed = CrawlRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
    }

    const result = await crawlSite(parsed.data, deps);
    return c.json(result);
  });

  // POST /v1/research
  app.post("/v1/research", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON request body" }, 400);
    }

    const parsed = ResearchRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
    }

    const result = await deepResearch(parsed.data, deps);
    return c.json(result);
  });

  // Stateless Streamable HTTP MCP Endpoint
  app.post("/mcp", async (c) => {
    let parsedBody: unknown;
    try {
      parsedBody = await c.req.json();
    } catch {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32700, message: "Parse error: Invalid JSON" },
          id: null,
        },
        400,
      );
    }

    const rawReq = c.req.raw;
    const accept = rawReq.headers.get("accept") ?? "";
    let mcpReq = rawReq;
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      const headers = new Headers(rawReq.headers);
      headers.set("accept", "application/json, text/event-stream");
      mcpReq = new Request(rawReq.url, {
        method: rawReq.method,
        headers,
      });
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const mcpServer = createMcpServer(deps);

    try {
      await mcpServer.connect(transport);
      return await transport.handleRequest(mcpReq, { parsedBody });
    } finally {
      await transport.close().catch(() => undefined);
      await mcpServer.close().catch(() => undefined);
    }
  });

  app.get("/mcp", (c) => {
    return c.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed. Stateless Streamable HTTP MCP accepts POST /mcp only.",
        },
        id: null,
      },
      405,
      { Allow: "POST" },
    );
  });

  app.delete("/mcp", (c) => {
    return c.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed. Stateless MCP server has no sessions.",
        },
        id: null,
      },
      405,
      { Allow: "POST" },
    );
  });

  return app;
}
