/** The dashboard is a single self-contained page — no build step, no CDN. */
export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>infinite</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --panel: #ffffff;
  --border: #e2e5ea;
  --text: #16181d;
  --muted: #6b7280;
  --accent: #3b6cf6;
  --ok: #17915a;
  --warn: #b45309;
  --err: #c62d42;
  --track: #e8eaee;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115;
    --panel: #171a21;
    --border: #262b35;
    --text: #e6e8ec;
    --muted: #9099a8;
    --accent: #6b93ff;
    --ok: #3ecf8e;
    --warn: #e8a33d;
    --err: #ff6b7f;
    --track: #232830;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
header {
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  padding: 14px 20px; border-bottom: 1px solid var(--border); background: var(--panel);
  position: sticky; top: 0; z-index: 10;
}
h1 { font-size: 16px; margin: 0; letter-spacing: -0.01em; }
h1 span { color: var(--muted); font-weight: 400; }
.pill {
  font-size: 12px; padding: 3px 10px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--bg); font-weight: 600;
}
.pill.running { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, transparent); }
.pill.paused, .pill.blocked { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
.pill.error { color: var(--err); border-color: color-mix(in srgb, var(--err) 40%, transparent); }
.pill.complete { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.spacer { flex: 1; }
button {
  font: inherit; font-size: 13px; padding: 6px 13px; border-radius: 7px;
  border: 1px solid var(--border); background: var(--panel); color: var(--text);
  cursor: pointer;
}
button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
button:disabled { opacity: .45; cursor: not-allowed; }
main { padding: 20px; display: grid; gap: 16px; grid-template-columns: minmax(0,2fr) minmax(0,1fr); max-width: 1500px; }
@media (max-width: 940px) { main { grid-template-columns: minmax(0,1fr); } }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 11px; padding: 16px; min-width: 0; }
.card h2 { margin: 0 0 12px; font-size: 12px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); }
.gauge { height: 22px; background: var(--track); border-radius: 6px; overflow: hidden; position: relative; }
.gauge > i { display: block; height: 100%; background: var(--ok); transition: width .4s ease, background .4s ease; }
.gauge.warn > i { background: var(--warn); }
.gauge.hot > i { background: var(--err); }
.gauge > b {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums;
  text-shadow: 0 0 4px var(--panel);
}
.marker { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--text); opacity: .45; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; margin-top: 14px; }
.stat { border: 1px solid var(--border); border-radius: 8px; padding: 9px 11px; }
.stat b { display: block; font-size: 18px; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.stat span { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
.log { font-family: var(--mono); font-size: 12px; max-height: 340px; overflow-y: auto; }
.log div { padding: 2px 0; border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent); word-break: break-word; }
.log time { color: var(--muted); margin-right: 8px; }
.log em { font-style: normal; color: var(--accent); margin-right: 8px; }
.log .warn em { color: var(--warn); }
.log .error em { color: var(--err); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); padding: 0 8px 7px 0; font-weight: 600; }
td { padding: 7px 8px 7px 0; border-top: 1px solid var(--border); vertical-align: top; }
td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.tag { font-size: 11px; padding: 1px 7px; border-radius: 5px; border: 1px solid var(--border); white-space: nowrap; }
.tag.handoff { color: var(--accent); }
.tag.complete { color: var(--ok); }
.tag.error, .tag.blocked { color: var(--err); }
a { color: var(--accent); }
.row { display: flex; gap: 8px; }
input[type=text] {
  flex: 1; min-width: 0; font: inherit; font-size: 13px; padding: 7px 11px;
  border-radius: 7px; border: 1px solid var(--border); background: var(--bg); color: var(--text);
}
.muted { color: var(--muted); }
.scroll { max-height: 300px; overflow-y: auto; }
pre {
  white-space: pre-wrap; word-break: break-word; font-family: var(--mono);
  font-size: 12px; background: var(--bg); border: 1px solid var(--border);
  border-radius: 8px; padding: 12px; max-height: 460px; overflow: auto; margin: 0;
}
ul.tasks { list-style: none; margin: 0 0 12px; padding: 0; font-size: 13px; }
ul.tasks li { padding: 5px 0; border-bottom: 1px solid var(--border); display: flex; gap: 8px; }
ul.tasks li s { color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>infinite <span id="mission-path"></span></h1>
  <span class="pill" id="status">connecting</span>
  <span class="muted" id="leg-label"></span>
  <div class="spacer"></div>
  <button id="btn-pause">Pause</button>
  <button id="btn-handoff">Hand off now</button>
  <button id="btn-stop">Stop</button>
</header>

<main>
  <div style="display:grid;gap:16px;min-width:0">
    <section class="card">
      <h2>Context window</h2>
      <div class="gauge" id="gauge"><i style="width:0"></i><b>—</b><span class="marker" id="marker" hidden></span></div>
      <div class="stats">
        <div class="stat"><b id="s-ctx">—</b><span>context used</span></div>
        <div class="stat"><b id="s-leg">—</b><span>session</span></div>
        <div class="stat"><b id="s-turns">—</b><span>turns total</span></div>
        <div class="stat"><b id="s-cost">—</b><span>spend</span></div>
        <div class="stat"><b id="s-model">—</b><span>model</span></div>
      </div>
      <p class="muted" id="ctx-note" style="margin:12px 0 0;font-size:12px"></p>
    </section>

    <section class="card">
      <h2>Sessions</h2>
      <div class="scroll">
        <table>
          <thead><tr><th>#</th><th>Outcome</th><th>Turns</th><th>Context</th><th>Cost</th><th style="width:45%">Summary</th></tr></thead>
          <tbody id="legs"><tr><td colspan="6" class="muted">No sessions yet.</td></tr></tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <h2>Handoff <select id="handoff-pick" style="font:inherit;font-size:12px"></select></h2>
      <pre id="handoff-body" class="muted">Select a session.</pre>
    </section>
  </div>

  <div style="display:grid;gap:16px;min-width:0">
    <section class="card">
      <h2>Queue an instruction</h2>
      <div class="row">
        <input type="text" id="task-input" placeholder="Delivered to the agent after its current turn">
        <button id="btn-task">Add</button>
      </div>
      <ul class="tasks" id="tasks" style="margin-top:12px"></ul>
    </section>

    <section class="card">
      <h2>Activity</h2>
      <div class="log" id="log"></div>
    </section>
  </div>
</main>

<script>
const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get('token') || '';
const auth = token ? { Authorization: 'Bearer ' + token } : {};
let threshold = 0.8;

function fmtUsd(n) { return '$' + (n ?? 0).toFixed(2); }
function fmtNum(n) { return (n ?? 0).toLocaleString(); }

function render(state) {
  threshold = state.config?.handoffThreshold ?? threshold;
  $('status').textContent = state.status;
  $('status').className = 'pill ' + state.status;
  $('mission-path').textContent = state.missionPath || '';
  $('leg-label').textContent = state.currentLeg ? 'session ' + state.currentLeg + ' active' : '';

  const ctx = state.context;
  const pct = ctx ? ctx.pct : 0;
  const gauge = $('gauge');
  gauge.querySelector('i').style.width = Math.min(100, pct * 100) + '%';
  gauge.querySelector('b').textContent = ctx ? (pct * 100).toFixed(1) + '%' : '—';
  gauge.className = 'gauge' + (pct >= threshold ? ' hot' : pct >= threshold * 0.75 ? ' warn' : '');
  const marker = $('marker');
  marker.hidden = false;
  marker.style.left = (threshold * 100) + '%';
  marker.title = 'handoff threshold';

  $('s-ctx').textContent = ctx ? fmtNum(ctx.tokens) + ' / ' + fmtNum(ctx.maxTokens) : '—';
  $('s-leg').textContent = state.currentLeg || state.legs.length;
  $('s-turns').textContent = fmtNum(state.totalTurns);
  $('s-cost').textContent = fmtUsd(state.totalCostUsd);
  $('s-model').textContent = ctx ? ctx.model : '—';
  $('ctx-note').textContent = ctx
    ? 'Handoff fires at ' + (threshold * 100).toFixed(0) + '%. Claude Code auto-compact is '
      + (ctx.autoCompactEnabled ? 'on' : 'off')
      + (ctx.autoCompactThreshold ? ' (its own threshold: ' + ctx.autoCompactThreshold + '%)' : '') + '.'
    : 'No context reading yet — it arrives after the first completed turn.';

  const rows = state.legs.map((l) =>
    '<tr><td class="num">' + l.n + '</td>'
    + '<td><span class="tag ' + l.outcome + '">' + l.outcome + '</span></td>'
    + '<td class="num">' + l.turns + '</td>'
    + '<td class="num">' + (l.contextPct ? (l.contextPct * 100).toFixed(0) + '%' : '—') + '</td>'
    + '<td class="num">' + fmtUsd(l.costUsd) + '</td>'
    + '<td>' + esc(l.summary || l.reason || '') + '</td></tr>'
  );
  $('legs').innerHTML = rows.length ? rows.join('') : '<tr><td colspan="6" class="muted">No sessions yet.</td></tr>';

  const pick = $('handoff-pick');
  const want = state.legs.filter((l) => l.handoffFile).map((l) => l.n);
  if (pick.dataset.keys !== want.join(',')) {
    pick.dataset.keys = want.join(',');
    pick.innerHTML = want.map((n) => '<option value="' + n + '">session ' + n + '</option>').join('');
    if (want.length) loadHandoff(want[want.length - 1]);
  }

  $('tasks').innerHTML = state.tasks.slice(-25).map((t) =>
    '<li>' + (t.status === 'done' ? '<s>' + esc(t.text) + '</s>' : esc(t.text))
    + '<span class="muted" style="margin-left:auto">' + t.status + '</span></li>'
  ).join('') || '<li class="muted">Nothing queued.</li>';

  const paused = state.status === 'paused';
  $('btn-pause').textContent = paused ? 'Resume' : 'Pause';
  const dead = ['stopped', 'complete', 'error', 'blocked', 'idle'].includes(state.status);
  $('btn-handoff').disabled = dead;
  $('btn-stop').disabled = dead;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function addEvent(ev) {
  const log = $('log');
  const el = document.createElement('div');
  el.className = ev.level;
  el.innerHTML = '<time>' + ev.ts.slice(11, 19) + '</time><em>' + esc(ev.kind) + '</em>' + esc(ev.msg);
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  log.appendChild(el);
  while (log.children.length > 400) log.removeChild(log.firstChild);
  if (atBottom) log.scrollTop = log.scrollHeight;
}

async function loadHandoff(n) {
  const res = await fetch('api/handoff/' + n, { headers: auth });
  $('handoff-body').textContent = res.ok ? await res.text() : 'Not available.';
  $('handoff-body').classList.remove('muted');
}

async function post(action, body) {
  await fetch('api/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify(body || {}),
  });
}

$('btn-pause').onclick = () => post('control', { action: $('btn-pause').textContent === 'Pause' ? 'pause' : 'resume' });
$('btn-handoff').onclick = () => post('control', { action: 'handoff' });
$('btn-stop').onclick = () => { if (confirm('Stop the run after the current turn?')) post('control', { action: 'stop' }); };
$('btn-task').onclick = () => {
  const input = $('task-input');
  if (!input.value.trim()) return;
  post('tasks', { text: input.value.trim() });
  input.value = '';
};
$('task-input').onkeydown = (e) => { if (e.key === 'Enter') $('btn-task').click(); };
$('handoff-pick').onchange = (e) => loadHandoff(e.target.value);

const es = new EventSource('api/events' + (token ? '?token=' + encodeURIComponent(token) : ''));
es.addEventListener('state', (e) => render(JSON.parse(e.data)));
es.addEventListener('log', (e) => addEvent(JSON.parse(e.data)));
es.addEventListener('history', (e) => JSON.parse(e.data).forEach(addEvent));
es.onerror = () => { $('status').textContent = 'disconnected'; $('status').className = 'pill error'; };
</script>
</body>
</html>`
}
