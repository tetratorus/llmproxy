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
const http = require('http');
const https = require('https');

const PORT = parseInt(process.env.PORT || '8181', 10);
const DB_PATH = process.env.LLMPROXY_DB || 'requests.db';
const REQUEST_TIMEOUT = 300000; // 5 min

// ── Provider registry ────────────────────────────────────────────────────
//
//   interface:         'anthropic' | 'openai'  — wire shape (SSE event
//                      format, token field names, response-header passthrough).
//   upstreamBase:      origin only (no path). The proxy forwards everything
//                      after the local /<prefix>/ to the upstream.
//   defaultPathPrefix: prepended to the post-prefix path when the client
//                      didn't already include it. e.g. /openai/chat/completions
//                      and /openai/v1/chat/completions both reach
//                      api.openai.com/v1/chat/completions.
//   aliases:           extra local prefixes that map to the same provider.
//   canonical_path:    advertised in GET /models (display only).
//   models:            advertised in GET /models (display only).
const PROVIDERS = {
  claude: {
    interface: 'anthropic',
    upstreamBase: 'https://api.anthropic.com',
    defaultPathPrefix: '/v1',
    aliases: ['anthropic'],
    canonical_path: '/v1/messages',
    models: [
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
    ],
  },
  deepseek: {
    interface: 'openai',
    upstreamBase: 'https://api.deepseek.com',
    defaultPathPrefix: '',
    canonical_path: '/v1/chat/completions',
    models: [
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-chat',
      'deepseek-reasoner',
    ],
  },
  openai: {
    interface: 'openai',
    upstreamBase: 'https://api.openai.com',
    defaultPathPrefix: '/v1',
    canonical_path: '/v1/chat/completions',
    models: [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4.1',
      'gpt-4.1-mini',
      'o1',
      'o1-mini',
    ],
  },
  // codex CLI authed via ChatGPT browser session (`codex login`) talks to
  // chatgpt.com/backend-api/codex/<endpoint> — different host, different auth
  // (OAuth bearer, not OPENAI_API_KEY). Wire it as its own provider so traffic
  // through `model_provider.base_url=http://localhost:8181/codex` lands on the
  // ChatGPT backend instead of api.openai.com. Interface is tagged 'codex' so
  // the openai-shape token extractor doesn't silently produce zero tokens
  // against the Responses-API usage shape.
  codex: {
    interface: 'codex',
    upstreamBase: 'https://chatgpt.com',
    defaultPathPrefix: '/backend-api/codex',
    canonical_path: '/responses',
    models: [],
  },
  // OpenRouter aggregates many model providers behind one OpenAI-shaped endpoint.
  // We use this for Gemini (model id = "google/gemini-2.5-flash" etc.) per project decision
  // to not hit Google's native API directly.
  openrouter: {
    interface: 'openai',
    upstreamBase: 'https://openrouter.ai/api',
    defaultPathPrefix: '/v1',
    canonical_path: '/v1/chat/completions',
    models: [
      'google/gemini-2.5-flash',
      'google/gemini-2.5-pro',
      'google/gemini-2.0-flash-001',
    ],
  },
};

// Lookup: local path's first segment → { name, config }. Includes aliases.
const PROVIDER_BY_PREFIX = new Map();
for (const [name, config] of Object.entries(PROVIDERS)) {
  PROVIDER_BY_PREFIX.set(name, { name, config });
  for (const alias of config.aliases || []) {
    PROVIDER_BY_PREFIX.set(alias, { name, config });
  }
}

