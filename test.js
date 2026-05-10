// End-to-end tests for llmproxy. Real API calls, real SQLite, no stubs.
//
// Requires env vars (loaded from .env if present, shell env wins):
//   ANTHROPIC_API_KEY   — for the /claude and /v1/messages alias tests
//   DEEPSEEK_API_KEY    — for the /deepseek tests
//   OPENAI_API_KEY      — for the /openai tests
//   OPENROUTER_API_KEY  — for the /openrouter tests (Gemini via google/gemini-*)
//
// Each test cohort is skipped (with a notice) if its key is unset.
//
// Usage:
//   node test.js                # runs all tests
//   node test.js claude         # only claude
//   node test.js deepseek       # only deepseek
//   node test.js openai         # only openai
//   node test.js openrouter     # only openrouter (gemini)
//   node test.js models         # only static-route tests
//   node test.js dashboard      # only dashboard endpoints

'use strict';

const fs   = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Spawn the server in this same process, with its own test.db. We use a
// fresh file each run so token assertions don't fight history.
const TEST_DB = path.join(__dirname, 'test.db');
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch (_) {}
}
process.env.LLMPROXY_DB = TEST_DB;
process.env.PORT        = process.env.TEST_PORT || '8183';

// Pre-populate test.db with cproxy's schema (no provider/interface columns)
// and a sample row so we can validate the cproxy → llmproxy migration runs
// when server.js loads. The two columns must be added; the row must be
// backfilled to provider=claude / interface=anthropic.
{
  const seed = new Database(TEST_DB);
  seed.exec(`
    CREATE TABLE requests (
      id TEXT PRIMARY KEY,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      method TEXT, endpoint TEXT, headers TEXT, body TEXT, response TEXT,
      status_code INTEGER, response_time INTEGER,
      model TEXT, original_model TEXT, routed_model TEXT,
      input_tokens INTEGER, output_tokens INTEGER,
      cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
      user_agent TEXT, content_type TEXT, session_id TEXT
    );
  `);
  seed.prepare(`
    INSERT INTO requests (id, method, endpoint, body, response, status_code, model, original_model, routed_model, session_id)
    VALUES (?, 'POST', '/v1/messages', ?, ?, 200, 'claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-20241022', 'cproxy-seed-session')
  `).run(
    'cproxy-legacy-row',
    JSON.stringify({ model: 'claude-3-5-sonnet-20241022', messages: [{ role: 'user', content: 'legacy' }] }),
    JSON.stringify({ id: 'msg_legacy', content: [{ type: 'text', text: 'ok' }] }),
  );
  seed.close();
}

// Load .env if present (developer convenience).
try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch (_) {}

const PORT = process.env.PORT;
const BASE = `http://localhost:${PORT}`;

// Boot server.
const { server, db, PROVIDERS } = require('./server.js');
const http = require('http');
const net = require('net');

let passed = 0, failed = 0, skipped = 0;
const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
  if (status === 'PASS') passed++;
  if (status === 'FAIL') failed++;
  if (status === 'SKIP') skipped++;
  const tag = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⏭ ';
  console.log(`${tag} ${name}${detail ? '  — ' + detail : ''}`);
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function waitHealthy(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not become healthy in time');
}

function rowFor(reqJson) {
  // Find the most recent request matching the body.model + path heuristically.
  // We persist conversation_id (session_id) — re-hash to match.
  const stmt = db.prepare(`SELECT * FROM requests ORDER BY timestamp DESC LIMIT 5`);
  return stmt.all();
}
function latestRow() {
  // Use rowid for monotonic insertion order. CURRENT_TIMESTAMP is second-precision
  // and tests fire faster than that — ORDER BY timestamp would be ambiguous between
  // same-second inserts.
  return db.prepare(`SELECT * FROM requests ORDER BY rowid DESC LIMIT 1`).get();
}

// ── Tests ───────────────────────────────────────────────────────────────

