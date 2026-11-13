# agent-search

Zero-API-key, zero-credit-card **Search API & MCP Server** powered by [`goodnight000/api-anything`](https://github.com/goodnight000/api-anything).

Deploy in one click to **Vercel**, or self-host on **Android (Termux)**, **Linux/macOS**, or a **low-RAM Docker VPS** with no Chromium/Playwright runtime and no external search API bills.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FAnkushDas4%2Fagent-search)

---

## Key Capabilities

- **Multi-Engine Tier-1 Fan-Out (`maxTier: 1`)**: Searches `ddg-lite`, `startpage`, `marginalia`, `qwant`, and `arxiv` (from committed `./sites/*.json` specs) alongside `api-anything`'s bundled `wikipedia`, `hacker-news`, and `github` Tier-1 operations across `general`, `news`, `code`, and `research` topics, with automatic direct-HTTP HTML/JSON fallbacks.
- **Deduplication & Consensus Ranking**: Unwraps tracking redirects, canonicalizes URLs, boosts results found across multiple engines, and supports `include_domains` / `exclude_domains` filters.
- **Clean Markdown Extraction**: Fetches and converts web pages via `@mozilla/readability`, `linkedom`, and `turndown` with SSRF protection (blocks private/loopback/metadata IPs and validates redirects).
- **Same-Origin BFS Crawler & Deep Research**: Crawls up to `max_depth <= 2` / `limit <= 10` pages (`POST /v1/crawl`), or expands any topic into 3 search angles and returns a structured research context bundle with numbered citations (`POST /v1/research`).
- **Dual MCP Transport**:
  - **Stateless Streamable HTTP** at `POST /mcp` (Vercel & remote clients ready; `GET /mcp` returns HTTP `405`).
  - **Local stdio** via `node dist/mcp-stdio.js` for Claude Desktop, Cursor, Cline, and CLI agents.
- **Interactive Playground & OpenAPI 3.1**: Built-in dark-mode web playground at `GET /`, health/provider diagnostics at `GET /health`, and OpenAPI 3.1 JSON at `GET /openapi.json`.
- **Two-Layer Cache**: Fast in-memory LRU cache (`CACHE_TTL_MS`, `CACHE_MAX_ENTRIES`) backed by optional persistent JSON cache (`./data/cache` when writable, automatic memory-only fallback on Vercel or read-only filesystems).

---

## Requirements

- **Node.js `>=22.13.0`**

---

## 1-Click Deploy on Vercel

Click the **Deploy with Vercel** button above (or import `https://github.com/AnkushDas4/agent-search` in Vercel).

- [`vercel.json`](./vercel.json) rewrites `/(.*)` to [`api/index.ts`](./api/index.ts) with `maxDuration: 30` and bundles `./sites/**`.
- On Vercel (`VERCEL=1`), `agent-search` uses memory caching only and stores `api-anything` runtime files under `/tmp`, making zero writes outside `/tmp`.
- Set an optional `SEARCH_API_KEY` environment variable in Vercel Project Settings if you want Bearer token auth on `/v1/*` and `/mcp`.

---

## Self-Hosting

### PC / Linux / macOS

```bash
git clone https://github.com/AnkushDas4/agent-search.git
cd agent-search
npm install
npm run build
npm start
```

Open `http://localhost:8787` for the interactive Web Playground.

### Android (Termux)

No root, no Chromium, and no native build tools required:

```bash
pkg update -y && pkg install -y nodejs-lts git
git clone https://github.com/AnkushDas4/agent-search.git
cd agent-search
npm install
npm run build
npm start
```

> `agent-search` uses Node's `os.tmpdir()` (Termux's `$PREFIX/tmp`) and `./data` inside the repo—never hardcoded `/tmp`.

### Low-RAM Docker VPS (1 GB RAM Safe)

The included [`Dockerfile`](./Dockerfile) and [`docker-compose.yml`](./docker-compose.yml) run on `node:22-alpine` with `NODE_OPTIONS="--max-old-space-size=320"` and a persistent volume for `./data`:

```bash
git clone https://github.com/AnkushDas4/agent-search.git
cd agent-search
docker compose up -d --build
```

---

