import { APP_VERSION } from "./config.js";

export function buildOpenApiSpec(baseUrl?: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "agent-search API",
      version: APP_VERSION,
      description:
        "Zero-API-key, zero-credit-card web search, content extraction, crawling, deep research, and stateless MCP server powered by api-anything.",
      license: {
        name: "MIT",
        url: "https://opensource.org/licenses/MIT",
      },
    },
    servers: baseUrl ? [{ url: baseUrl }] : [{ url: "/" }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Optional Bearer token enforced only when SEARCH_API_KEY is configured.",
        },
      },
      schemas: {
        SearchRequest: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", minLength: 1, maxLength: 500 },
            max_results: { type: "integer", minimum: 1, maximum: 30, default: 10 },
            search_depth: { type: "string", enum: ["basic", "advanced"], default: "basic" },
            topic: { type: "string", enum: ["general", "news", "code", "research"], default: "general" },
            include_domains: { type: "array", items: { type: "string" }, maxItems: 20 },
            exclude_domains: { type: "array", items: { type: "string" }, maxItems: 20 },
            include_raw_content: { type: "boolean", default: false },
          },
        },
        SearchResult: {
          type: "object",
          required: ["title", "url", "snippet", "score", "source"],
          properties: {
            title: { type: "string" },
            url: { type: "string", format: "uri" },
            snippet: { type: "string" },
            content: { type: "string" },
            score: { type: "number" },
            source: { type: "string" },
          },
        },
        SearchResponse: {
          type: "object",
          required: ["query", "results", "cached", "response_time_ms"],
          properties: {
            query: { type: "string" },
            results: { type: "array", items: { $ref: "#/components/schemas/SearchResult" } },
            cached: { type: "boolean" },
            response_time_ms: { type: "number" },
          },
        },
        ExtractRequest: {
          type: "object",
          required: ["urls"],
          properties: {
            urls: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", format: "uri" } },
            format: { type: "string", enum: ["markdown", "text"], default: "markdown" },
          },
        },
        ExtractResponse: {
          type: "object",
          required: ["results", "failed"],
          properties: {
            results: {
              type: "array",
              items: {
                type: "object",
                required: ["url", "title", "content", "word_count"],
                properties: {
                  url: { type: "string", format: "uri" },
                  title: { type: "string" },
                  content: { type: "string" },
                  word_count: { type: "integer" },
                },
              },
            },
            failed: {
              type: "array",
              items: {
                type: "object",
                required: ["url", "error"],
                properties: {
                  url: { type: "string" },
                  error: { type: "string" },
                },
              },
            },
          },
        },
        CrawlRequest: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string", format: "uri" },
            max_depth: { type: "integer", minimum: 0, maximum: 2, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
            include_paths: { type: "array", items: { type: "string" }, maxItems: 20 },
          },
        },
        ResearchRequest: {
          type: "object",
          required: ["topic"],
          properties: {
            topic: { type: "string", minLength: 1, maxLength: 400 },
            max_sources: { type: "integer", minimum: 1, maximum: 10, default: 5 },
          },
        },
        CatalogCallRequest: {
          type: "object",
          required: ["site", "operation"],
          properties: {
            site: { type: "string", minLength: 1, maxLength: 100 },
            operation: { type: "string", minLength: 1, maxLength: 100 },
            params: { type: "object", additionalProperties: true },
          },
        },
      },
    },
    paths: {
      "/health": {
        get: {
          summary: "Health, provider, and cache status",
          responses: {
            "200": { description: "Service health status" },
          },
        },
      },
      "/openapi.json": {
        get: {
          summary: "OpenAPI 3.1 specification",
          responses: {
            "200": { description: "OpenAPI JSON document" },
          },
        },
      },
      "/v1/search": {
        get: {
          summary: "Search the web via query parameters",
          security: [{}, { bearerAuth: [] }],
          parameters: [
            { name: "query", in: "query", required: true, schema: { type: "string" } },
            { name: "max_results", in: "query", schema: { type: "integer", minimum: 1, maximum: 30, default: 10 } },
            { name: "search_depth", in: "query", schema: { type: "string", enum: ["basic", "advanced"] } },
            { name: "topic", in: "query", schema: { type: "string", enum: ["general", "news", "code", "research"] } },
            { name: "include_domains", in: "query", schema: { type: "string" } },
            { name: "exclude_domains", in: "query", schema: { type: "string" } },
            { name: "include_raw_content", in: "query", schema: { type: "boolean" } },
          ],
          responses: {
            "200": {
              description: "Search results",
              content: { "application/json": { schema: { $ref: "#/components/schemas/SearchResponse" } } },
            },
            "400": { description: "Invalid query parameters" },
            "401": { description: "Unauthorized" },
          },
        },
        post: {
          summary: "Search the web via JSON body",
          security: [{}, { bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/SearchRequest" } } },
          },
          responses: {
            "200": {
              description: "Search results",
              content: { "application/json": { schema: { $ref: "#/components/schemas/SearchResponse" } } },
            },
            "400": { description: "Validation error" },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/v1/extract": {
        post: {
          summary: "Extract clean Markdown or text from up to 10 URLs",
          security: [{}, { bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/ExtractRequest" } } },
          },
          responses: {
            "200": {
              description: "Extracted pages",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ExtractResponse" } } },
            },
          },
        },
      },
      "/v1/crawl": {
        post: {
          summary: "Same-origin breadth-first website crawl",
          security: [{}, { bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CrawlRequest" } } },
          },
          responses: {
            "200": { description: "Crawled pages with clean Markdown" },
          },
        },
      },
      "/v1/research": {
        post: {
          summary: "Multi-angle search + extraction research context bundle",
          security: [{}, { bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/ResearchRequest" } } },
          },
          responses: {
            "200": { description: "Structured research bundle with numbered citations" },
          },
        },
      },
      "/v1/catalog": {
        get: {
          summary: "List all available bundled and local ./sites/ api-anything catalog operations and parameters",
          security: [{}, { bearerAuth: [] }],
          parameters: [
            { name: "site", in: "query", schema: { type: "string" } },
            { name: "query", in: "query", schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "Catalog of available sites, operations, and parameter schemas" },
            "404": { description: "Requested site not found in catalog" },
          },
        },
      },
      "/v1/catalog/call": {
        post: {
          summary: "Execute a read-only Tier-1 operation from the api-anything site catalog (maxTier: 1)",
          security: [{}, { bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CatalogCallRequest" } } },
          },
          responses: {
            "200": { description: "Catalog operation execution result" },
            "400": { description: "Invalid request body" },
            "403": { description: "Write operations are not permitted" },
          },
        },
      },
      "/mcp": {
        post: {
          summary: "Stateless Streamable HTTP MCP JSON-RPC endpoint",
          security: [{}, { bearerAuth: [] }],
          responses: {
            "200": { description: "MCP JSON-RPC response" },
          },
        },
        get: {
          summary: "Not supported in stateless mode",
          responses: {
            "405": { description: "Method Not Allowed" },
          },
        },
      },
    },
  };
}
