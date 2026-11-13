import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callCatalogOperation, listCatalog } from "./catalog.js";
import { APP_VERSION } from "./config.js";
import { crawlSite, deepResearch, extractUrls, type ServiceDeps, searchWeb } from "./search/service.js";
import { httpUrlSchema, SearchDepthSchema, SearchTopicSchema } from "./types.js";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function createMcpServer(deps: ServiceDeps): McpServer {
  const server = new McpServer({
    name: "agent-search",
    version: APP_VERSION,
  });

  server.registerTool(
    "web_search",
    {
      title: "Web Search",
      description:
        "Search the web across zero-key stateless Tier-1 engines (DuckDuckGo Lite, Marginalia, Wikipedia, GitHub, Stack Exchange, Hacker News, Sednium News RSS, Google News RSS, Semantic Scholar, arXiv). Deduplicates, ranks by multi-engine consensus, and optionally extracts full Markdown content.",
      inputSchema: {
        query: z.string().trim().min(1).max(500).describe("Search query string."),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(30)
          .default(10)
          .describe("Maximum number of deduplicated results to return (1-30, default 10)."),
        search_depth: SearchDepthSchema.default("basic").describe(
          "Use 'basic' for fast titles/URLs/snippets or 'advanced' to also extract Markdown content for the top 5 results.",
        ),
        topic: SearchTopicSchema.default("general").describe(
          "Search vertical: 'general' (ddg-lite + marginalia + wikipedia), 'code' (github + stackexchange + hacker-news + ddg-lite + sednium-news technology), 'news' (sednium-news + google-news-rss + hacker-news + ddg-lite), or 'research' (semantic-scholar + arxiv + wikipedia + sednium-news science).",
        ),
        include_domains: z
          .array(z.string().trim().min(1))
          .max(20)
          .optional()
          .describe("Optional allowlist of domains (e.g. ['github.com', 'docs.rs'])."),
        exclude_domains: z
          .array(z.string().trim().min(1))
          .max(20)
          .optional()
          .describe("Optional blocklist of domains to filter out."),
        include_raw_content: z
          .boolean()
          .default(false)
          .describe("Attach extracted Markdown content to the top 5 results."),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => {
      const result = await searchWeb(
        {
          query: args.query,
          max_results: args.max_results ?? 10,
          search_depth: args.search_depth ?? "basic",
          topic: args.topic ?? "general",
          include_domains: args.include_domains,
          exclude_domains: args.exclude_domains,
          include_raw_content: args.include_raw_content ?? false,
        },
        deps,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "extract_url",
    {
      title: "Extract URL Content",
      description:
        "Fetch up to 10 web pages concurrently and extract clean primary article content as Markdown or plain text using Mozilla Readability + Turndown.",
      inputSchema: {
        urls: z
          .array(httpUrlSchema)
          .min(1)
          .max(10)
          .describe("List of 1 to 10 HTTP/HTTPS URLs to extract."),
        format: z
          .enum(["markdown", "text"])
          .default("markdown")
          .describe("Output format: 'markdown' (default) or 'text'."),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => {
      const result = await extractUrls(
        {
          urls: args.urls,
          format: args.format ?? "markdown",
        },
        deps,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "crawl_site",
    {
      title: "Crawl Website",
      description:
        "Same-origin breadth-first website crawler (capped at max_depth <= 2 and limit <= 10) returning clean Markdown content for each discovered page.",
      inputSchema: {
        url: httpUrlSchema.describe("Seed HTTP/HTTPS URL to begin crawling from."),
        max_depth: z
          .number()
          .int()
          .min(0)
          .max(2)
          .default(1)
          .describe("Maximum crawl depth from seed URL (0-2, default 1)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(5)
          .describe("Maximum number of pages to extract (1-10, default 5)."),
        include_paths: z
          .array(z.string().trim().min(1))
          .max(20)
          .optional()
          .describe("Optional URL pathname prefixes to follow (e.g. ['/docs', '/guide'])."),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => {
      const result = await crawlSite(
        {
          url: args.url,
          max_depth: args.max_depth ?? 1,
          limit: args.limit ?? 5,
          include_paths: args.include_paths,
        },
        deps,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "deep_research",
    {
      title: "Deep Research",
      description:
        "Expand a research topic into 3 complementary search angles, deduplicate sources, extract clean Markdown from top sources, and return a structured context bundle with numbered citations.",
      inputSchema: {
        topic: z.string().trim().min(1).max(400).describe("Topic or research question to investigate."),
        max_sources: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(5)
          .describe("Maximum unique sources to extract and cite (1-10, default 5)."),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => {
      const result = await deepResearch(
        {
          topic: args.topic,
          max_sources: args.max_sources ?? 5,
        },
        deps,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "list_catalog",
    {
      title: "List api-anything Catalog",
      description:
        "List all available bundled and local ./sites/ api-anything catalog sites (114+ sites), their operations, and parameter JSON Schemas. Optionally filter by exact site name or search keyword.",
      inputSchema: {
        site: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .describe("Optional exact site name to inspect (e.g. 'github', 'wikipedia', 'arxiv', 'marginalia')."),
        query: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Optional keyword filter matching site name, description, or operation name."),
      },
      annotations: { ...READ_ONLY_ANNOTATIONS, openWorldHint: false },
    },
    async (args) => {
      const catalog = listCatalog({ site: args.site, query: args.query });
      return {
        content: [{ type: "text", text: JSON.stringify(catalog, null, 2) }],
      };
    },
  );

  server.registerTool(
    "call_catalog",
    {
      title: "Call api-anything Catalog Operation",
      description:
        "Execute a read-only Tier-1 operation from the api-anything catalog (pinned to maxTier: 1 plain HTTP). Call list_catalog first to inspect site names, operation names, and parameter schemas.",
      inputSchema: {
        site: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .describe("Site name from list_catalog (e.g. 'github', 'wikipedia', 'arxiv', 'crates')."),
        operation: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .describe("Operation name on that site (e.g. 'searchRepos', 'getPaper')."),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional JSON object of arguments for the operation."),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => {
      const result = await callCatalogOperation(
        {
          site: args.site,
          operation: args.operation,
          params: args.params ?? {},
        },
        { fetchImpl: deps.fetchImpl },
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        ...(result.class === "refused" ? { isError: true } : {}),
      };
    },
  );

  return server;
}
