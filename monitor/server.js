#!/usr/bin/env node
/*
 * sourby-st monitor — live web dashboard + remote control for a local test server.
 *
 * Serves a dashboard (TPS / MSPT / players / RSS / bots), pushes live stats over WebSocket, exposes
 * GET /api/stats as JSON (send that URL to anyone who should watch), and — behind a token — starts /
 * stops the test server and the bot swarm. Reads config.json; everything is local to this box.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
let Rcon; try { Rcon = require('rcon-client').Rcon; } catch (e) {}

const ROOT = path.join(__dirname, '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const WEB_PORT = CFG.web.port || 8080;
const TOKEN = CFG.web.token || '';

const SERVER_LOG = path.join(ROOT, CFG.server.dir || 'testserver', 'logs', 'latest.log');
const state = {
  server: { running: false, pid: null, startedAt: null },
  bots: { running: false, connected: 0, spawned: 0, kicked: 0, target: 0, shards: 0 },
  stats: { tps: null, mspt: null, players: null, rssMb: null, tier: null, memPct: null, heapGb: CFG.server.heapGb || null, ts: 0 },
  spark: { running: false, status: '', url: null, urls: [] },
  log: [],
};
// Minecraft uses § colour codes (incl. §x§f§f… hex runs), not ANSI — strip both before parsing.
const strip = s => String(s).replace(/§./g, '').replace(/\x1b\[[0-9;]*m/g, '');
function pushLog(line) { state.log.push({ t: Date.now(), line }); if (state.log.length > 200) state.log.shift(); }

// Tail the server console log: surfaces spark URLs (spark replies async to the console, not RCON)
// plus warnings/errors into the dashboard. Handles rotation by resetting on shrink.
let logOffset = -1;
function tailServerLog() {
  let st; try { st = fs.statSync(SERVER_LOG); } catch (e) { return; }
  if (logOffset < 0) { logOffset = st.size; return; }          // start at EOF; don't replay old log
  if (st.size < logOffset) logOffset = 0;                       // rotated
  if (st.size === logOffset) return;
  try {
    const fd = fs.openSync(SERVER_LOG, 'r');
    const buf = Buffer.alloc(st.size - logOffset);
    fs.readSync(fd, buf, 0, buf.length, logOffset); fs.closeSync(fd);
    logOffset = st.size;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const url = line.match(/https:\/\/spark\.lucko\.me\/[A-Za-z0-9]+/);
      if (url) { state.spark.url = url[0]; state.spark.running = false; state.spark.status = 'done'; state.spark.urls.unshift(url[0]); state.spark.urls = state.spark.urls.slice(0, 8); pushLog('[spark] ' + url[0]); continue; }
      const body = line.replace(/^\[[0-9:]+\]\s*\[[^\]]*\]:\s*/, '').trim();
      if (/\[⚡\]|profiler/i.test(line)) { if (/now running/i.test(line)) state.spark.status = 'running'; pushLog('[spark] ' + body.replace(/\[⚡\]\s*/, '')); }
      else if (/\/(WARN|ERROR)\]/.test(line)) pushLog('[mc] ' + body);
    }
  } catch (e) {}
}
function sendConsole(cmd) { try { return require('child_process').spawnSync('tmux', ['send-keys', '-t', SERVER_TMUX, cmd, 'Enter']).status === 0; } catch (e) { return false; } }

