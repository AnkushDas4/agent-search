#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Trust system proxy CA bundle in sandboxed environments when NODE_EXTRA_CA_CERTS is unset
if [[ -z "${NODE_EXTRA_CA_CERTS:-}" && -f /etc/ssl/certs/ca-certificates.crt ]]; then
  export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
fi

VERIFY_TMP="$(mktemp -d)"
SERVER_PID=""
AUTH_SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "$AUTH_SERVER_PID" ]] && kill -0 "$AUTH_SERVER_PID" 2>/dev/null; then
    kill "$AUTH_SERVER_PID" 2>/dev/null || true
    wait "$AUTH_SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$VERIFY_TMP"
}
trap cleanup EXIT

echo "==> [1/6] TypeScript typecheck & build"
npm run typecheck
npm run build

echo "==> [2/6] Running unit & integration test suite"
npm test

# Pick two free ephemeral ports cleanly via Node
read -r PORT AUTH_PORT < <(node -e '
  const net = require("node:net");
  const getPort = () => new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on("error", rej);
  });
  Promise.all([getPort(), getPort()]).then(([a, b]) => console.log(a, b));
')

echo "==> [3/6] Starting standalone server on http://127.0.0.1:${PORT}"
HOST=127.0.0.1 \
PORT="$PORT" \
CACHE_DIR="$VERIFY_TMP/cache" \
API_ANYTHING_HOME="$VERIFY_TMP/api-anything" \
node dist/server.js >"$VERIFY_TMP/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if ! curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "Server failed to become healthy:"
  cat "$VERIFY_TMP/server.log"
  exit 1
fi

BASE_URL="http://127.0.0.1:${PORT}"

echo "==> [4/6] Verifying Web UI, /health, /openapi.json, and all /v1/* REST endpoints"
UI_HTML="$(curl -fsS "${BASE_URL}/")"
node -e '
  const assert = require("node:assert/strict");
  const html = process.argv[1];
  assert.match(html, /#09090b/);
  assert.match(html, /#06b6d4/);
  assert.match(html, /agent-search/);
' "$UI_HTML"

HEALTH_JSON="$(curl -fsS "${BASE_URL}/health")"
node -e '
  const assert = require("node:assert/strict");
  const data = JSON.parse(process.argv[1]);
  assert.equal(data.status, "ok");
  assert.equal(data.auth_enabled, false);
  assert.ok(Array.isArray(data.providers) && data.providers.length >= 10);
  assert.equal(data.cache.backend, "disk+memory");
' "$HEALTH_JSON"

OPENAPI_JSON="$(curl -fsS "${BASE_URL}/openapi.json")"
node -e '
  const assert = require("node:assert/strict");
  const spec = JSON.parse(process.argv[1]);
  assert.equal(spec.openapi, "3.1.0");
  for (const p of ["/v1/search", "/v1/extract", "/v1/crawl", "/v1/research", "/v1/catalog", "/v1/catalog/call", "/mcp"]) {
    assert.ok(p in spec.paths, `Missing path in OpenAPI: ${p}`);
  }
' "$OPENAPI_JSON"

curl -fsS "${BASE_URL}/v1/catalog" | node -e '
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const data = JSON.parse(fs.readFileSync(0, "utf8"));
  assert.ok(data.total_sites >= 114, `Expected >= 114 catalog sites, got ${data.total_sites}`);
  assert.ok(data.total_operations >= 300);
  console.log(`    GET /v1/catalog -> ${data.total_sites} sites, ${data.total_operations} operations`);
'

CATALOG_CALL_JSON="$(curl -fsS -X POST "${BASE_URL}/v1/catalog/call" \
  -H "Content-Type: application/json" \
  -d '{"site":"github","operation":"searchRepos","params":{"q":"hono"}}')"
node -e '
  const assert = require("node:assert/strict");
  const data = JSON.parse(process.argv[1]);
  assert.equal(data.site, "github");
  assert.equal(data.operation, "searchRepos");
  assert.equal(typeof data.ok, "boolean");
  console.log(`    POST /v1/catalog/call (github.searchRepos) -> ok=${data.ok}, ms=${data.ms}`);
' "$CATALOG_CALL_JSON"

SEARCH_GET_JSON="$(curl -fsS "${BASE_URL}/v1/search?query=hono&topic=code&max_results=5")"
node -e '
  const assert = require("node:assert/strict");
  const data = JSON.parse(process.argv[1]);
  assert.equal(data.query, "hono");
  assert.equal(data.cached, false);
  assert.ok(Array.isArray(data.results) && data.results.length >= 1, "expected live search results");
  console.log(`    GET /v1/search -> ${data.results.length} results in ${data.response_time_ms}ms`);
' "$SEARCH_GET_JSON"

SEARCH_POST_JSON="$(curl -fsS -X POST "${BASE_URL}/v1/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"hono","topic":"code","max_results":5,"search_depth":"basic"}')"
node -e '
  const assert = require("node:assert/strict");
  const data = JSON.parse(process.argv[1]);
  assert.equal(data.cached, true);
  assert.ok(data.results.length >= 1);
  console.log(`    POST /v1/search (cached) -> ${data.results.length} results in ${data.response_time_ms}ms`);
' "$SEARCH_POST_JSON"

EXTRACT_JSON="$(curl -fsS -X POST "${BASE_URL}/v1/extract" \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://github.com/honojs/hono"],"format":"markdown"}')"
node -e '
  const assert = require("node:assert/strict");
  const data = JSON.parse(process.argv[1]);
  assert.equal(data.results.length, 1);
  assert.ok(data.results[0].word_count > 50);
  console.log(`    POST /v1/extract -> ${data.results[0].word_count} words`);
