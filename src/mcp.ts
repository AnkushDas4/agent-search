import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
        "Search the web across multiple zero-key engines (Startpage, Marginalia, Qwant, DuckDuckGo Lite, arXiv, plus Wikipedia/Hacker News/GitHub by topic). Deduplicates, ranks by multi-engine consensus, and optionally extracts full Markdown content.",
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
          "Search vertical: 'general' (Startpage + Marginalia + Qwant + DuckDuckGo Lite + Wikipedia), 'news' (web + recent Hacker News), 'code' (DuckDuckGo Lite + Marginalia + GitHub + Hacker News), or 'research' (arXiv + Wikipedia + Startpage).",
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

  return server;
}