// ── Path helpers ─────────────────────────────────────────────────────────
function normalizePath(path) {
  if (!path) return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

function joinUrl(base, path) {
  return `${base.replace(/\/+$/, '')}${normalizePath(path)}`;
}

// /<prefix>/<rest> → { name, config, publicPrefix, providerPath }, or null
// if the first segment isn't a known provider/alias.
function stripProviderPrefix(path) {
  const match = path.match(/^\/([^/?#]+)(\/.*)?$/);
  if (!match) return null;
  const entry = PROVIDER_BY_PREFIX.get(match[1].toLowerCase());
  if (!entry) return null;
  return {
    ...entry,
    publicPrefix: match[1],
    providerPath: normalizePath(match[2] || '/'),
  };
}

// Apply defaultPathPrefix unless the client already included it.
function upstreamPathFor(config, providerPath) {
  const path = normalizePath(providerPath);
  if (!config.defaultPathPrefix || path === '/') return path;
  if (path === config.defaultPathPrefix || path.startsWith(`${config.defaultPathPrefix}/`)) return path;
  return `${config.defaultPathPrefix}${path}`;
}

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
  CREATE INDEX IF NOT EXISTS idx_endpoint ON requests(endpoint);
  CREATE INDEX IF NOT EXISTS idx_model ON requests(model);
`);

// Migrate from cproxy's schema (no provider/interface columns). SQLite has no
// "ADD COLUMN IF NOT EXISTS", so we check PRAGMA table_info and ADD only what's
// missing. We use ADD COLUMN ... DEFAULT — SQLite stores the default in table
// metadata and applies it on read for rows that predate the column, so existing
// cproxy rows return provider='claude' / interface='anthropic' without any
// UPDATE. That keeps the migration metadata-only and near-instant on a 10GB DB
// instead of triggering a multi-GB rewrite. New inserts pass explicit values
// in the INSERT statement, so the default is only ever used by legacy rows.
{
  const cols = db.prepare(`PRAGMA table_info(requests)`).all().map(c => c.name);
  if (!cols.includes('provider'))  { db.exec(`ALTER TABLE requests ADD COLUMN provider  TEXT DEFAULT 'claude'`);    console.log(`📦 added column: provider  (default=claude)`); }
  if (!cols.includes('interface')) { db.exec(`ALTER TABLE requests ADD COLUMN interface TEXT DEFAULT 'anthropic'`); console.log(`📦 added column: interface (default=anthropic)`); }
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_provider ON requests(provider);`);

// WebSocket frame log. Wired by the upgrade handler in a later phase; the table
// is created up-front so adding the handler later is a code-only change with no
// schema migration. Idempotent: safe to re-run on existing requests.db.
db.exec(`
  CREATE TABLE IF NOT EXISTS websocket_frames (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    sequence INTEGER NOT NULL,
    direction TEXT NOT NULL,
    opcode INTEGER,
    type TEXT,
    bytes INTEGER,
    payload TEXT,
    FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_ws_frames_request ON websocket_frames(request_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_ws_frames_payload ON websocket_frames(payload);
`);

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

// Try to parse a stored response as JSON; if that fails (SSE stream, malformed
// upstream payload, OpenRouter's leading ": OPENROUTER PROCESSING" comment line,
// etc.) return the raw string. Used by /api/requests so the dashboard never
// gets a half-parsed object that breaks downstream type assumptions.
function parseStoredResponse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { return s; }
}

// ── WebSocket frame helpers (pure, wired in a later phase) ───────────────
// RFC 6455 frame parser/encoder. Used by the upgrade handler to log each frame
// in both directions. These are pure functions with no side effects and are
// dormant until handleUpgrade is registered.
function decodeWebSocketOpcode(opcode) {
  return {
    0x0: 'continuation',
    0x1: 'text',
    0x2: 'binary',
    0x8: 'close',
    0x9: 'ping',
    0xa: 'pong',
  }[opcode] || `opcode_${opcode}`;
}

function readableFramePayload(opcode, payload) {
  if (opcode === 0x1) return payload.toString('utf8');
  if (opcode === 0x2) {
    const text = payload.toString('utf8');
    if (!text.includes('\uFFFD')) return text;
    return `[binary base64] ${payload.toString('base64')}`;
  }
  return payload.length ? payload.toString('base64') : '';
}

function encodeWebSocketFrame({ opcode, payload, masked = false }) {
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ''), 'utf8');
  let lengthBytes;
  if (payloadBuffer.length < 126) {
    lengthBytes = Buffer.from([payloadBuffer.length]);
  } else if (payloadBuffer.length <= 0xffff) {
    lengthBytes = Buffer.from([126, payloadBuffer.length >> 8, payloadBuffer.length & 0xff]);
  } else {
    lengthBytes = Buffer.alloc(9);
    lengthBytes[0] = 127;
    lengthBytes.writeBigUInt64BE(BigInt(payloadBuffer.length), 1);
  }
  const firstByte = 0x80 | (opcode & 0x0f);
  if (!masked) return Buffer.concat([Buffer.from([firstByte]), lengthBytes, payloadBuffer]);
  lengthBytes[0] |= 0x80;
  const mask = crypto.randomBytes(4);
  const maskedPayload = Buffer.from(payloadBuffer);
  for (let i = 0; i < maskedPayload.length; i += 1) maskedPayload[i] ^= mask[i % 4];
  return Buffer.concat([Buffer.from([firstByte]), lengthBytes, mask, maskedPayload]);
}