async function testCproxyMigration() {
  // The pre-test setup created a cproxy-shape DB with one legacy row. After
  // server.js loads, both columns must exist and the legacy row must be
  // backfilled.
  const cols = db.prepare(`PRAGMA table_info(requests)`).all().map(c => c.name);
  assert(cols.includes('provider'),  'migration: provider column not added');
  assert(cols.includes('interface'), 'migration: interface column not added');

  const legacy = db.prepare(`SELECT * FROM requests WHERE id = ?`).get('cproxy-legacy-row');
  assert(legacy,                                'migration: legacy row missing after migration');
  assert(legacy.provider  === 'claude',         `migration: legacy provider=${legacy.provider}`);
  assert(legacy.interface === 'anthropic',      `migration: legacy interface=${legacy.interface}`);
  assert(legacy.endpoint  === '/v1/messages',   'migration: legacy endpoint mutated');
  record('migration: cproxy-shape DB gets provider/interface added + backfilled', 'PASS');
}

async function testHealthAndModels() {
  const h = await fetch(`${BASE}/health`);
  assert(h.ok, `health status=${h.status}`);
  const hj = await h.json();
  assert(hj.status === 'healthy', 'health.status not healthy');
  assert(hj.db.endsWith('test.db'), `db path is not test.db: ${hj.db}`);
  record('health: returns healthy with test.db', 'PASS');

  const m = await fetch(`${BASE}/models`);
  assert(m.ok, `models status=${m.status}`);
  const mj = await m.json();
  assert(Array.isArray(mj.data) && mj.data.length > 0, '/models data empty');
  const claudeEntry     = mj.data.find(d => d.id === 'claude-opus-4-7');
  const deepseekEntry   = mj.data.find(d => d.id === 'deepseek-v4-pro');
  const openaiEntry     = mj.data.find(d => d.id === 'gpt-4o-mini');
  const openrouterEntry = mj.data.find(d => d.id === 'google/gemini-2.5-flash');
  assert(claudeEntry,     'claude-opus-4-7 not in /models');
  assert(deepseekEntry,   'deepseek-v4-pro not in /models');
  assert(openaiEntry,     'gpt-4o-mini not in /models');
  assert(openrouterEntry, 'google/gemini-2.5-flash not in /models');
  assert(claudeEntry.interface === 'anthropic',     'claude not tagged anthropic');
  assert(deepseekEntry.interface === 'openai',      'deepseek not tagged openai');
  assert(openaiEntry.interface === 'openai',        'openai not tagged openai');
  assert(openrouterEntry.interface === 'openai',    'openrouter not tagged openai');
  assert(claudeEntry.endpoint === '/claude/v1/messages',                   'claude endpoint wrong');
  assert(deepseekEntry.endpoint === '/deepseek/v1/chat/completions',       'deepseek endpoint wrong');
  assert(openaiEntry.endpoint === '/openai/v1/chat/completions',           'openai endpoint wrong');
  assert(openrouterEntry.endpoint === '/openrouter/v1/chat/completions',   'openrouter endpoint wrong');
  record('models: lists claude+deepseek+openai+openrouter with correct interface and endpoint', 'PASS');

  // /v1/models alias (cproxy-compat): Anthropic-only OpenAI-shape list for the Claude Code picker.
  const v1m = await fetch(`${BASE}/v1/models`);
  assert(v1m.ok, `/v1/models status=${v1m.status}`);
  const v1mj = await v1m.json();
  assert(v1mj.object === 'list', '/v1/models object not list');
  assert(Array.isArray(v1mj.data) && v1mj.data.length > 0, '/v1/models data empty');
  assert(v1mj.data.every(d => d.owned_by === 'anthropic'), '/v1/models has non-anthropic entries');
  assert(v1mj.data.find(d => d.id === 'claude-opus-4-7'),  'claude-opus-4-7 not in /v1/models');
  record('v1/models alias: anthropic-only list in OpenAI-compat shape', 'PASS');
}