' "$EXTRACT_JSON"

CRAWL_JSON="$(curl -fsS -X POST "${BASE_URL}/v1/crawl" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://github.com/honojs/hono","max_depth":1,"limit":2,"include_paths":["/honojs/hono"]}')"
node -e '
  const assert = require("node:assert/strict");
  const data = JSON.parse(process.argv[1]);
  assert.ok(data.total_pages >= 1 && data.total_pages <= 2);
  console.log(`    POST /v1/crawl -> ${data.total_pages} pages`);
' "$CRAWL_JSON"

RESEARCH_JSON="$(curl -fsS -X POST "${BASE_URL}/v1/research" \
  -H "Content-Type: application/json" \
  -d '{"topic":"hono","max_sources":2}')"
node -e '
  const assert = require("node:assert/strict");
  const data = JSON.parse(process.argv[1]);
  assert.equal(data.queries.length, 3);
  assert.ok(data.citations.length >= 1);
  assert.match(data.context_markdown, /\[1\]/);
  console.log(`    POST /v1/research -> ${data.citations.length} citations in ${data.response_time_ms}ms`);
' "$RESEARCH_JSON"

echo "==> [5/6] Verifying stateless Streamable HTTP MCP (/mcp)"
MCP_GET_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/mcp")"
if [[ "$MCP_GET_STATUS" != "405" ]]; then
  echo "Expected GET /mcp to return 405, got ${MCP_GET_STATUS}"
  exit 1
fi
echo "    GET /mcp -> HTTP 405 (stateless)"

MCP_INIT_JSON="$(curl -fsS -X POST "${BASE_URL}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify-sh","version":"1.0.0"}}}')"
node -e '
  const assert = require("node:assert/strict");
  const data = JSON.parse(process.argv[1]);
  assert.equal(data.result.serverInfo.name, "agent-search");
' "$MCP_INIT_JSON"

MCP_LIST_JSON="$(curl -fsS -X POST "${BASE_URL}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')"
node -e '
  const assert = require("node:assert/strict");
  const data = JSON.parse(process.argv[1]);
  const names = data.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["call_catalog", "crawl_site", "deep_research", "extract_url", "list_catalog", "web_search"]);
  console.log(`    POST /mcp tools/list -> ${names.join(", ")}`);
' "$MCP_LIST_JSON"

MCP_CATALOG_JSON="$(curl -fsS -X POST "${BASE_URL}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_catalog","arguments":{"site":"github"}}}')"
node -e '
  const assert = require("node:assert/strict");
  const data = JSON.parse(process.argv[1]);
  const payload = JSON.parse(data.result.content[0].text);
  assert.equal(payload.total_sites, 1);
  assert.equal(payload.sites[0].site, "github");
  console.log(`    POST /mcp tools/call (list_catalog) -> github (${payload.total_operations} ops)`);
' "$MCP_CATALOG_JSON"

MCP_CALL_JSON="$(curl -fsS -X POST "${BASE_URL}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"web_search","arguments":{"query":"hono","topic":"code","max_results":3}}}')"
node -e '
  const assert = require("node:assert/strict");
  const data = JSON.parse(process.argv[1]);
  const text = data.result.content[0].text;
  const payload = JSON.parse(text);
  assert.ok(Array.isArray(payload.results) && payload.results.length >= 1);
  console.log(`    POST /mcp tools/call (web_search) -> ${payload.results.length} results`);
' "$MCP_CALL_JSON"

echo "==> [6/6] Verifying optional SEARCH_API_KEY Bearer authentication"
HOST=127.0.0.1 \
PORT="$AUTH_PORT" \
SEARCH_API_KEY="verify-secret-key" \
CACHE_DIR="$VERIFY_TMP/auth-cache" \
API_ANYTHING_HOME="$VERIFY_TMP/auth-aa" \
node dist/server.js >"$VERIFY_TMP/auth-server.log" 2>&1 &
AUTH_SERVER_PID=$!

for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${AUTH_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

UNAUTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${AUTH_PORT}/v1/search?query=hono&topic=code")"
AUTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer verify-secret-key' "http://127.0.0.1:${AUTH_PORT}/v1/search?query=hono&topic=code")"
MCP_UNAUTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${AUTH_PORT}/mcp" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"

if [[ "$UNAUTH_CODE" != "401" || "$AUTH_CODE" != "200" || "$MCP_UNAUTH_CODE" != "401" ]]; then
  echo "Bearer auth check failed: unauth=/v1/search:${UNAUTH_CODE}, auth=/v1/search:${AUTH_CODE}, unauth=/mcp:${MCP_UNAUTH_CODE}"
  exit 1
fi
echo "    Bearer auth enforced cleanly (unauth=401, auth=200)"

echo ""
echo "ALL VERIFICATION CHECKS PASSED"