// Streaming parser. Feed it chunks from a TCP socket; it emits one frame at a
// time via onFrame, reassembling fragmented (FIN=0) frames first. Continuation
// frames inherit the original frame's opcode. Each emitted frame carries the
// raw bytes so the caller can re-forward them unmodified.
function createWebSocketFrameParser(onFrame) {
  let buffer = Buffer.alloc(0);
  let fragmentedOpcode = null;
  let fragmentedPayloads = [];
  let fragmentedRawFrames = [];
  let pending = Promise.resolve();
  const emitFrame = frame => {
    pending = pending.then(() => onFrame(frame)).catch(error => {
      console.error('WebSocket frame handler error:', error);
    });
  };
  return chunk => {
    if (!chunk || !chunk.length) return;
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];
      const fin = Boolean(firstByte & 0x80);
      const opcode = firstByte & 0x0f;
      const masked = Boolean(secondByte & 0x80);
      let payloadLength = secondByte & 0x7f;
      let offset = 2;
      if (payloadLength === 126) {
        if (buffer.length < offset + 2) return;
        payloadLength = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (buffer.length < offset + 8) return;
        const bigLength = buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) { buffer = Buffer.alloc(0); return; }
        payloadLength = Number(bigLength);
        offset += 8;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + payloadLength) return;
      const rawFrame = Buffer.from(buffer.subarray(0, offset + payloadLength));
      const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
      if (masked) {
        const mask = buffer.subarray(maskOffset, maskOffset + 4);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      }
      buffer = buffer.subarray(offset + payloadLength);
      if (opcode === 0x0) {
        fragmentedPayloads.push(payload);
        fragmentedRawFrames.push(rawFrame);
        if (fin && fragmentedOpcode !== null) {
          const completePayload = Buffer.concat(fragmentedPayloads);
          emitFrame({
            opcode: fragmentedOpcode,
            type: decodeWebSocketOpcode(fragmentedOpcode),
            payload: readableFramePayload(fragmentedOpcode, completePayload),
            bytes: completePayload.length,
            raw: Buffer.concat(fragmentedRawFrames),
          });
          fragmentedOpcode = null;
          fragmentedPayloads = [];
          fragmentedRawFrames = [];
        }
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          emitFrame({
            opcode,
            type: decodeWebSocketOpcode(opcode),
            payload: readableFramePayload(opcode, payload),
            bytes: payload.length,
            raw: rawFrame,
          });
        } else {
          fragmentedOpcode = opcode;
          fragmentedPayloads = [payload];
          fragmentedRawFrames = [rawFrame];
        }
      } else {
        emitFrame({
          opcode,
          type: decodeWebSocketOpcode(opcode),
          payload: readableFramePayload(opcode, payload),
          bytes: payload.length,
          raw: rawFrame,
        });
      }
    }
  };
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

// Headers that must not be forwarded — hop-by-hop (RFC 7230 §6.1) plus a few
// that Node/fetch rebuild from the body or destination (host, content-length,
// content-encoding). Everything else — auth, content-type, anthropic-version,
// openai-beta, anthropic-beta, custom org/project headers, future betas —
// passes through unchanged.
function shouldSkipHeader(header) {
  return [
    'connection',
    'content-encoding',
    'content-length',
    'host',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ].includes(header.toLowerCase());
}

function buildUpstreamHeaders(req) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (shouldSkipHeader(k)) continue;
    out[k] = v;
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