async function testClaudeNonStreaming() {
  if (!process.env.ANTHROPIC_API_KEY) {
    record('claude /v1/messages non-streaming', 'SKIP', 'ANTHROPIC_API_KEY unset');
    return;
  }
  const before = db.prepare(`SELECT COUNT(*) c FROM requests`).get().c;
  const r = await fetch(`${BASE}/claude/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key':    process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }],
    }),
  });
  if (!r.ok) throw new Error(`claude non-stream status=${r.status} body=${await r.text()}`);
  const j = await r.json();
  assert(j.content && j.content[0] && j.content[0].text, 'claude response missing content');

  const after = db.prepare(`SELECT COUNT(*) c FROM requests`).get().c;
  assert(after === before + 1, `expected 1 new row, got ${after - before}`);
  const row = latestRow();
  assert(row.provider === 'claude',     `provider=${row.provider}`);
  assert(row.interface === 'anthropic', `interface=${row.interface}`);
  assert(row.endpoint === '/claude/v1/messages', `endpoint=${row.endpoint}`);
  assert(row.status_code === 200,       `status_code=${row.status_code}`);
  assert(row.input_tokens > 0,          `input_tokens=${row.input_tokens}`);
  assert(row.output_tokens > 0,         `output_tokens=${row.output_tokens}`);
  assert(row.body && row.response,      'body or response not persisted');
  // Headers must be redacted in storage.
  const headers = JSON.parse(row.headers);
  assert(headers['x-api-key'] === '[REDACTED]', 'x-api-key not redacted');
  record('claude non-streaming: 200 + row captured + tokens + redacted', 'PASS', `in=${row.input_tokens} out=${row.output_tokens}`);
}

async function testClaudeStreaming() {
  if (!process.env.ANTHROPIC_API_KEY) {
    record('claude /v1/messages streaming', 'SKIP', 'ANTHROPIC_API_KEY unset');
    return;
  }
  const r = await fetch(`${BASE}/claude/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key':    process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 32,
      stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly the word: stream' }],
    }),
  });
  assert(r.ok, `claude stream status=${r.status}`);
  const text = await r.text();
  assert(text.includes('data:'), 'stream did not contain SSE data');
  assert(text.includes('message_start'), 'stream missing message_start');

  // Allow DB write to complete (UPDATE happens after stream end in handler).
  await new Promise(r => setTimeout(r, 100));
  const row = latestRow();
  assert(row.provider === 'claude',     `provider=${row.provider}`);
  assert(row.input_tokens > 0,          `streamed input_tokens=${row.input_tokens}`);
  assert(row.output_tokens > 0,         `streamed output_tokens=${row.output_tokens}`);
  assert(row.response.startsWith('event:') || row.response.startsWith('data:') || row.response.includes('message_start'),
    'streamed response not stored as raw SSE');
  record('claude streaming: SSE captured + tokens parsed', 'PASS', `in=${row.input_tokens} out=${row.output_tokens}`);
}

async function testDeepseekNonStreaming() {
  if (!process.env.DEEPSEEK_API_KEY) {
    record('deepseek /v1/chat/completions non-streaming', 'SKIP', 'DEEPSEEK_API_KEY unset');
    return;
  }
  const before = db.prepare(`SELECT COUNT(*) c FROM requests`).get().c;
  const r = await fetch(`${BASE}/deepseek/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }],
    }),
  });
  if (!r.ok) throw new Error(`deepseek non-stream status=${r.status} body=${await r.text()}`);
  const j = await r.json();
  assert(j.choices && j.choices[0] && j.choices[0].message, 'deepseek response missing choices[0].message');

  const after = db.prepare(`SELECT COUNT(*) c FROM requests`).get().c;
  assert(after === before + 1, `expected 1 new row, got ${after - before}`);
  const row = latestRow();
  assert(row.provider === 'deepseek',   `provider=${row.provider}`);
  assert(row.interface === 'openai',    `interface=${row.interface}`);
  assert(row.endpoint === '/deepseek/v1/chat/completions', `endpoint=${row.endpoint}`);
  assert(row.status_code === 200,       `status_code=${row.status_code}`);
  assert(row.input_tokens > 0,          `input_tokens=${row.input_tokens}`);
  assert(row.output_tokens > 0,         `output_tokens=${row.output_tokens}`);
  // Auth header redacted.
  const headers = JSON.parse(row.headers);
  assert(headers['authorization'] === '[REDACTED]', 'authorization not redacted');
  record('deepseek non-streaming: 200 + row captured + openai-shape tokens mapped', 'PASS', `in=${row.input_tokens} out=${row.output_tokens}`);
}

async function testDeepseekStreaming() {
  if (!process.env.DEEPSEEK_API_KEY) {
    record('deepseek /v1/chat/completions streaming', 'SKIP', 'DEEPSEEK_API_KEY unset');
    return;
  }
  const r = await fetch(`${BASE}/deepseek/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 32,
      stream: true,
      stream_options: { include_usage: true },  // required for openai-shape stream usage
      messages: [{ role: 'user', content: 'Reply with exactly the word: stream' }],
    }),
  });
  assert(r.ok, `deepseek stream status=${r.status}`);
  const text = await r.text();
  assert(text.includes('data:'), 'stream did not contain SSE data');
  assert(text.includes('chat.completion.chunk') || text.includes('"delta"'), 'stream missing chunk markers');

  await new Promise(r => setTimeout(r, 100));
  const row = latestRow();
  assert(row.provider === 'deepseek',   `provider=${row.provider}`);
  assert(row.input_tokens > 0,          `streamed input_tokens=${row.input_tokens}`);
  assert(row.output_tokens > 0,         `streamed output_tokens=${row.output_tokens}`);
  record('deepseek streaming: SSE captured + tokens parsed (include_usage)', 'PASS', `in=${row.input_tokens} out=${row.output_tokens}`);
}

