// End-to-end tests for llmproxy. Real API calls, real SQLite, no stubs.
//
// Requires env vars:
//   ANTHROPIC_API_KEY  — for the /claude tests
//   DEEPSEEK_API_KEY   — for the /deepseek tests
//
// Each test cohort is skipped (with a notice) if its key is unset.
//
// Usage:
//   node test.js                # runs all tests
//   node test.js claude         # only claude
//   node test.js deepseek       # only deepseek
//   node test.js models         # only static-route tests

'use strict';

const fs   = require('fs');
const path = require('path');

// Spawn the server in this same process, with its own test.db. We use a
// fresh file each run so token assertions don't fight history.
const TEST_DB = path.join(__dirname, 'test.db');
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch (_) {}
}
process.env.LLMPROXY_DB = TEST_DB;
process.env.PORT        = process.env.TEST_PORT || '8183';

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
const { server, db } = require('./server.js');

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
  const claudeEntry   = mj.data.find(d => d.id === 'claude-opus-4-7');
  const deepseekEntry = mj.data.find(d => d.id === 'deepseek-v4-pro');
  assert(claudeEntry,   'claude-opus-4-7 not in /models');
  assert(deepseekEntry, 'deepseek-v4-pro not in /models');
  assert(claudeEntry.interface === 'anthropic',  'claude not tagged anthropic');
  assert(deepseekEntry.interface === 'openai',   'deepseek not tagged openai');
  assert(claudeEntry.endpoint === '/claude/v1/messages',  'claude endpoint wrong');
  assert(deepseekEntry.endpoint === '/deepseek/v1/chat/completions', 'deepseek endpoint wrong');
  record('models: lists claude+deepseek with correct interface and endpoint', 'PASS');
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

// ── Runner ──────────────────────────────────────────────────────────────
async function main() {
  await waitHealthy();

  const filter = process.argv[2];
  const all = [
    ['models',   testHealthAndModels],
    ['claude',   testClaudeNonStreaming],
    ['claude',   testClaudeStreaming],
    ['deepseek', testDeepseekNonStreaming],
    ['deepseek', testDeepseekStreaming],
    ['dashboard', testDashboard],
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

  server.close();
  db.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('runner crashed:', err);
  try { server.close(); } catch (_) {}
  process.exit(2);
});
