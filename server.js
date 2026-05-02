// llmproxy: namespaced multi-provider LLM observability proxy.
// Routes:
//   GET  /health
//   GET  /models                           — supported models + their wire-protocol
//   POST /claude/v1/messages               — Anthropic shape → api.anthropic.com
//   POST /deepseek/v1/chat/completions     — OpenAI shape    → api.deepseek.com
//   GET  /api/requests, /api/requests/:id, /api/requests/:id/history  (dashboard)
//   GET  /                                 — static index.html
//
// Adding a new provider = one PROVIDERS entry below.
'use strict';

const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8182', 10);
const DB_PATH = process.env.LLMPROXY_DB || 'requests.db';
const REQUEST_TIMEOUT = 300000; // 5 min

// ── Provider registry ────────────────────────────────────────────────────
//
//   interface: 'anthropic' | 'openai'   determines wire shape (request body
//                                       semantics, SSE event format, token
//                                       field names).
//   upstream:  full URL to forward to.
//   path:      the local path that maps to this provider.
//   models:    advertised by GET /models. Display only — we don't restrict.
const PROVIDERS = {
  claude: {
    interface: 'anthropic',
    upstream: 'https://api.anthropic.com/v1/messages',
    path: '/claude/v1/messages',
    default_headers: { 'anthropic-version': '2023-06-01' },
    models: [
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
    ],
  },
  deepseek: {
    interface: 'openai',
    upstream: 'https://api.deepseek.com/v1/chat/completions',
    path: '/deepseek/v1/chat/completions',
    default_headers: {},
    models: [
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-chat',
      'deepseek-reasoner',
    ],
  },
};

// ── DB setup ─────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    provider TEXT,
    interface TEXT,
    method TEXT,
    endpoint TEXT,
    headers TEXT,
    body TEXT,
    response TEXT,
    status_code INTEGER,
    response_time INTEGER,
    model TEXT,
    original_model TEXT,
    routed_model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    user_agent TEXT,
    content_type TEXT,
    session_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_timestamp ON requests(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_provider ON requests(provider);
  CREATE INDEX IF NOT EXISTS idx_endpoint ON requests(endpoint);
  CREATE INDEX IF NOT EXISTS idx_model ON requests(model);
`);

// Idempotent migration: add `agent` column (Telegram bot username from path prefix).
try { db.exec(`ALTER TABLE requests ADD COLUMN agent TEXT`); } catch (_) { /* already exists */ }
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_agent ON requests(agent)`); } catch (_) {}