async function testClaudeAliasV1Messages() {
  // cproxy-compat: POST /v1/messages should route to the claude provider.
  if (!process.env.ANTHROPIC_API_KEY) {
    record('alias /v1/messages → claude', 'SKIP', 'ANTHROPIC_API_KEY unset');
    return;
  }
  const r = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key':    process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with exactly the word: alias' }],
    }),
  });
  if (!r.ok) throw new Error(`alias /v1/messages status=${r.status} body=${await r.text()}`);
  const j = await r.json();
  assert(j.content && j.content[0] && j.content[0].text, 'alias response missing content');

  const row = latestRow();
  assert(row.provider === 'claude',     `alias provider=${row.provider}`);
  assert(row.interface === 'anthropic', `alias interface=${row.interface}`);
  // Endpoint is the raw request path — proves the alias route was hit, not the canonical one.
  assert(row.endpoint === '/v1/messages', `alias endpoint=${row.endpoint}`);
  assert(row.status_code === 200, `alias status_code=${row.status_code}`);
  assert(row.input_tokens > 0 && row.output_tokens > 0, 'alias missing tokens');
  record('alias /v1/messages: routes to claude, persisted with raw path', 'PASS', `in=${row.input_tokens} out=${row.output_tokens}`);
}

async function testOpenaiNonStreaming() {
  if (!process.env.OPENAI_API_KEY) {
    record('openai /v1/chat/completions non-streaming', 'SKIP', 'OPENAI_API_KEY unset');
    return;
  }
  const before = db.prepare(`SELECT COUNT(*) c FROM requests`).get().c;
  const r = await fetch(`${BASE}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }],
    }),
  });
  if (!r.ok) throw new Error(`openai non-stream status=${r.status} body=${await r.text()}`);
  const j = await r.json();
  assert(j.choices && j.choices[0] && j.choices[0].message, 'openai response missing choices[0].message');

  const after = db.prepare(`SELECT COUNT(*) c FROM requests`).get().c;
  assert(after === before + 1, `expected 1 new row, got ${after - before}`);
  const row = latestRow();
  assert(row.provider === 'openai',     `provider=${row.provider}`);
  assert(row.interface === 'openai',    `interface=${row.interface}`);
  assert(row.endpoint === '/openai/v1/chat/completions', `endpoint=${row.endpoint}`);
  assert(row.status_code === 200,       `status_code=${row.status_code}`);
  assert(row.input_tokens > 0,          `input_tokens=${row.input_tokens}`);
  assert(row.output_tokens > 0,         `output_tokens=${row.output_tokens}`);
  const headers = JSON.parse(row.headers);
  assert(headers['authorization'] === '[REDACTED]', 'authorization not redacted');
  record('openai non-streaming: 200 + row captured + tokens mapped', 'PASS', `in=${row.input_tokens} out=${row.output_tokens}`);
}

async function testOpenaiStreaming() {
  if (!process.env.OPENAI_API_KEY) {
    record('openai /v1/chat/completions streaming', 'SKIP', 'OPENAI_API_KEY unset');
    return;
  }
  const r = await fetch(`${BASE}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 32,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'Reply with exactly the word: stream' }],
    }),
  });
  assert(r.ok, `openai stream status=${r.status}`);
  const text = await r.text();
  assert(text.includes('data:'), 'stream did not contain SSE data');
  assert(text.includes('chat.completion.chunk') || text.includes('"delta"'), 'stream missing chunk markers');

  await new Promise(r => setTimeout(r, 100));
  const row = latestRow();
  assert(row.provider === 'openai',     `provider=${row.provider}`);
  assert(row.input_tokens > 0,          `streamed input_tokens=${row.input_tokens}`);
  assert(row.output_tokens > 0,         `streamed output_tokens=${row.output_tokens}`);
  record('openai streaming: SSE captured + tokens parsed', 'PASS', `in=${row.input_tokens} out=${row.output_tokens}`);
}

