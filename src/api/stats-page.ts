// A single self-contained HTML page (no build step, no framework) that renders the live
// stats from /stats/summary and /stats/latency. Deliberately minimal and honest: it shows
// only the numbers the ledger actually has. If auth is enabled, paste your API key in the
// box (the page sends it as a Bearer token).

export function statsPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SemanticCache — stats</title>
<style>
  :root { color-scheme: dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; background:#0d1117; color:#e6edf3; }
  header { padding: 24px 32px; border-bottom:1px solid #21262d; }
  h1 { margin:0; font-size:20px; } h1 span { color:#58a6ff; }
  main { padding: 24px 32px; max-width: 960px; }
  .row { display:flex; gap:16px; flex-wrap:wrap; margin-bottom:24px; }
  .card { background:#161b22; border:1px solid #21262d; border-radius:10px; padding:18px 20px; min-width:160px; flex:1; }
  .card .label { color:#8b949e; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .card .value { font-size:28px; font-weight:600; margin-top:6px; }
  .green { color:#3fb950; } .blue { color:#58a6ff; } .yellow { color:#d29922; }
  table { width:100%; border-collapse:collapse; margin-top:8px; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid #21262d; }
  th { color:#8b949e; font-weight:500; font-size:12px; text-transform:uppercase; }
  input { background:#0d1117; border:1px solid #30363d; color:#e6edf3; border-radius:6px; padding:7px 10px; }
  .muted { color:#8b949e; font-size:13px; }
</style>
</head>
<body>
<header>
  <h1>Semantic<span>Cache</span> — live stats</h1>
  <p class="muted">Real aggregates from the usage ledger. Updates every 5s.</p>
</header>
<main>
  <div class="muted" style="margin-bottom:16px">
    API key (only if auth enabled): <input id="key" type="password" placeholder="Bearer key" size="32" />
    &nbsp; namespace: <input id="ns" placeholder="(all)" size="14" />
  </div>
  <div class="row">
    <div class="card"><div class="label">Hit rate</div><div class="value green" id="hitRate">–</div></div>
    <div class="card"><div class="label">$ saved</div><div class="value green" id="saved">–</div></div>
    <div class="card"><div class="label">$ spent</div><div class="value yellow" id="spent">–</div></div>
    <div class="card"><div class="label">Tokens saved</div><div class="value blue" id="tokens">–</div></div>
  </div>
  <div class="row">
    <div class="card"><div class="label">Exact hits</div><div class="value" id="exact">–</div></div>
    <div class="card"><div class="label">Semantic hits</div><div class="value" id="semantic">–</div></div>
    <div class="card"><div class="label">Misses (Gemini calls)</div><div class="value" id="miss">–</div></div>
  </div>
  <h3>Latency by outcome (ms)</h3>
  <table>
    <thead><tr><th>Outcome</th><th>Count</th><th>p50</th><th>p95</th><th>p99</th></tr></thead>
    <tbody id="lat"><tr><td colspan="5" class="muted">loading…</td></tr></tbody>
  </table>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  function headers() {
    const k = $('key').value.trim();
    return k ? { Authorization: 'Bearer ' + k } : {};
  }
  function nsQuery() {
    const ns = $('ns').value.trim();
    return ns ? ('?namespace=' + encodeURIComponent(ns)) : '';
  }
  async function refresh() {
    try {
      const [s, l] = await Promise.all([
        fetch('/stats/summary' + nsQuery(), { headers: headers() }).then(r => r.json()),
        fetch('/stats/latency' + nsQuery(), { headers: headers() }).then(r => r.json()),
      ]);
      $('hitRate').textContent = (s.hitRate * 100).toFixed(1) + '%';
      $('saved').textContent = '$' + (s.costUsd?.saved ?? 0).toFixed(4);
      $('spent').textContent = '$' + (s.costUsd?.spent ?? 0).toFixed(4);
      $('tokens').textContent = (s.tokensSaved ?? 0).toLocaleString();
      $('exact').textContent = s.hits?.exact ?? 0;
      $('semantic').textContent = s.hits?.semantic ?? 0;
      $('miss').textContent = s.counts?.generate ?? 0;
      const rows = ['exact','semantic','miss'].map(k => {
        const d = l[k] || { count:0,p50:0,p95:0,p99:0 };
        return '<tr><td>'+k+'</td><td>'+d.count+'</td><td>'+d.p50+'</td><td>'+d.p95+'</td><td>'+d.p99+'</td></tr>';
      }).join('');
      $('lat').innerHTML = rows;
    } catch (e) {
      $('lat').innerHTML = '<tr><td colspan="5" class="muted">error: ' + e + '</td></tr>';
    }
  }
  refresh();
  setInterval(refresh, 5000);
</script>
</body>
</html>`;
}