## REST API & `curl` Examples

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/` | `GET` | Interactive dark-mode Web Playground + snippet builder |
| `/health` | `GET` | Server status, registered providers, and cache backend stats |
| `/openapi.json` | `GET` | OpenAPI 3.1.0 specification |
| `/v1/search` | `GET`, `POST` | Multi-engine search (`basic` or `advanced` with top-5 Markdown extraction) |
| `/v1/extract` | `POST` | Concurrent Markdown/text extraction for up to 10 URLs |
| `/v1/crawl` | `POST` | Same-origin BFS crawl (`max_depth <= 2`, `limit <= 10`) |
| `/v1/research` | `POST` | 3-angle topic expansion + Markdown research bundle with citations |
| `/mcp` | `POST` | Stateless Streamable HTTP MCP JSON-RPC endpoint (`GET` returns `405`) |

### Search (`POST /v1/search` & `GET /v1/search`)

```bash
curl -sS -X POST "http://localhost:8787/v1/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "hono web framework",
    "topic": "code",
    "search_depth": "advanced",
    "max_results": 5
  }'
```

```bash
curl -sS "http://localhost:8787/v1/search?query=hono&topic=code&max_results=5"
```

### Extract (`POST /v1/extract`)

```bash
curl -sS -X POST "http://localhost:8787/v1/extract" \
  -H "Content-Type: application/json" \
  -d '{
    "urls": ["https://github.com/honojs/hono"],
    "format": "markdown"
  }'
```

### Crawl (`POST /v1/crawl`)

```bash
curl -sS -X POST "http://localhost:8787/v1/crawl" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://hono.dev/docs/",
    "max_depth": 1,
    "limit": 5,
    "include_paths": ["/docs"]
  }'
```

### Deep Research (`POST /v1/research`)

```bash
curl -sS -X POST "http://localhost:8787/v1/research" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "Model Context Protocol stateless Streamable HTTP",
    "max_sources": 5
  }'
```

If `SEARCH_API_KEY` is configured, include `-H "Authorization: Bearer <SEARCH_API_KEY>"` on `/v1/*` and `/mcp` requests.

---

## MCP Configuration (`mcp_config.json`)

Registered MCP tools:
- `web_search` — Multi-engine web search with domain filtering and optional Markdown extraction
- `extract_url` — Extract clean Markdown or plain text from up to 10 URLs
- `crawl_site` — Same-origin BFS crawler (`max_depth <= 2`, `limit <= 10`)
- `deep_research` — Multi-angle search + extraction bundle with numbered citations

### Option A: Remote Stateless Streamable HTTP (`/mcp`)

Works with local servers, Docker deployments, and Vercel URLs:

```json
{
  "mcpServers": {
    "agent-search": {
      "url": "https://your-deployment.vercel.app/mcp"
    }
  }
}
```

With optional Bearer auth enabled:

```json
{
  "mcpServers": {
    "agent-search": {
      "url": "https://your-deployment.vercel.app/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_SEARCH_API_KEY"
      }
    }
  }
}
```

### Option B: Local `stdio` Transport

```json
{
  "mcpServers": {
    "agent-search": {
      "command": "node",
      "args": ["/path/to/agent-search/dist/mcp-stdio.js"]
    }
  }
}
```

---

## Environment Variables

See [`.env.example`](./.env.example):

| Variable | Default | Description |
| :--- | :--- | :--- |
| `SEARCH_API_KEY` | *(unset)* | Optional Bearer token protecting `/v1/*` and `/mcp` |
| `PORT` | `8787` | HTTP server port |
| `HOST` | `0.0.0.0` | HTTP bind host |
| `CACHE_TTL_MS` | `900000` | Cache TTL in milliseconds (15 minutes; `0` disables caching) |
| `CACHE_MAX_ENTRIES` | `256` | Maximum in-memory LRU cache entries |
| `CACHE_DIR` | `./data/cache` | Persistent JSON cache directory (disabled automatically on Vercel) |
| `API_ANYTHING_HOME` | `./data/api-anything` | `api-anything` state directory (`/tmp/api-anything` on Vercel) |
| `API_ANYTHING_LOCAL_ONLY` | `1` | Keeps `api-anything` strictly local-only without remote reporting |

---

## Verification

Run the automated typecheck, build, test suite, and live HTTP + MCP verification script:

```bash
npm run verify
```

---

## License

MIT License — Copyright (c) 2026 [Ankush Das](https://github.com/AnkushDas4). See [LICENSE](./LICENSE).