async function testOpenrouterGeminiNonStreaming() {
  if (!process.env.OPENROUTER_API_KEY) {
    record('openrouter /v1/chat/completions non-streaming (gemini)', 'SKIP', 'OPENROUTER_API_KEY unset');
    return;
  }
  const before = db.prepare(`SELECT COUNT(*) c FROM requests`).get().c;
  const r = await fetch(`${BASE}/openrouter/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }],
    }),
  });
  if (!r.ok) throw new Error(`openrouter non-stream status=${r.status} body=${await r.text()}`);
  const j = await r.json();
  assert(j.choices && j.choices[0] && j.choices[0].message, 'openrouter response missing choices[0].message');

  const after = db.prepare(`SELECT COUNT(*) c FROM requests`).get().c;
  assert(after === before + 1, `expected 1 new row, got ${after - before}`);
  const row = latestRow();
  assert(row.provider === 'openrouter',   `provider=${row.provider}`);
  assert(row.interface === 'openai',      `interface=${row.interface}`);
  assert(row.endpoint === '/openrouter/v1/chat/completions', `endpoint=${row.endpoint}`);
  assert(row.status_code === 200,         `status_code=${row.status_code}`);
  assert(row.input_tokens > 0,            `input_tokens=${row.input_tokens}`);
  assert(row.output_tokens > 0,           `output_tokens=${row.output_tokens}`);
  // The persisted body should still carry the gemini model id.
  const body = JSON.parse(row.body);
  assert(body.model.startsWith('google/gemini'), `body.model=${body.model}`);
  record('openrouter (gemini) non-streaming: 200 + row captured + tokens', 'PASS', `in=${row.input_tokens} out=${row.output_tokens}`);
}

async function testOpenrouterGeminiStreaming() {
  if (!process.env.OPENROUTER_API_KEY) {
    record('openrouter /v1/chat/completions streaming (gemini)', 'SKIP', 'OPENROUTER_API_KEY unset');
    return;
  }
  const r = await fetch(`${BASE}/openrouter/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      max_tokens: 32,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'Reply with exactly the word: stream' }],
    }),
  });
  assert(r.ok, `openrouter stream status=${r.status}`);
  const text = await r.text();
  assert(text.includes('data:'), 'stream did not contain SSE data');

  await new Promise(r => setTimeout(r, 150));
  const row = latestRow();
  assert(row.provider === 'openrouter',  `provider=${row.provider}`);
  assert(row.input_tokens > 0,           `streamed input_tokens=${row.input_tokens}`);
  assert(row.output_tokens > 0,          `streamed output_tokens=${row.output_tokens}`);
  record('openrouter (gemini) streaming: SSE captured + tokens parsed', 'PASS', `in=${row.input_tokens} out=${row.output_tokens}`);
}

async function testDashboard() {
  const r = await fetch(`${BASE}/api/requests?page=1&limit=10`);
  assert(r.ok, `/api/requests status=${r.status}`);
  const j = await r.json();
  assert(typeof j.total === 'number', 'no total');
  assert(Array.isArray(j.requests), 'requests not array');
  if (j.requests.length > 0) {
    const first = j.requests[0];
    assert(first.id, 'no id');
    assert(typeof first.body === 'object' || first.body === null, 'body not parsed');
  }
  record(`dashboard /api/requests: returns ${j.total} captured row(s)`, 'PASS');
}