// FTS5 over body+response for the dashboard search (kept compatible with cproxy).
try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS requests_fts USING fts5(
      body, response, content='requests', content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS requests_ai AFTER INSERT ON requests BEGIN
      INSERT INTO requests_fts(rowid, body, response) VALUES (new.rowid, new.body, new.response);
    END;
    CREATE TRIGGER IF NOT EXISTS requests_au AFTER UPDATE ON requests BEGIN
      INSERT INTO requests_fts(requests_fts, rowid, body, response) VALUES('delete', old.rowid, old.body, old.response);
      INSERT INTO requests_fts(rowid, body, response) VALUES (new.rowid, new.body, new.response);
    END;
    CREATE TRIGGER IF NOT EXISTS requests_ad AFTER DELETE ON requests BEGIN
      INSERT INTO requests_fts(requests_fts, rowid, body, response) VALUES('delete', old.rowid, old.body, old.response);
    END;
  `);
} catch (e) {
  console.warn('FTS5 setup skipped:', e.message);
}

// ── App setup ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ── Helpers ──────────────────────────────────────────────────────────────
function sanitizeHeaders(headers) {
  const sanitized = { ...headers };
  const sensitive = ['x-api-key', 'api-key', 'authorization', 'anthropic-api-key', 'openai-api-key'];
  for (const key of Object.keys(sanitized)) {
    if (sensitive.some(s => key.toLowerCase().includes(s))) sanitized[key] = '[REDACTED]';
  }
  return sanitized;
}

function generateConversationId(messages) {
  if (!messages || messages.length === 0) return crypto.randomBytes(6).toString('hex');
  const firstMessages = messages.slice(0, Math.min(4, messages.length));
  const normalized = firstMessages.map(msg => {
    const copy = { ...msg };
    if (copy.content && Array.isArray(copy.content)) {
      copy.content = copy.content.map(item => {
        if (typeof item === 'object' && item !== null) {
          const { cache_control, ...rest } = item;
          return rest;
        }
        return item;
      });
    }
    return copy;
  });
  return crypto.createHash('md5').update(JSON.stringify(normalized)).digest('hex').substring(0, 12);
}

// Token extraction — non-streaming, by interface.
function extractTokens(interfaceName, parsedBody) {
  if (!parsedBody || typeof parsedBody !== 'object') return null;
  const u = parsedBody.usage;
  if (!u) return null;
  if (interfaceName === 'anthropic') {
    return {
      input_tokens: u.input_tokens || 0,
      output_tokens: u.output_tokens || 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
      cache_read_input_tokens: u.cache_read_input_tokens || 0,
    };
  }
  if (interfaceName === 'openai') {
    const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
    return {
      input_tokens: u.prompt_tokens || 0,
      output_tokens: u.completion_tokens || 0,
      cache_creation_input_tokens: 0, // OpenAI-shape providers don't expose this separately
      cache_read_input_tokens: cached,
    };
  }
  return null;
}

// Token + model extraction from a streamed SSE payload.
function parseSSE(interfaceName, sseText) {
  const lines = sseText.split('\n');
  let model = '';
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const dataStr = line.substring(6).trim();
    if (!dataStr || dataStr === '[DONE]') continue;
    let data;
    try { data = JSON.parse(dataStr); } catch (_) { continue; }

    if (interfaceName === 'anthropic') {
      if (data.type === 'message_start' && data.message) {
        model = data.message.model || model;
        if (data.message.usage) {
          usage.input_tokens = data.message.usage.input_tokens || usage.input_tokens;
          usage.cache_creation_input_tokens = data.message.usage.cache_creation_input_tokens || usage.cache_creation_input_tokens;
          usage.cache_read_input_tokens = data.message.usage.cache_read_input_tokens || usage.cache_read_input_tokens;
        }
      }
      if (data.type === 'message_delta' && data.usage) {
        usage.input_tokens = data.usage.input_tokens || usage.input_tokens;
        usage.output_tokens = data.usage.output_tokens || usage.output_tokens;
      }
    } else if (interfaceName === 'openai') {
      // chat.completion.chunk events. Final chunk carries usage when stream_options.include_usage=true.
      if (data.model) model = data.model;
      if (data.usage) {
        usage.input_tokens = data.usage.prompt_tokens || usage.input_tokens;
        usage.output_tokens = data.usage.completion_tokens || usage.output_tokens;
        const cached = (data.usage.prompt_tokens_details && data.usage.prompt_tokens_details.cached_tokens) || 0;
        if (cached) usage.cache_read_input_tokens = cached;
      }
    }
  }
  return { model, usage };
}

// Pick auth headers to forward to upstream.
function buildUpstreamHeaders(provider, reqHeaders) {
  const out = { 'Content-Type': 'application/json', ...provider.default_headers };
  if (reqHeaders['accept-encoding']) out['Accept-Encoding'] = reqHeaders['accept-encoding'];
  // Universal auth headers.
  if (reqHeaders['x-api-key']) out['x-api-key'] = reqHeaders['x-api-key'];
  if (reqHeaders['authorization']) out['authorization'] = reqHeaders['authorization'];
  // Anthropic-specific (x-api-key already handled; pass through any other anthropic-* except version which we set).
  if (provider.interface === 'anthropic') {
    for (const [k, v] of Object.entries(reqHeaders)) {
      if (k.startsWith('anthropic-') && k !== 'anthropic-version') out[k] = v;
    }
  }
  return out;
}

// Headers we forward back from upstream → client (rate-limit etc, by interface).
function passthroughResponseHeaders(interfaceName) {
  if (interfaceName === 'anthropic') {
    return [
      'anthropic-ratelimit-requests-limit', 'anthropic-ratelimit-requests-remaining', 'anthropic-ratelimit-requests-reset',
      'anthropic-ratelimit-tokens-limit',   'anthropic-ratelimit-tokens-remaining',   'anthropic-ratelimit-tokens-reset',
      'request-id', 'x-request-id',
    ];
  }
  return [
    'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests',
    'x-ratelimit-limit-tokens',   'x-ratelimit-remaining-tokens',   'x-ratelimit-reset-tokens',
    'x-request-id', 'request-id',
  ];
}

// Bot-username validator: Telegram allows letters/digits/underscores, 5-32 chars,
// must end in 'bot'. We only enforce shape here; collisions are impossible because
// Telegram itself enforces global uniqueness.
const AGENT_RE = /^[A-Za-z0-9_]{5,32}$/;

// ── Generic proxy handler ────────────────────────────────────────────────
async function handleProxy(providerKey, req, res, agent = null) {
  const provider = PROVIDERS[providerKey];
  const requestId = crypto.randomBytes(8).toString('hex');
  const startTime = Date.now();

  const originalModel = req.body && req.body.model;
  const conversationId = generateConversationId(req.body && req.body.messages);

  db.prepare(`
    INSERT INTO requests (id, provider, interface, method, endpoint, headers, body,
                          original_model, routed_model, user_agent, content_type, session_id, agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    requestId,
    providerKey,
    provider.interface,
    req.method,
    req.path,
    JSON.stringify(sanitizeHeaders(req.headers)),
    JSON.stringify(req.body),
    originalModel,
    originalModel,
    req.headers['user-agent'] || null,
    req.headers['content-type'] || null,
    conversationId,
    agent,
  );

  const agentTag = agent ? ` agent=${agent}` : '';
  console.log(`📥 ${providerKey} ${requestId}${agentTag} model=${originalModel} stream=${!!req.body.stream}`);

  let upstreamResponse;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    upstreamResponse = await fetch(provider.upstream, {
      method: 'POST',
      headers: buildUpstreamHeaders(provider, req.headers),
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
  } catch (err) {
    console.error(`❌ ${providerKey} ${requestId} upstream fetch error:`, err.message);
    db.prepare(`UPDATE requests SET response = ?, status_code = ?, response_time = ? WHERE id = ?`)
      .run(JSON.stringify({ error: err.message }), 502, Date.now() - startTime, requestId);
    return res.status(502).json({ error: 'Upstream fetch failed', message: err.message });
  }

  // Forward response headers we know we want.
  for (const h of passthroughResponseHeaders(provider.interface)) {
    const v = upstreamResponse.headers.get(h);
    if (v) res.setHeader(h, v);
  }

  if (req.body.stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.status(upstreamResponse.status);

    const chunks = [];
    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        chunks.push(chunk);
        res.write(chunk);
      }
      res.end();
    } catch (streamErr) {
      console.error(`❌ ${providerKey} ${requestId} stream error:`, streamErr);
      try { res.end(); } catch (_) {}
    }

    const fullResponse = chunks.join('');
    const parsed = parseSSE(provider.interface, fullResponse);
    db.prepare(`
      UPDATE requests SET response = ?, status_code = ?, response_time = ?, model = ?,
        input_tokens = ?, output_tokens = ?, cache_creation_input_tokens = ?, cache_read_input_tokens = ?
      WHERE id = ?
    `).run(
      fullResponse, upstreamResponse.status, Date.now() - startTime,
      parsed.model || originalModel,
      parsed.usage.input_tokens, parsed.usage.output_tokens,
      parsed.usage.cache_creation_input_tokens, parsed.usage.cache_read_input_tokens,
      requestId,
    );
    console.log(`✅ ${providerKey} ${requestId} stream ${Date.now() - startTime}ms tokens=${parsed.usage.input_tokens}/${parsed.usage.output_tokens}`);
    return;
  }

  // Non-streaming.
  const responseText = await upstreamResponse.text();
  const elapsed = Date.now() - startTime;
  let parsedBody = null;
  try { parsedBody = JSON.parse(responseText); } catch (_) {}
  const tokens = extractTokens(provider.interface, parsedBody) || { input_tokens: null, output_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null };
  const model = (parsedBody && parsedBody.model) || originalModel;

  db.prepare(`
    UPDATE requests SET response = ?, status_code = ?, response_time = ?, model = ?,
      input_tokens = ?, output_tokens = ?, cache_creation_input_tokens = ?, cache_read_input_tokens = ?
    WHERE id = ?
  `).run(
    responseText, upstreamResponse.status, elapsed, model,
    tokens.input_tokens, tokens.output_tokens, tokens.cache_creation_input_tokens, tokens.cache_read_input_tokens,
    requestId,
  );

  res.status(upstreamResponse.status)
     .setHeader('Content-Type', upstreamResponse.headers.get('content-type') || 'application/json')
     .send(responseText);

  console.log(`✅ ${providerKey} ${requestId} ${elapsed}ms tokens=${tokens.input_tokens}/${tokens.output_tokens} status=${upstreamResponse.status}`);
}

