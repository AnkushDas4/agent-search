import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ensureApiAnythingEnv } from "./api-anything-env.js";
import { SearchCache } from "./cache.js";
import { getCacheMaxEntries, getCacheTtlMs, getDefaultPersistentCacheDir } from "./config.js";
import { createMcpServer } from "./mcp.js";

async function main() {
  ensureApiAnythingEnv();

  const cache = new SearchCache({
    maxEntries: getCacheMaxEntries(),
    ttlMs: getCacheTtlMs(),
    persistentDir: getDefaultPersistentCacheDir(),
  });

  const server = createMcpServer({ cache });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("agent-search stdio MCP server ready");
}

main().catch((err) => {
  console.error("agent-search stdio MCP fatal error:", err);
  process.exit(1);
});