async function testDashboardNavigation() {
  // Set up two requests in the same conversation so the navigation block has
  // material to walk: same first message → same session_id, second request
  // includes (assistant turn + new user turn) so message_count grows by 2.
  if (!process.env.ANTHROPIC_API_KEY) {
    record('dashboard navigation block + history endpoint', 'SKIP', 'ANTHROPIC_API_KEY unset (need it to seed conversation)');
    return;
  }
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };
  // Seed 5 messages so the conversation-id hash (first 4 messages) is stable
  // when we extend by 2 more turns. With <4 messages, the hash diverges turn-to-turn
  // because slice(0, min(4, len)) yields different windows.
  const turn1 = [
    { role: 'user',      content: 'navtest seed 1' },
    { role: 'assistant', content: 'ok' },
    { role: 'user',      content: 'navtest seed 2' },
    { role: 'assistant', content: 'ok' },
    { role: 'user',      content: 'navtest seed 3' },
  ];
  const r1 = await fetch(`${BASE}/claude/v1/messages`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 16, messages: turn1 }),
  });
  assert(r1.ok, `nav seed turn1 status=${r1.status}`);
  const j1 = await r1.json();
  const assistantText = (j1.content && j1.content[0] && j1.content[0].text) || 'ok';
  const turn2 = [
    ...turn1,
    { role: 'assistant', content: assistantText },
    { role: 'user',      content: 'navtest follow' },
  ];
  const r2 = await fetch(`${BASE}/claude/v1/messages`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 16, messages: turn2 }),
  });
  assert(r2.ok, `nav seed turn2 status=${r2.status}`);
  await r2.text();

  // Latest row = turn2 (7 messages). Walk back: prev_10[0] should point to turn1 (5 messages).
  const turn2Row = latestRow();
  const detail = await fetch(`${BASE}/api/requests/${turn2Row.id}`);
  assert(detail.ok, `detail status=${detail.status}`);
  const dj = await detail.json();
  assert(dj.navigation,                              'no navigation block on detail');
  assert(dj.navigation.conversation_id === turn2Row.session_id, 'nav.conversation_id mismatch');
  assert(dj.navigation.msg_count === 7,              `nav.msg_count=${dj.navigation.msg_count} (expected 7)`);
  assert(Array.isArray(dj.navigation.prev_10),       'nav.prev_10 not array');
  assert(dj.navigation.prev_10.length >= 1,          `nav.prev_10 empty (expected at least 1)`);
  assert(dj.navigation.prev_10[dj.navigation.prev_10.length - 1].msg_count === 5,
    `nav.prev_10 last msg_count=${dj.navigation.prev_10[dj.navigation.prev_10.length - 1].msg_count} (expected 5)`);
  record('dashboard /api/requests/:id: returns navigation block walking conversation', 'PASS');

  // History endpoint with offset past prev_10 → should return empty but valid shape.
  const hist = await fetch(`${BASE}/api/requests/${turn2Row.id}/history?offset=10&limit=10`);
  assert(hist.ok, `/history status=${hist.status}`);
  const hj = await hist.json();
  assert(Array.isArray(hj.prev_requests), 'history prev_requests not array');
  assert(typeof hj.has_more === 'boolean', 'history has_more not boolean');
  record('dashboard /api/requests/:id/history: returns paginated history shape', 'PASS');
}