// ── Generic proxy handler ────────────────────────────────────────────────
async function handleProxy(providerEntry, req, res) {
  const { name: providerKey, config: provider, providerPath } = providerEntry;
  const requestId = crypto.randomBytes(8).toString('hex');
  const startTime = Date.now();

  // Build the upstream URL: <base><defaultPathPrefix?><providerPath><?query>
  const upstreamPath = upstreamPathFor(provider, providerPath);
  const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const upstreamUrl = joinUrl(provider.upstreamBase, upstreamPath) + search;

  const originalModel = req.body && req.body.model;
  const conversationId = generateConversationId(req.body && req.body.messages);

  db.prepare(`
    INSERT INTO requests (id, provider, interface, method, endpoint, headers, body,
                          original_model, routed_model, user_agent, content_type, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  );

  console.log(`📥 ${providerKey} ${requestId} ${req.method} ${req.path} → ${upstreamUrl} stream=${!!(req.body && req.body.stream)}`);

  // express.json() leaves req.body undefined for non-POST requests and for
  // bodies that aren't application/json. For now we only forward a body when
  // the parser populated one — sufficient for chat-completions / messages
  // shapes. Non-JSON bodies (file uploads, multipart) are out of scope for
  // this phase.
  const hasBody = req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0;

  let upstreamResponse;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    upstreamResponse = await fetch(upstreamUrl, {
      method: req.method,
      headers: buildUpstreamHeaders(req),
      body: hasBody ? JSON.stringify(req.body) : undefined,
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

  if (req.body && req.body.stream) {
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
    const endpoint = `/${key}${p.canonical_path}`;
    const upstream = joinUrl(p.upstreamBase, upstreamPathFor(p, p.canonical_path));
    for (const m of p.models) {
      data.push({ id: m, provider: key, interface: p.interface, endpoint, upstream });
    }
  }
  res.json({ object: 'list', data });
});

// ── cproxy-compatibility aliases ─────────────────────────────────────────
// Claude Code sets ANTHROPIC_BASE_URL=http://localhost:8181 and calls /v1/messages
// (no namespace prefix). We forward that to the claude provider so llmproxy is a
// drop-in replacement for cproxy. Same for /v1/models.
app.post('/v1/messages', (req, res) => {
  const claude = PROVIDER_BY_PREFIX.get('claude');
  return handleProxy({ ...claude, publicPrefix: 'v1', providerPath: '/messages' }, req, res);
});

app.get('/v1/models', (_req, res) => {
  // OpenAI-compat shape — what Claude Code's /model picker expects.
  const data = PROVIDERS.claude.models.map(id => ({
    id, object: 'model', created: 1677610602, owned_by: 'anthropic',
  }));
  res.json({ object: 'list', data });
});

// ── Dashboard endpoints (preserved from cproxy) ──────────────────────────
app.get('/api/requests', (req, res) => {
  try {
    const page   = parseInt(req.query.page)  || 1;
    const limit  = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    let total, rows;
    if (search) {
      ({ total } = db.prepare(`SELECT COUNT(*) as total FROM requests_fts WHERE requests_fts MATCH ?`).get(search));
      rows = db.prepare(`
        SELECT r.*, json_array_length(json_extract(r.body, '$.messages')) as message_count
        FROM requests_fts JOIN requests r ON requests_fts.rowid = r.rowid
        WHERE requests_fts MATCH ?
        ORDER BY r.timestamp DESC LIMIT ? OFFSET ?
      `).all(search, limit, offset);
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
          response: parseStoredResponse(r.response),
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
      r.response = parseStoredResponse(r.response);
    } catch (_) {}

    // Conversation navigation (ported from cproxy). Walks the same session_id
    // by message_count steps of 2 (user + assistant turn), so the dashboard
    // can step prev/next through a conversation thread.
    if (r.session_id && r.body && r.body.messages) {
      const msgCount = r.body.messages.length;
      const prev10 = [];
      const prevStmt = db.prepare(`
        SELECT id, timestamp FROM requests
        WHERE session_id = ? AND json_array_length(json_extract(body, '$.messages')) = ?
        ORDER BY timestamp DESC LIMIT 1
      `);
      for (let i = 1; i <= 10; i++) {
        const targetCount = msgCount - (i * 2);
        if (targetCount <= 0) break;
        const prev = prevStmt.get(r.session_id, targetCount);
        if (prev) prev10.push({ id: prev.id, msg_count: targetCount, timestamp: prev.timestamp });
      }
      const minMsgCount = prev10.length > 0 ? prev10[prev10.length - 1].msg_count : msgCount;
      const hasMorePrev = db.prepare(`
        SELECT COUNT(*) as count FROM requests
        WHERE session_id = ? AND json_array_length(json_extract(body, '$.messages')) < ?
      `).get(r.session_id, minMsgCount - 2).count > 0;
      const nextReqs = db.prepare(`
        SELECT id, timestamp FROM requests
        WHERE session_id = ? AND json_array_length(json_extract(body, '$.messages')) = ?
        ORDER BY timestamp ASC
      `).all(r.session_id, msgCount + 2);
      r.navigation = {
        conversation_id: r.session_id,
        msg_count: msgCount,
        prev_10: prev10.reverse(),
        has_more_prev: hasMorePrev,
        next: nextReqs.map(n => ({ id: n.id, msg_count: msgCount + 2, timestamp: n.timestamp })),
      };
    }

    res.json(r);
  } catch (e) {
    console.error('GET /api/requests/:id error:', e);
    res.status(500).json({ error: 'Failed to get request' });
  }
});

// Older history pages for a conversation (ported from cproxy). Used by the
// dashboard to lazy-load earlier turns past the initial prev_10 window.
app.get('/api/requests/:id/history', (req, res) => {
  try {
    const r = db.prepare('SELECT session_id, body FROM requests WHERE id = ?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'Request not found' });
    const body = r.body ? JSON.parse(r.body) : null;
    if (!body || !body.messages) return res.json({ prev_requests: [], has_more: false });

    const msgCount = body.messages.length;
    const offset = parseInt(req.query.offset) || 10;
    const limit  = parseInt(req.query.limit)  || 10;

    const prevStmt = db.prepare(`
      SELECT id, timestamp FROM requests
      WHERE session_id = ? AND json_array_length(json_extract(body, '$.messages')) = ?
      ORDER BY timestamp DESC LIMIT 1
    `);
    const prevRequests = [];
    for (let i = offset; i < offset + limit; i++) {
      const targetCount = msgCount - (i * 2);
      if (targetCount <= 0) break;
      const prev = prevStmt.get(r.session_id, targetCount);
      if (prev) prevRequests.push({ id: prev.id, msg_count: targetCount, timestamp: prev.timestamp });
    }
    const minMsgCount = prevRequests.length > 0 ? prevRequests[prevRequests.length - 1].msg_count : 0;
    const hasMore = minMsgCount > 0 && db.prepare(`
      SELECT COUNT(*) as count FROM requests
      WHERE session_id = ? AND json_array_length(json_extract(body, '$.messages')) < ?
    `).get(r.session_id, minMsgCount - 2).count > 0;

    res.json({ prev_requests: prevRequests.reverse(), has_more: hasMore });
  } catch (e) {
    console.error('GET /api/requests/:id/history error:', e);
    res.status(500).json({ error: 'Failed to get history' });
  }
});

// ── Generic prefix routing ───────────────────────────────────────────────
// Catches anything under /<provider-prefix>/... that wasn't matched by an
// explicit route above (dashboard, /health, /models, /v1/* aliases). Forwards
// the rest of the path verbatim to the provider's upstreamBase + defaultPathPrefix.
app.use((req, res, next) => {
  const entry = stripProviderPrefix(req.path);
  if (!entry) return next();
  return handleProxy(entry, req, res);
});

// ── Listen ───────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`🚀 llmproxy on http://localhost:${PORT}`);
  console.log(`📊 db=${DB_PATH}`);
  console.log(`Routes:`);
  for (const [k, p] of Object.entries(PROVIDERS)) {
    const aliases = p.aliases ? ` (aliases: ${p.aliases.map(a => '/' + a).join(', ')})` : '';
    console.log(`  /${k}/*${aliases}  →  ${p.upstreamBase}${p.defaultPathPrefix || ''}  (${p.interface})`);
  }
  console.log(`  GET  /models    /health    /api/requests    POST /v1/messages    GET /v1/models`);
});

module.exports = { app, db, server, PROVIDERS };
