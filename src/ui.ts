export function renderPlaygroundHtml(authEnabled: boolean): string {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>agent-search — Zero-Key Search API & MCP Playground</title>
  <style>
    :root {
      --bg: #09090b;
      --surface: #111114;
      --surface-2: #18181b;
      --border: #27272a;
      --text: #fafafa;
      --muted: #a1a1aa;
      --cyan: #06b6d4;
      --cyan-hi: #22d3ee;
      --cyan-dim: rgba(6, 182, 212, 0.14);
      --ok: #10b981;
      --err: #f43f5e;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      --sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    a { color: var(--cyan-hi); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .container {
      max-width: 1120px;
      margin: 0 auto;
      padding: 28px 20px 64px;
    }
    header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .logo {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      background: var(--cyan-dim);
      border: 1px solid rgba(6, 182, 212, 0.45);
      display: grid;
      place-items: center;
      color: var(--cyan-hi);
      font-family: var(--mono);
      font-weight: 700;
      font-size: 16px;
    }
    h1 {
      font-size: 20px;
      margin: 0;
      letter-spacing: -0.02em;
    }
    .subtitle {
      font-size: 13px;
      color: var(--muted);
      margin: 2px 0 0;
    }
    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .badge {
      font-family: var(--mono);
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--muted);
    }
    .badge.cyan {
      border-color: rgba(6, 182, 212, 0.45);
      background: var(--cyan-dim);
      color: var(--cyan-hi);
    }
    .grid {
      display: grid;
      grid-template-columns: 1.3fr 1fr;
      gap: 20px;
      align-items: start;
    }
    @media (max-width: 900px) {
      .grid { grid-template-columns: 1fr; }
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px;
    }
    .card-title {
      font-size: 14px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin: 0 0 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .tabs {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-bottom: 14px;
    }
    .tab {
      background: var(--surface-2);
      color: var(--muted);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px 12px;
      font-size: 13px;
      font-family: var(--mono);
      cursor: pointer;
      transition: all 0.12s ease;
    }
    .tab.active {
      background: var(--cyan-dim);
      border-color: var(--cyan);
      color: var(--cyan-hi);
    }
    .row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }
    .field {
      flex: 1;
      min-width: 140px;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    label {
      font-size: 12px;
      color: var(--muted);
      font-family: var(--mono);
    }
    input, select, textarea {
      width: 100%;
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 9px 11px;
      font-size: 14px;
      font-family: inherit;
      outline: none;
    }
    input:focus, select:focus, textarea:focus {
      border-color: var(--cyan);
      box-shadow: 0 0 0 2px rgba(6, 182, 212, 0.18);
    }
    .btn {
      background: var(--cyan);
      color: #042f2e;
      border: none;
      border-radius: 8px;
      padding: 9px 16px;
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      transition: background 0.12s ease;
    }
    .btn:hover { background: var(--cyan-hi); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-ghost {
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 5px 10px;
      font-size: 12px;
      font-family: var(--mono);
      cursor: pointer;
    }
    .btn-ghost:hover { border-color: var(--cyan); color: var(--cyan-hi); }
    .checkbox-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 22px;
      font-size: 13px;
      color: var(--muted);
    }
    .checkbox-row input { width: auto; }
    .status-bar {
      display: flex;
      gap: 12px;
      align-items: center;
      font-family: var(--mono);
      font-size: 12px;
      color: var(--muted);
      margin: 12px 0;
    }
    .pill {
      padding: 2px 8px;
      border-radius: 6px;
      background: var(--surface-2);
      border: 1px solid var(--border);
    }
    .pill.ok { color: var(--ok); border-color: rgba(16, 185, 129, 0.35); }
    .pill.err { color: var(--err); border-color: rgba(244, 63, 94, 0.35); }
    .results-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 14px;
    }
    .result-item {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
    }
    .result-item h3 {
      margin: 0 0 4px;
      font-size: 15px;
    }
    .result-meta {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--cyan);
      margin-bottom: 6px;
      word-break: break-all;
    }
    .result-snippet {
      font-size: 13px;
      color: var(--muted);
      margin: 0;
    }
    pre {
      margin: 0;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      font-family: var(--mono);
      font-size: 12px;
      overflow-x: auto;
      max-height: 420px;
      color: #d4d4d8;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .stack {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .hidden { display: none; }
    footer {
      margin-top: 28px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 10px;
      font-size: 12px;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <div class="logo">as</div>
        <div>
          <h1>agent-search</h1>
          <p class="subtitle">Zero-API-key Search, Extract, Crawl &amp; Research API + Stateless MCP</p>
        </div>
      </div>
      <div class="badges">
        <span class="badge cyan">Tier-1 Plain HTTP</span>
        <span class="badge">${authEnabled ? "Auth: Bearer Required" : "Auth: Open"}</span>
        <a class="badge" href="/openapi.json">OpenAPI 3.1</a>
        <a class="badge" href="/health">Health</a>
      </div>
    </header>

    <div class="grid">
      <div class="card">
        <div class="card-title">
          <span>Interactive Playground</span>
          <span style="font-size:11px;text-transform:none;color:var(--cyan);">powered by api-anything</span>
        </div>

        <div class="tabs" id="mode-tabs">
          <button class="tab active" data-mode="search">/v1/search</button>
          <button class="tab" data-mode="extract">/v1/extract</button>
          <button class="tab" data-mode="crawl">/v1/crawl</button>
          <button class="tab" data-mode="research">/v1/research</button>
          <button class="tab" data-mode="catalog">/v1/catalog</button>
        </div>

        <form id="playground-form">
          <div id="fields-search">
            <div class="row">
              <div class="field" style="flex:3">
                <label for="s-query">query</label>
                <input id="s-query" type="text" value="hono typescript" placeholder="Search the web..." />
              </div>
              <div class="field">
                <label for="s-topic">topic</label>
                <select id="s-topic">
                  <option value="general">general</option>
                  <option value="code">code</option>
                  <option value="news">news</option>
                  <option value="research">research</option>
                </select>
              </div>
            </div>
            <div class="row">
              <div class="field">
                <label for="s-depth">search_depth</label>
                <select id="s-depth">
                  <option value="basic">basic</option>
                  <option value="advanced">advanced</option>
                </select>
              </div>
              <div class="field">
                <label for="s-max">max_results</label>
                <input id="s-max" type="number" min="1" max="30" value="10" />
              </div>
              <div class="field">
                <label class="checkbox-row">
                  <input id="s-raw" type="checkbox" />
                  include_raw_content
                </label>
              </div>
            </div>
          </div>

          <div id="fields-extract" class="hidden">
            <div class="row">
              <div class="field">
                <label for="e-urls">urls (one per line, max 10)</label>
                <textarea id="e-urls" rows="3">https://github.com/honojs/hono</textarea>
              </div>
              <div class="field" style="max-width:160px">
                <label for="e-format">format</label>
                <select id="e-format">
                  <option value="markdown">markdown</option>
                  <option value="text">text</option>
                </select>
              </div>
            </div>
          </div>

          <div id="fields-crawl" class="hidden">
            <div class="row">
              <div class="field" style="flex:3">
                <label for="c-url">url</label>
                <input id="c-url" type="url" value="https://github.com/goodnight000/api-anything" />
              </div>
              <div class="field">
                <label for="c-depth">max_depth (0-2)</label>
                <input id="c-depth" type="number" min="0" max="2" value="1" />
              </div>
              <div class="field">
                <label for="c-limit">limit (1-10)</label>
                <input id="c-limit" type="number" min="1" max="10" value="3" />
              </div>
            </div>
          </div>

          <div id="fields-research" class="hidden">
            <div class="row">
              <div class="field" style="flex:3">
                <label for="r-topic">topic</label>
                <input id="r-topic" type="text" value="Model Context Protocol stateless HTTP" />
              </div>
              <div class="field">
                <label for="r-max">max_sources (1-10)</label>
                <input id="r-max" type="number" min="1" max="10" value="4" />
              </div>
            </div>
          </div>

          <div id="fields-catalog" class="hidden">
            <div class="row">
              <div class="field">
                <label for="cat-action">catalog action</label>
                <select id="cat-action">
                  <option value="list">GET /v1/catalog (browse 114+ sites)</option>
                  <option value="call">POST /v1/catalog/call (execute Tier-1 op)</option>
                </select>
              </div>
              <div class="field">
                <label for="cat-site">site (optional for list / required for call)</label>
                <input id="cat-site" type="text" value="github" placeholder="e.g. github, arxiv, wikipedia" />
              </div>
            </div>
            <div class="row" id="cat-list-fields">
              <div class="field">
                <label for="cat-query">filter query (optional)</label>
                <input id="cat-query" type="text" value="" placeholder="Search site or operation..." />
              </div>
            </div>
            <div class="row hidden" id="cat-call-fields">
              <div class="field">
                <label for="cat-op">operation</label>
                <input id="cat-op" type="text" value="searchRepos" placeholder="e.g. searchRepos, getPaper" />
              </div>
              <div class="field" style="flex:2">
                <label for="cat-params">params (JSON object)</label>
                <input id="cat-params" type="text" value='{"q":"hono"}' placeholder='{"q":"hono"}' />
              </div>
            </div>
          </div>

          <div class="row" style="align-items:flex-end;">
            <div class="field">
              <label for="api-key">Bearer token (optional unless SEARCH_API_KEY is set)</label>
              <input id="api-key" type="password" placeholder="SEARCH_API_KEY" />
            </div>
            <div>
              <button id="run-btn" class="btn" type="submit">Run Request</button>
            </div>
          </div>
        </form>

        <div class="status-bar" id="status-bar">
          <span class="pill" id="status-pill">Ready</span>
          <span id="timing-text"></span>
        </div>

        <div id="visual-results" class="results-list"></div>

        <div class="card-title" style="margin-top:12px;">
          <span>JSON Response</span>
          <button type="button" class="btn-ghost" id="copy-json">Copy JSON</button>
        </div>
        <pre id="json-output">{
  "hint": "Click Run Request to test live endpoints"
}</pre>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-title">
            <span>curl Snippet</span>
            <button type="button" class="btn-ghost" id="copy-curl">Copy curl</button>
          </div>
          <pre id="curl-snippet"></pre>
        </div>

        <div class="card">
          <div class="card-title">
            <span>mcp_config.json</span>
            <button type="button" class="btn-ghost" id="copy-mcp">Copy MCP Config</button>
          </div>
          <div class="tabs" id="mcp-tabs">
            <button type="button" class="tab active" data-mcp="http">Remote HTTP (/mcp)</button>
            <button type="button" class="tab" data-mcp="stdio">Local stdio</button>
          </div>
          <pre id="mcp-snippet"></pre>
        </div>
      </div>
    </div>

    <footer>
      <span>MIT License &copy; 2026 Ankush Das &middot; <a href="https://github.com/AnkushDas4/agent-search" target="_blank" rel="noreferrer">AnkushDas4/agent-search</a></span>
      <span>Backends: ddg-lite, marginalia, wikipedia, github, stackexchange, hacker-news, sednium-news, google-news-rss, semantic-scholar, arxiv &middot; 114+ catalog sites</span>
    </footer>
  </div>

  <script>
    const modeTabs = document.querySelectorAll('#mode-tabs .tab');
    const mcpTabs = document.querySelectorAll('#mcp-tabs .tab');
    const form = document.getElementById('playground-form');
    const runBtn = document.getElementById('run-btn');
    const statusPill = document.getElementById('status-pill');
    const timingText = document.getElementById('timing-text');
    const visualResults = document.getElementById('visual-results');
    const jsonOutput = document.getElementById('json-output');
    const curlPre = document.getElementById('curl-snippet');
    const mcpPre = document.getElementById('mcp-snippet');

    let activeMode = 'search';
    let activeMcpMode = 'http';

    function buildPayload() {
      if (activeMode === 'search') {
        return {
          method: 'POST',
          path: '/v1/search',
          body: {
            query: document.getElementById('s-query').value.trim(),
            topic: document.getElementById('s-topic').value,
            search_depth: document.getElementById('s-depth').value,
            max_results: Number(document.getElementById('s-max').value) || 10,
            include_raw_content: document.getElementById('s-raw').checked,
          },
        };
      }
      if (activeMode === 'extract') {
        const urls = document.getElementById('e-urls').value.split(/\\n+/).map(s => s.trim()).filter(Boolean);
        return {
          method: 'POST',
          path: '/v1/extract',
          body: { urls, format: document.getElementById('e-format').value },
        };
      }
      if (activeMode === 'crawl') {
        return {
          method: 'POST',
          path: '/v1/crawl',
          body: {
            url: document.getElementById('c-url').value.trim(),
            max_depth: Number(document.getElementById('c-depth').value) || 1,
            limit: Number(document.getElementById('c-limit').value) || 5,
          },
        };
      }
      if (activeMode === 'research') {
        return {
          method: 'POST',
          path: '/v1/research',
          body: {
            topic: document.getElementById('r-topic').value.trim(),
            max_sources: Number(document.getElementById('r-max').value) || 5,
          },
        };
      }
      const catAction = document.getElementById('cat-action').value;
      const catSite = document.getElementById('cat-site').value.trim();
      if (catAction === 'list') {
        const qs = new URLSearchParams();
        if (catSite) qs.set('site', catSite);
        const catQuery = document.getElementById('cat-query').value.trim();
        if (catQuery) qs.set('query', catQuery);
        const qStr = qs.toString();
        return {
          method: 'GET',
          path: '/v1/catalog' + (qStr ? '?' + qStr : ''),
          body: null,
        };
      }
      let parsedParams = {};
      try {
        parsedParams = JSON.parse(document.getElementById('cat-params').value || '{}');
      } catch {
        parsedParams = {};
      }
      return {
        method: 'POST',
        path: '/v1/catalog/call',
        body: {
          site: catSite,
          operation: document.getElementById('cat-op').value.trim(),
          params: parsedParams,
        },
      };
    }

    function updateSnippets() {
      const { method, path, body } = buildPayload();
      const key = document.getElementById('api-key').value.trim();
      const origin = window.location.origin;
      const NL = String.fromCharCode(10);
      const CONT = ' ' + String.fromCharCode(92) + NL;
      const authLine = key ? CONT + '  -H "Authorization: Bearer ' + key + '"' : '';
      if (method === 'GET') {
        curlPre.textContent =
          'curl -sS "' + origin + path + '"' + authLine;
      } else {
        curlPre.textContent =
          'curl -sS -X POST "' + origin + path + '"' + CONT +
          '  -H "Content-Type: application/json"' + authLine + CONT +
          "  -d '" + JSON.stringify(body) + "'";
      }

      if (activeMcpMode === 'http') {
        const headers = key ? { Authorization: 'Bearer ' + key } : undefined;
        const cfg = {
          mcpServers: {
            'agent-search': {
              url: origin + '/mcp',
              ...(headers ? { headers } : {}),
            },
          },
        };
        mcpPre.textContent = JSON.stringify(cfg, null, 2);
      } else {
        const cfg = {
          mcpServers: {
            'agent-search': {
              command: 'node',
              args: ['dist/mcp-stdio.js'],
            },
          },
        };
        mcpPre.textContent = JSON.stringify(cfg, null, 2);
      }
    }

    document.getElementById('cat-action').addEventListener('change', (ev) => {
      const isCall = ev.target.value === 'call';
      document.getElementById('cat-list-fields').classList.toggle('hidden', isCall);
      document.getElementById('cat-call-fields').classList.toggle('hidden', !isCall);
      updateSnippets();
    });

    modeTabs.forEach(btn => {
      btn.addEventListener('click', () => {
        activeMode = btn.dataset.mode;
        modeTabs.forEach(b => b.classList.toggle('active', b === btn));
        ['search', 'extract', 'crawl', 'research', 'catalog'].forEach(m => {
          document.getElementById('fields-' + m).classList.toggle('hidden', m !== activeMode);
        });
        updateSnippets();
      });
    });

    mcpTabs.forEach(btn => {
      btn.addEventListener('click', () => {
        activeMcpMode = btn.dataset.mcp;
        mcpTabs.forEach(b => b.classList.toggle('active', b === btn));
        updateSnippets();
      });
    });

    document.querySelectorAll('#playground-form input, #playground-form select, #playground-form textarea').forEach(el => {
      el.addEventListener('input', updateSnippets);
      el.addEventListener('change', updateSnippets);
    });

    function escapeHtml(str) {
      return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function renderVisual(data) {
      visualResults.innerHTML = '';
      const items = data.results || data.pages || data.sources || [];
      if (!Array.isArray(items) || items.length === 0) return;
      for (const item of items.slice(0, 8)) {
        const div = document.createElement('div');
        div.className = 'result-item';
        const metaParts = [item.url];
        if (item.source) metaParts.push('source: ' + item.source);
        if (item.score !== undefined) metaParts.push('score: ' + item.score);
        if (item.word_count !== undefined) metaParts.push(item.word_count + ' words');
        const text = item.snippet || (item.content ? item.content.slice(0, 220) + (item.content.length > 220 ? '...' : '') : '');
        div.innerHTML =
          '<h3><a href="' + escapeHtml(item.url || '#') + '" target="_blank" rel="noreferrer">' + escapeHtml(item.title || item.url || 'Result') + '</a></h3>' +
          '<div class="result-meta">' + escapeHtml(metaParts.join(' · ')) + '</div>' +
          '<p class="result-snippet">' + escapeHtml(text) + '</p>';
        visualResults.appendChild(div);
      }
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      updateSnippets();
      const { method, path, body } = buildPayload();
      const key = document.getElementById('api-key').value.trim();
      const headers = {};
      if (method !== 'GET') headers['Content-Type'] = 'application/json';
      if (key) headers['Authorization'] = 'Bearer ' + key;

      runBtn.disabled = true;
      statusPill.className = 'pill';
      statusPill.textContent = 'Running...';
      timingText.textContent = '';

      const t0 = performance.now();
      try {
        const res = await fetch(path, {
          method: method || 'POST',
          headers,
          ...(body !== null ? { body: JSON.stringify(body) } : {}),
        });
        const data = await res.json();
        const ms = Math.round(performance.now() - t0);
        statusPill.className = 'pill ' + (res.ok ? 'ok' : 'err');
        statusPill.textContent = 'HTTP ' + res.status;
        timingText.textContent = (data.response_time_ms !== undefined ? data.response_time_ms : ms) + ' ms' + (data.cached ? ' (cached)' : '');
        jsonOutput.textContent = JSON.stringify(data, null, 2);
        renderVisual(data);
      } catch (err) {
        statusPill.className = 'pill err';
        statusPill.textContent = 'Network Error';
        jsonOutput.textContent = JSON.stringify({ error: String(err) }, null, 2);
      } finally {
        runBtn.disabled = false;
      }
    });

    function wireCopy(btnId, getText) {
      const btn = document.getElementById(btnId);
      btn.addEventListener('click', async () => {
        const prev = btn.textContent;
        try {
          await navigator.clipboard.writeText(getText());
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = prev; }, 1200);
        } catch {
          btn.textContent = 'Copy failed';
          setTimeout(() => { btn.textContent = prev; }, 1200);
        }
      });
    }

    wireCopy('copy-json', () => jsonOutput.textContent);
    wireCopy('copy-curl', () => curlPre.textContent);
    wireCopy('copy-mcp', () => mcpPre.textContent);
    updateSnippets();
  </script>
</body>
</html>`;
}