// ── WebSocket test ──────────────────────────────────────────────────────
// Spins up a mock http upstream, overrides openai.upstreamBase to point at
// it, sends a client→server WS upgrade + a masked text frame, and asserts:
//   - requests row created with provider=openai, status=101
//   - websocket_frames has both client and server frames with decoded payloads
//   - GET /api/requests/:id/websocket-frames returns them
//   - search hits the row via frame payload
async function testWebSocketFrames() {
  const clientMarker = `WS_CLIENT_${process.pid}_${Date.now()}`;
  const serverMarker = `WS_SERVER_${process.pid}_${Date.now()}`;

  // Mock upstream — accepts upgrade, emits one server text frame, closes.
  const upstream = http.createServer();
  upstream.on('upgrade', (req, sock) => {
    sock.on('error', () => {});
    const acceptKey = require('crypto')
      .createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    sock.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
    );
    const payload = Buffer.from(serverMarker, 'utf8');
    sock.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    setTimeout(() => sock.end(), 400);
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));

  const savedBase = PROVIDERS.openai.upstreamBase;
  const savedPrefix = PROVIDERS.openai.defaultPathPrefix;
  PROVIDERS.openai.upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  PROVIDERS.openai.defaultPathPrefix = '';

  try {
    // Raw TCP upgrade — express doesn't parse upgrade requests, our handler does.
    const proxyPort = parseInt(PORT, 10);
    await new Promise((resolve, reject) => {
      const c = net.connect(proxyPort, '127.0.0.1', () => {
        c.write([
          'GET /openai/realtime?model=test HTTP/1.1',
          `Host: localhost:${proxyPort}`,
          'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Authorization: Bearer fake', '', '',
        ].join('\r\n'));
        // After handshake: send one masked client text frame.
        setTimeout(() => {
          const payload = Buffer.from(clientMarker, 'utf8');
          const mask = Buffer.from([1, 2, 3, 4]);
          const masked = Buffer.from(payload);
          for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
          c.write(Buffer.concat([Buffer.from([0x81, payload.length | 0x80]), mask, masked]));
        }, 50);
      });
      c.on('error', reject);
      c.on('data', () => {});
      // Give the proxy time to relay both frames before we tear down.
      setTimeout(() => { try { c.destroy(); } catch (_) {} resolve(); }, 350);
    });

    // Wait briefly for the proxy's last DB writes to flush.
    await new Promise(r => setTimeout(r, 150));

    const row = db.prepare(
      `SELECT id, provider, interface, endpoint, status_code FROM requests WHERE provider='openai' ORDER BY rowid DESC LIMIT 1`
    ).get();
    assert(row,                                     'no openai row created for upgrade');
    assert(row.endpoint === '/openai/realtime',     `endpoint=${row.endpoint}`);
    assert(row.status_code === 101,                 `status=${row.status_code} (expected 101)`);

    const frames = db.prepare(
      `SELECT direction, type, payload FROM websocket_frames WHERE request_id=? ORDER BY sequence`
    ).all(row.id);
    assert(frames.length >= 2,                      `frame count=${frames.length}`);
    assert(frames.some(f => f.direction === 'client' && f.payload === clientMarker), 'client frame missing or unmasked wrong');
    assert(frames.some(f => f.direction === 'server' && f.payload === serverMarker), 'server frame missing');

    // Dashboard frames endpoint
    const fr = await fetch(`${BASE}/api/requests/${row.id}/websocket-frames`);
    assert(fr.ok, `frames endpoint status=${fr.status}`);
    const fj = await fr.json();
    assert(fj.total >= 2,                           `frames endpoint total=${fj.total}`);
    assert(fj.frames.some(f => f.payload === clientMarker), 'frames endpoint missing client');

    // Search — frame payload should be hit
    const sr = await fetch(`${BASE}/api/requests?search=${encodeURIComponent(clientMarker)}`);
    const sj = await sr.json();
    assert(sj.total >= 1,                           `search by frame payload total=${sj.total}`);
    assert(sj.requests.some(r => r.id === row.id),  'search by frame payload missed our row');
    const ourRow = sj.requests.find(r => r.id === row.id);
    assert(ourRow.websocket_frame_count >= 2,       `ws_frame_count=${ourRow.websocket_frame_count}`);
    assert(Array.isArray(ourRow.websocket_matches) && ourRow.websocket_matches.length >= 1,
      'websocket_matches missing on search hit');

    record('websocket: upgrade logged, both directions captured, frames endpoint + search work', 'PASS',
      `frames=${frames.length}`);
  } finally {
    PROVIDERS.openai.upstreamBase = savedBase;
    PROVIDERS.openai.defaultPathPrefix = savedPrefix;
    // Fire-and-forget close: upgraded sockets are detached from http.Server
    // in Node, so close() can hang indefinitely waiting for them. The
    // runner's process.exit() at the end terminates any stragglers.
    if (typeof upstream.closeAllConnections === 'function') upstream.closeAllConnections();
    upstream.close();
  }
}