// ── Routes ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'healthy', timestamp: new Date(), port: PORT, db: DB_PATH }));

app.get('/models', (_req, res) => {
  const data = [];
  for (const [key, p] of Object.entries(PROVIDERS)) {
    for (const m of p.models) {
      data.push({
        id: m,
        provider: key,
        interface: p.interface,
        endpoint: p.path,
        upstream: p.upstream,
      });
    }
  }
  res.json({ object: 'list', data });
});

// Namespaced (preferred): /:agent is the Telegram bot username, e.g. matron_fece16_bot.
// This makes the dashboard groupable per-agent without any nanobot-side change.
function agentRoute(req, res, providerKey) {
  const agent = req.params.agent;
  if (!AGENT_RE.test(agent)) {
    return res.status(400).json({ error: 'invalid agent', detail: 'agent must match ^[A-Za-z0-9_]{5,32}$' });
  }
  return handleProxy(providerKey, req, res, agent);
}
app.post('/:agent/claude/v1/messages',           (req, res) => agentRoute(req, res, 'claude'));
app.post('/:agent/deepseek/v1/chat/completions', (req, res) => agentRoute(req, res, 'deepseek'));

// Legacy non-namespaced (no agent attribution). Kept so the proxy can roll
// independently of agent configs. Stored with agent=NULL.
app.post('/claude/v1/messages',           (req, res) => handleProxy('claude',   req, res));
app.post('/deepseek/v1/chat/completions', (req, res) => handleProxy('deepseek', req, res));

