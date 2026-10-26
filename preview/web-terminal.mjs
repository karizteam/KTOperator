/**
 * Web terminal preview for the KT Operator interactive console.
 * Spawns `node dist/cli.js` inside a real PTY (node-pty) per browser
 * connection and bridges it to xterm.js over WebSocket.
 * Themed in #8B9A6E with Vazirmatn Persian font support & MadeByKariz branding.
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node-pty';
import { WebSocketServer } from 'ws';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(root, 'dist', 'cli.js');
const PORT = Number(process.env.PORT ?? 7681);
const DEMO_HOME = process.env.OPERATOR_HOME ?? '/tmp/op-web-home';

const HTML = `<!doctype html>
<html lang="fa" dir="ltr">
<head>
<meta charset="utf-8">
<title>KT Operator — MadeByKariz</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Vazirmatn:wght@400;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<style>
  html, body { margin:0; height:100%; background:#0d100b; color:#d8e0cc; font-family:'JetBrains Mono','Vazirmatn',ui-monospace,Menlo,Consolas,monospace; }
  #bar { padding:10px 16px; background:#141911; border-bottom:1px solid #8B9A6E44; display:flex; gap:14px; align-items:center; font-size:13px; }
  #bar b { color:#8B9A6E; letter-spacing:0.5px; }
  .badge { background:#8B9A6E; color:#0d100b; padding:2px 8px; border-radius:4px; font-weight:700; font-size:11px; }
  #dot { width:9px; height:9px; border-radius:50%; background:#e0af68; display:inline-block; }
  #dot.on { background:#8B9A6E; box-shadow: 0 0 8px #8B9A6E; }
  #term { padding:10px 12px; height:calc(100% - 44px); box-sizing:border-box; }
  a { color:#8B9A6E; }
</style>
</head>
<body>
<div id="bar">
  <span id="dot"></span>
  <b>KT Operator</b>
  <span class="badge">MadeByKariz</span>
  <span>Theme #8B9A6E · Persian/RTL Ready</span>
</div>
<div id="term"></div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<script>
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Vazirmatn', monospace",
    theme: {
      background: '#0d100b',
      foreground: '#d8e0cc',
      cursor: '#8B9A6E',
      selectionBackground: '#8B9A6E44',
      cyan: '#8B9A6E',
      magenta: '#b2c294',
      green: '#8B9A6E',
      yellow: '#e0af68',
      red: '#f7768e',
      blue: '#8B9A6E'
    }
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('term'));
  const fitAll = () => { fit.fit(); };
  window.addEventListener('resize', () => { fitAll(); sendSize(); });
  fitAll();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(proto + '://' + location.host + '/pty');
  const dot = document.getElementById('dot');
  const sendSize = () => { if (ws.readyState === 1) ws.send(JSON.stringify({type:'resize', cols:term.cols, rows:term.rows})); };

  ws.onopen = () => { dot.classList.add('on'); sendSize(); term.focus(); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'output') term.write(m.data);
    if (m.type === 'exit') { dot.classList.remove('on'); term.write('\\r\\n\\x1b[2m[console process exited — refresh to start over]\\x1b[0m\\r\\n'); }
  };
  ws.onclose = () => { dot.classList.remove('on'); term.write('\\r\\n\\x1b[2m[connection closed — refresh to reconnect]\\x1b[0m\\r\\n'); };
  term.onData((d) => { if (ws.readyState === 1) ws.send(JSON.stringify({type:'input', data:d})); });
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(HTML);
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, path: '/pty' });

wss.on('connection', (ws) => {
  const pty = spawn('node', [CLI], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: root,
    env: { ...process.env, OPERATOR_HOME: DEMO_HOME, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' },
  });

  pty.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'output', data }));
  });
  pty.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.type === 'input' && typeof msg.data === 'string') pty.write(msg.data);
    else if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0) {
      try { pty.resize(Math.min(msg.cols, 300), Math.min(msg.rows, 100)); } catch { /* racing an exited pty */ }
    }
  });
  ws.on('close', () => { try { pty.kill(); } catch { /* already gone */ } });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`KT Operator web terminal on http://0.0.0.0:${PORT} (OPERATOR_HOME=${DEMO_HOME})`);
});