// ── Policy hook test ────────────────────────────────────────────────────
// Spins up a mock hook server (returns 403 + redaction) and a mock
// upstream (captures the body it receives), writes a temporary policy
// file with an outbound rule matching a unique marker, reloads, then
// posts a body containing the marker. Asserts the upstream received the
// redaction string instead of the marker.
async function testPolicyOutboundRedaction() {
  const marker     = `POLICY_${process.pid}_${Date.now()}`;
  const redaction  = `[REDACTED_${process.pid}]`;

  // Mock hook server.
  const hooks = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/hooks/policy') { res.writeHead(404).end(); return; }
    req.resume();
    req.on('end', () => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allow: false, redaction, reason: 'test' }));
    });
  });
  await new Promise(r => hooks.listen(0, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${hooks.address().port}/hooks/policy`;

  // Mock upstream.
  let upstreamBody = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      upstreamBody = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));

  // Temp policy file.
  const policyPath = path.join(__dirname, `.test-policies-${process.pid}.json`);
  fs.writeFileSync(policyPath, JSON.stringify({
    outbound: [{ name: 'test-marker', pattern: marker, hook_url: hookUrl }],
    inbound: [],
  }));

  const savedBase = PROVIDERS.openai.upstreamBase;
  const savedPrefix = PROVIDERS.openai.defaultPathPrefix;
  const savedPolicyEnv = process.env.LLM_PROXY_POLICY_FILE;
  PROVIDERS.openai.upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  PROVIDERS.openai.defaultPathPrefix = '';
  process.env.LLM_PROXY_POLICY_FILE = policyPath;

  try {
    const reload = await fetch(`${BASE}/api/policies/reload`, { method: 'POST' });
    assert(reload.ok, `reload status=${reload.status}`);
    const reloadJson = await reload.json();
    assert(reloadJson.outbound === 1, `outbound rules=${reloadJson.outbound} (expected 1)`);

    const r = await fetch(`${BASE}/openai/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: marker }] }),
    });
    assert(r.ok, `proxy status=${r.status}`);
    assert(upstreamBody,                                  'upstream got no body');
    assert(!upstreamBody.includes(marker),                `marker leaked: ${upstreamBody.slice(0, 200)}`);
    assert(upstreamBody.includes(redaction),              `redaction missing: ${upstreamBody.slice(0, 200)}`);

    record('policy: outbound rule denial replaces matched body with redaction', 'PASS');
  } finally {
    PROVIDERS.openai.upstreamBase = savedBase;
    PROVIDERS.openai.defaultPathPrefix = savedPrefix;
    if (savedPolicyEnv === undefined) delete process.env.LLM_PROXY_POLICY_FILE;
    else process.env.LLM_PROXY_POLICY_FILE = savedPolicyEnv;
    try { fs.unlinkSync(policyPath); } catch (_) {}
    if (typeof upstream.closeAllConnections === 'function') upstream.closeAllConnections();
    if (typeof hooks.closeAllConnections === 'function') hooks.closeAllConnections();
    upstream.close();
    hooks.close();
    // Reload to clear the policy.
    await fetch(`${BASE}/api/policies/reload`, { method: 'POST' });
  }
}

// ── Runner ──────────────────────────────────────────────────────────────
async function main() {
  await waitHealthy();

  const filter = process.argv[2];
  const all = [
    ['migration',  testCproxyMigration],
    ['models',     testHealthAndModels],
    ['claude',     testClaudeNonStreaming],
    ['claude',     testClaudeStreaming],
    ['claude',     testClaudeAliasV1Messages],
    ['deepseek',   testDeepseekNonStreaming],
    ['deepseek',   testDeepseekStreaming],
    ['openai',     testOpenaiNonStreaming],
    ['openai',     testOpenaiStreaming],
    ['openrouter', testOpenrouterGeminiNonStreaming],
    ['openrouter', testOpenrouterGeminiStreaming],
    ['dashboard',  testDashboard],
    ['dashboard',  testDashboardNavigation],
    ['websocket',  testWebSocketFrames],
    ['policy',     testPolicyOutboundRedaction],
  ];

  for (const [tag, fn] of all) {
    if (filter && !tag.includes(filter)) continue;
    try {
      await fn();
    } catch (e) {
      record(fn.name, 'FAIL', e.message);
    }
  }

  console.log(`\n──────────────────────────────────`);
  console.log(`Passed:  ${passed}`);
  console.log(`Failed:  ${failed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`DB:      ${TEST_DB} (${db.prepare('SELECT COUNT(*) c FROM requests').get().c} rows captured)`);

  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  server.close();
  db.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('runner crashed:', err);
  try { server.close(); } catch (_) {}
  process.exit(2);
});
