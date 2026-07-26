// Stats page generator for Atto Corp llmproxy
// Generates a self-contained HTML page from proxy DB queries.
const Database = require('better-sqlite3');

function generateStatsPage(dbPath) {
  const db = new Database(dbPath);
  try {
  db.pragma('journal_mode = WAL');

  // Helper: format bytes into human-readable
  function fmt(n) {
    if (!n) return '0';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  // Fleet totals
  const fleet = db.prepare(`SELECT 
    COUNT(*) as requests,
    SUM(COALESCE(input_tokens,0)) as tok_in,
    SUM(COALESCE(output_tokens,0)) as tok_out,
    SUM(COALESCE(cache_read_input_tokens,0)) as cache_read,
    SUM(COALESCE(cache_creation_input_tokens,0)) as cache_write,
    AVG(response_time) as avg_ms,
    SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors,
    SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) as ok
  FROM requests`).get();

  // Per-agent stats
  const agents = db.prepare(`SELECT 
    COALESCE(agent,'(none)') as agent,
    COUNT(*) as requests,
    SUM(COALESCE(input_tokens,0)) as tok_in,
    SUM(COALESCE(output_tokens,0)) as tok_out,
    SUM(COALESCE(cache_read_input_tokens,0)) as cache_read,
    AVG(response_time) as avg_ms,
    SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) as ok,
    SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors
  FROM requests GROUP BY agent ORDER BY COUNT(*) DESC`).all();

  // Daily volume
  const daily = db.prepare(`SELECT 
    DATE(timestamp) as day,
    COUNT(*) as requests,
    SUM(COALESCE(input_tokens,0)) as tok_in,
    SUM(COALESCE(output_tokens,0)) as tok_out
  FROM requests GROUP BY day ORDER BY day DESC LIMIT 14`).all();

  // Per-provider stats
  const providers = db.prepare(`SELECT provider, COUNT(*) as requests,
    SUM(COALESCE(input_tokens,0)) as tok_in,
    SUM(COALESCE(output_tokens,0)) as tok_out
  FROM requests GROUP BY provider ORDER BY COUNT(*) DESC`).all();

  const totalTokens = (fleet.tok_in || 0) + (fleet.tok_out || 0);

  // Generate agent rows HTML
  let agentRows = '';
  let rank = 1;
  for (const a of agents) {
    const agentName = a.agent === '(none)' ? '<em>(direct)</em>' : a.agent;
    const pct = totalTokens ? ((a.tok_in + a.tok_out) / totalTokens * 100).toFixed(1) : 0;
    agentRows += `<tr>
      <td>${rank++}</td>
      <td><b>${agentName}</b></td>
      <td>${a.requests}</td>
      <td>${fmt(a.tok_in)}</td>
      <td>${fmt(a.tok_out)}</td>
      <td>${fmt(a.cache_read)}</td>
      <td>${pct}%</td>
      <td>${Math.round(a.avg_ms || 0).toLocaleString()}</td>
      <td>${a.errors || 0}</td>
    </tr>`;
  }

  // Daily volume rows
  let dailyRows = '';
  for (const d of daily) {
    dailyRows += `<tr>
      <td>${d.day}</td>
      <td>${d.requests.toLocaleString()}</td>
      <td>${fmt(d.tok_in)}</td>
      <td>${fmt(d.tok_out)}</td>
    </tr>`;
  }

  // Provider rows
  let provRows = '';
  for (const p of providers) {
    provRows += `<tr>
      <td>${p.provider}</td>
      <td>${p.requests}</td>
      <td>${fmt(p.tok_in)}</td>
      <td>${fmt(p.tok_out)}</td>
    </tr>`;
  }

  const errors = fleet.errors || 0;
  const successRate = fleet.requests ? ((fleet.ok / fleet.requests) * 100).toFixed(1) : 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Atto Corp · Stats</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, system-ui, sans-serif; background: #f8f9fa; color: #1a1a2e; padding: 20px; }
.container { max-width: 1000px; margin: 0 auto; }
h1 { font-size: 22px; margin-bottom: 4px; color: #1a1a2e; }
.subtitle { font-size: 12px; color: #6c757d; margin-bottom: 20px; }
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 24px; }
.stat-card { background: white; border: 1px solid #dee2e6; border-radius: 8px; padding: 12px 16px; }
.stat-card .value { font-size: 20px; font-weight: 700; color: #1a1a2e; }
.stat-card .label { font-size: 11px; color: #6c757d; text-transform: uppercase; letter-spacing: 0.3px; margin-top: 2px; }
.stat-card.primary { border-left: 3px solid #4361ee; }
.stat-card.success { border-left: 3px solid #06d6a0; }
.stat-card.warn { border-left: 3px solid #ffd166; }
.stat-card.danger { border-left: 3px solid #ef476f; }
.stat-card.big { grid-column: span 2; }
h2 { font-size: 15px; margin: 24px 0 8px; padding-bottom: 6px; border-bottom: 1px solid #dee2e6; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #e9ecef; }
th { background: #f1f3f5; font-weight: 600; white-space: nowrap; position: sticky; top: 0; }
tr:hover { background: #f8f9fa; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.footer { margin-top: 30px; font-size: 11px; color: #adb5bd; text-align: center; }
@media (max-width: 600px) {
  .summary { grid-template-columns: repeat(2, 1fr); }
  .stat-card.big { grid-column: span 2; }
  .table-wrap { overflow-x: auto; }
}
</style>
</head>
<body>
<div class="container">
  <h1>Atto Corp · Fleet Stats</h1>
  <div class="subtitle">generated ${now} UTC · ${fleet.requests.toLocaleString()} total requests · ${successRate}% success rate</div>

  <div class="summary">
    <div class="stat-card primary big">
      <div class="value">${fleet.requests.toLocaleString()}</div>
      <div class="label">Total Requests</div>
    </div>
    <div class="stat-card primary">
      <div class="value">${fmt(fleet.tok_in)}</div>
      <div class="label">Tokens In</div>
    </div>
    <div class="stat-card primary">
      <div class="value">${fmt(fleet.tok_out)}</div>
      <div class="label">Tokens Out</div>
    </div>
    <div class="stat-card success">
      <div class="value">${fmt(fleet.cache_read)}</div>
      <div class="label">Cache Read</div>
    </div>
    <div class="stat-card success">
      <div class="value">${fmt(fleet.cache_write)}</div>
      <div class="label">Cache Write</div>
    </div>
    <div class="stat-card">
      <div class="value">${Math.round(fleet.avg_ms || 0).toLocaleString()}ms</div>
      <div class="label">Avg Response Time</div>
    </div>
    <div class="stat-card ${errors > 0 ? 'danger' : 'success'}">
      <div class="value">${errors}</div>
      <div class="label">Errors</div>
    </div>
  </div>

  <h2>Token Usage by Agent</h2>
  <div class="table-wrap">
  <table>
    <thead><tr>
      <th>#</th><th>Agent</th><th>Reqs</th><th>In</th><th>Out</th><th>Cache</th><th>%</th><th>Avg ms</th><th>Errors</th>
    </tr></thead>
    <tbody>${agentRows}</tbody>
  </table>
  </div>

  <h2>Providers</h2>
  <div class="table-wrap">
  <table>
    <thead><tr><th>Provider</th><th>Requests</th><th>In</th><th>Out</th></tr></thead>
    <tbody>${provRows}</tbody>
  </table>
  </div>

  <h2>Daily Volume</h2>
  <div class="table-wrap">
  <table>
    <thead><tr><th>Date</th><th>Requests</th><th>In</th><th>Out</th></tr></thead>
    <tbody>${dailyRows}</tbody>
  </table>
  </div>

  <div class="footer">Atto Corp · llmproxy stats</div>
</div>
</body>
</html>`;
  } finally {
    db.close();
  }
}

module.exports = { generateStatsPage };
