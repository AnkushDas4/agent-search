import { serve } from "@hono/node-server";
import { ensureApiAnythingEnv } from "./api-anything-env.js";
import { createApp } from "./app.js";
import { SearchCache } from "./cache.js";
import {
  getCacheMaxEntries,
  getCacheTtlMs,
  getDefaultPersistentCacheDir,
  getHost,
  getPort,
  getSearchApiKey,
} from "./config.js";

ensureApiAnythingEnv();

const cache = new SearchCache({
  maxEntries: getCacheMaxEntries(),
  ttlMs: getCacheTtlMs(),
  persistentDir: getDefaultPersistentCacheDir(),
});

const app = createApp({ cache });
const port = getPort();
const hostname = getHost();

const server = serve(
  {
    fetch: app.fetch,
    port,
    hostname,
  },
  (info) => {
    const stats = cache.getStats();
    console.log(
      `agent-search listening on http://${hostname}:${info.port} (cache=${stats.backend}, auth=${getSearchApiKey() ? "bearer" : "open"})`,
    );
  },
);

const shutdown = () => {
  server.close(() => {
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