// ── Dashboard endpoints (preserved from cproxy) ──────────────────────────
app.get('/api/requests', (req, res) => {
  try {
    const page   = parseInt(req.query.page)  || 1;
    const limit  = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const agent  = req.query.agent || '';
    let total, rows;
    if (search) {
      if (agent) {
        ({ total } = db.prepare(`
          SELECT COUNT(*) as total FROM requests_fts
          JOIN requests r ON requests_fts.rowid = r.rowid
          WHERE requests_fts MATCH ? AND r.agent = ?
        `).get(search, agent));
        rows = db.prepare(`
          SELECT r.*, json_array_length(json_extract(r.body, '$.messages')) as message_count
          FROM requests_fts JOIN requests r ON requests_fts.rowid = r.rowid
          WHERE requests_fts MATCH ? AND r.agent = ?
          ORDER BY r.timestamp DESC LIMIT ? OFFSET ?
        `).all(search, agent, limit, offset);
      } else {
        ({ total } = db.prepare(`SELECT COUNT(*) as total FROM requests_fts WHERE requests_fts MATCH ?`).get(search));
        rows = db.prepare(`
          SELECT r.*, json_array_length(json_extract(r.body, '$.messages')) as message_count
          FROM requests_fts JOIN requests r ON requests_fts.rowid = r.rowid
          WHERE requests_fts MATCH ?
          ORDER BY r.timestamp DESC LIMIT ? OFFSET ?
        `).all(search, limit, offset);
      }
    } else if (agent) {
      ({ total } = db.prepare(`SELECT COUNT(*) as total FROM requests WHERE agent = ?`).get(agent));
      rows = db.prepare(`
        SELECT *, json_array_length(json_extract(body, '$.messages')) as message_count
        FROM requests WHERE agent = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?
      `).all(agent, limit, offset);
    } else {
      ({ total } = db.prepare(`SELECT COUNT(*) as total FROM requests`).get());
      rows = db.prepare(`
        SELECT *, json_array_length(json_extract(body, '$.messages')) as message_count
        FROM requests ORDER BY timestamp DESC LIMIT ? OFFSET ?
      `).all(limit, offset);
    }
    const parsed = rows.map(r => {
      try {
        return {
          ...r,
          headers:  r.headers ? JSON.parse(r.headers) : null,
          body:     r.body ? JSON.parse(r.body) : null,
          response: r.response ? (r.response.startsWith('data:') ? r.response : JSON.parse(r.response)) : null,
          message_count: r.message_count || 0,
        };
      } catch (_) { return r; }
    });
    res.json({ requests: parsed, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (e) {
    console.error('GET /api/requests error:', e);
    res.status(500).json({ error: 'Failed to get requests' });
  }
});

app.get('/api/requests/:id', (req, res) => {
  try {
    const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'Request not found' });
    try {
      r.headers  = r.headers ? JSON.parse(r.headers) : null;
      r.body     = r.body ? JSON.parse(r.body) : null;
      r.response = r.response ? (r.response.startsWith('data:') ? r.response : JSON.parse(r.response)) : null;
    } catch (_) {}
    res.json(r);
  } catch (e) {
    console.error('GET /api/requests/:id error:', e);
    res.status(500).json({ error: 'Failed to get request' });
  }
});

// ── Listen ───────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`🚀 llmproxy on http://localhost:${PORT}`);
  console.log(`📊 db=${DB_PATH}`);
  console.log(`Routes:`);
  for (const [k, p] of Object.entries(PROVIDERS)) {
    console.log(`  POST ${p.path}  →  ${p.upstream}  (${p.interface})`);
  }
  console.log(`  GET  /models    /health    /api/requests`);
});

module.exports = { app, db, server, PROVIDERS };