// ---- child processes ----
// The SERVER runs in its own tmux session ("st-server") so it survives a monitor restart; the
// monitor attaches to it over RCON + PID discovery. The bot swarm runs as one-or-more child
// processes (shards) — a single Node event loop caps out ~130 clients, so 1000 needs several.
let botProcs = [];   // [{ proc, connected, spawned, kicked }]
const SERVER_TMUX = 'st-server';
function serverRunningPid() { return discoverServerPid(); }
function startServer() {
  if (serverRunningPid()) return { ok: false, msg: 'server already running' };
  const inner = 'cd ' + JSON.stringify(ROOT) + ' && exec bash run-server.sh';
  const r = require('child_process').spawnSync('tmux', ['new-session', '-d', '-s', SERVER_TMUX, inner], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) return { ok: false, msg: 'tmux start failed: ' + String(r.stderr || '').trim() };
  state.server.running = true; state.server.startedAt = Date.now();
  pushLog('[server] launching in tmux session ' + SERVER_TMUX);
  return { ok: true };
}
async function stopServer() {
  if (!serverRunningPid()) return { ok: false, msg: 'server not running' };
  try { await rconCmd('stop'); } catch (e) {}
  pushLog('[server] stop requested (rcon)');
  setTimeout(() => { try { require('child_process').spawnSync('tmux', ['kill-session', '-t', SERVER_TMUX]); } catch (e) {} }, 10000);
  return { ok: true };
}
function aggBots() {
  state.bots.connected = botProcs.reduce((a, b) => a + b.connected, 0);
  state.bots.spawned = botProcs.reduce((a, b) => a + b.spawned, 0);
  state.bots.kicked = botProcs.reduce((a, b) => a + b.kicked, 0);
}
function startBots(count, shards, stagger) {
  if (botProcs.length) return { ok: false, msg: 'test already running' };
  count = count || CFG.bots.count;
  // auto-shard: ~150 bots per Node process, cap 16 shards
  shards = Math.min(16, Math.max(1, shards || CFG.bots.shards || (count > 150 ? Math.ceil(count / 150) : 1)));
  const per = Math.ceil(count / shards);
  state.bots.running = true; state.bots.target = per * shards; state.bots.shards = shards;
  for (let s = 0; s < shards; s++) {
    const rec = { connected: 0, spawned: 0, kicked: 0, proc: null };
    const args = ['swarm.js', '--count', String(per), '--prefix', (CFG.bots.prefix || 'ST_') + s + '_'];
    if (stagger) args.push('--stagger', String(stagger));  // unique per-shard prefix avoids username clashes
    const p = spawn('node', args, { cwd: ROOT });
    rec.proc = p;
    p.stdout.on('data', d => String(d).split('\n').forEach(l => {
      const m = l.match(/connected=(\d+) spawned=(\d+) kicked=(\d+)/);
      if (m) { rec.connected = +m[1]; rec.spawned = +m[2]; rec.kicked = +m[3]; aggBots(); }
    }));
    p.on('exit', () => { rec.proc = null; if (botProcs.every(r => !r.proc)) { botProcs = []; state.bots.running = false; state.bots.connected = state.bots.spawned = 0; pushLog('[bots] all shards stopped'); } });
    botProcs.push(rec);
  }
  pushLog('[bots] spawning ' + (per * shards) + ' bots across ' + shards + ' shard(s), ' + per + ' each' + (stagger ? (', stagger ' + stagger + 'ms') : ''));
  return { ok: true, shards: shards, per: per, total: per * shards };
}
function stopBots() {
  if (!botProcs.length) return { ok: false, msg: 'no test running' };
  botProcs.forEach(r => { try { r.proc && r.proc.kill('SIGTERM'); } catch (e) {} });
  return { ok: true };
}

// ---- RCON stats ----
let rcon = null, rconBusy = false;
async function ensureRcon() {
  if (rcon || !Rcon) return rcon;
  try {
    rcon = await Rcon.connect({ host: CFG.server.host || '127.0.0.1', port: CFG.server.rconPort || 25575, password: CFG.server.rconPassword || '' });
    rcon.on('error', () => { rcon = null; });
    rcon.on('end', () => { rcon = null; });
  } catch (e) { rcon = null; }
  return rcon;
}
async function rconCmd(cmd) {
  const r = await ensureRcon();
  if (!r) throw new Error('no rcon');
  return r.send(cmd);
}
function firstNum(s) { const m = String(s).replace(/\x1b\[[0-9;]*m/g, '').match(/(\d+(\.\d+)?)/); return m ? parseFloat(m[1]) : null; }
function readRss() {
  const pid = state.server.pid;
  if (!pid) return null;
  try {
    // execFileSync with an argument array (no shell) — pid is an int we control, kept safe regardless.
    const out = require('child_process').execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const kb = parseInt(out, 10); return isNaN(kb) ? null : Math.round(kb / 1024);
  } catch (e) { return null; }
}
// Find a server we didn't start ourselves (e.g. after a monitor restart) by its unique heap flag,
// so the dashboard re-attaches instead of going blind. -Xmx<heap>G is ours; production uses %RAM.
function discoverServerPid() {
  try {
    // No leading '-' — pgrep would parse "-Xmx…" as an option. "Xmx16G" still uniquely matches our
    // test server (production uses -XX:MaxRAMPercentage, never -Xmx16G).
    const pat = 'Xmx' + (CFG.server.heapGb || 8) + 'G';
    const out = require('child_process').execFileSync('pgrep', ['-f', pat], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const pid = parseInt(out.split('\n')[0], 10);
    return isNaN(pid) ? null : pid;
  } catch (e) { return null; }
}
async function poll() {
  if (rconBusy) return; rconBusy = true;
  try {
    // The server runs in its own tmux session; (re)discover its PID each poll so a monitor restart
    // re-attaches instead of going blind.
    if (state.server.pid == null) { const p = discoverServerPid(); if (p) state.server.pid = p; }
    if (state.server.pid) {
      let alive = false;
      // SourbyCraft /tps carries TPS + MSPT + perf-tier + memory in one formatted block.
      try {
        const t = strip(await rconCmd('tps'));
        let m = t.match(/now[^0-9]*([0-9]+(?:\.[0-9]+)?)/i) || t.match(/TPS[^0-9]*([0-9]+(?:\.[0-9]+)?)/i);
        state.stats.tps = m ? parseFloat(m[1]) : null;
        const ms = t.match(/MSPT[^0-9]*([0-9]+(?:\.[0-9]+)?)\s*ms/i);
        if (ms) state.stats.mspt = parseFloat(ms[1]);
        const tier = t.match(/Perf tier:\s*([A-Z]+)/i); state.stats.tier = tier ? tier[1] : null;
        const mem = t.match(/Memory[^0-9]*([0-9]+(?:\.[0-9]+)?)\s*%/i); state.stats.memPct = mem ? parseFloat(mem[1]) : null;
        alive = true;
      } catch (e) {}
      if (state.stats.mspt == null) { try { const mm = strip(await rconCmd('mspt')); const m = mm.match(/([0-9]+(?:\.[0-9]+)?)\s*ms/i); state.stats.mspt = m ? parseFloat(m[1]) : null; } catch (e) {} }
      try { const l = strip(await rconCmd('list')); const mm = l.match(/There are\s+(\d+)/i) || l.match(/(\d+)\s+of/i); state.stats.players = mm ? +mm[1] : null; } catch (e) {}
      state.stats.rssMb = readRss();
      state.stats.ts = Date.now();
      // Reflect liveness in the header; clear the stale PID/stats if the server went away.
      state.server.running = alive;
      if (!alive) { state.server.pid = null; state.stats.tps = state.stats.mspt = state.stats.players = state.stats.rssMb = null; }
    }
  } finally { rconBusy = false; }
  tailServerLog();
  broadcast();
}
setInterval(poll, 1000);

// ---- express + ws ----
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
function auth(req, res, next) {
  const t = req.get('x-token') || req.query.token;
  if (TOKEN && t !== TOKEN) return res.status(401).json({ ok: false, msg: 'bad token' });
  next();
}
const snapshot = () => ({ server: state.server, bots: state.bots, stats: state.stats, spark: state.spark });
app.get('/api/stats', (req, res) => res.json(snapshot()));
app.get('/api/log', (req, res) => res.json(state.log.slice(-100)));
app.post('/api/server/start', auth, (req, res) => res.json(startServer()));
app.post('/api/server/stop', auth, async (req, res) => res.json(await stopServer()));
app.post('/api/test/start', auth, (req, res) => {
  const b = req.body || {};
  res.json(startBots(parseInt(b.count, 10) || CFG.bots.count, parseInt(b.shards, 10) || 0, parseInt(b.stagger, 10) || 0));
});
app.post('/api/test/stop', auth, (req, res) => res.json(stopBots()));
app.post('/api/server/restart', auth, async (req, res) => {
  await stopServer();
  setTimeout(() => startServer(), 13000);
  pushLog('[server] restart requested');
  res.json({ ok: true, msg: 'restarting (~15s)' });
});
// Full RCON console — run any server command from the dashboard.
app.post('/api/rcon', auth, async (req, res) => {
  const cmd = (req.body && req.body.cmd || '').trim();
  if (!cmd) return res.json({ ok: false, msg: 'empty command' });
  if (!serverRunningPid()) return res.json({ ok: false, msg: 'server not running' });
  try { const out = strip(await rconCmd(cmd)); pushLog('[rcon] > ' + cmd); res.json({ ok: true, out: out }); }
  catch (e) { res.json({ ok: false, msg: String(e.message || e) }); }
});
// Spark profiler — issued on the server CONSOLE (via tmux) so its async result URL lands in the
// console log, which tailServerLog() scrapes; RCON would drop the delayed reply.
app.post('/api/spark/profiler', auth, (req, res) => {
  if (!serverRunningPid()) return res.json({ ok: false, msg: 'server not running' });
  const secs = Math.min(300, Math.max(10, parseInt(req.body && req.body.seconds, 10) || 30));
  state.spark.running = true; state.spark.status = 'running ' + secs + 's'; state.spark.url = null;
  const ok = sendConsole('spark profiler start --timeout ' + secs);
  if (!ok) { state.spark.running = false; state.spark.status = 'failed to start'; }
  res.json({ ok, secs });
});
app.get('/api/spark', (req, res) => res.json(state.spark));

const server = app.listen(WEB_PORT, () => console.log('sourby-st monitor on http://0.0.0.0:' + WEB_PORT + '  (stats JSON: /api/stats)'));
const wss = new WebSocketServer({ server });
function broadcast() {
  const msg = JSON.stringify(snapshot());
  wss.clients.forEach(c => { if (c.readyState === 1) try { c.send(msg); } catch (e) {} });
}
wss.on('connection', ws => { ws.send(JSON.stringify(snapshot())); });

process.on('SIGINT', () => { try { botProcs.forEach(r => r.proc && r.proc.kill()); } catch (e) {} process.exit(0); });
