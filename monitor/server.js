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

const state = {
  server: { running: false, pid: null, startedAt: null },
  bots: { running: false, pid: null, connected: 0, spawned: 0, kicked: 0, target: 0 },
  stats: { tps: null, mspt: null, players: null, rssMb: null, tier: null, memPct: null, heapGb: CFG.server.heapGb || null, ts: 0 },
  log: [],
};
// Minecraft uses § colour codes (incl. §x§f§f… hex runs), not ANSI — strip both before parsing.
const strip = s => String(s).replace(/§./g, '').replace(/\x1b\[[0-9;]*m/g, '');
function pushLog(line) { state.log.push({ t: Date.now(), line }); if (state.log.length > 200) state.log.shift(); }

// ---- child processes ----
// The SERVER runs in its own tmux session ("st-server") so it survives a monitor restart; the
// monitor attaches to it over RCON + PID discovery. The bot swarm stays a child (we parse its
// stdout for live counts, and it's fine for it to stop if the monitor stops).
let botsProc = null;
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
function startBots(count) {
  if (botsProc) return { ok: false, msg: 'test already running' };
  const args = ['swarm.js'];
  if (count) args.push('--count', String(count));
  botsProc = spawn('node', args, { cwd: ROOT });
  state.bots.running = true; state.bots.pid = botsProc.pid; state.bots.target = count || CFG.bots.count;
  botsProc.stdout.on('data', d => {
    String(d).split('\n').forEach(l => {
      const m = l.match(/connected=(\d+) spawned=(\d+) kicked=(\d+)/);
      if (m) { state.bots.connected = +m[1]; state.bots.spawned = +m[2]; state.bots.kicked = +m[3]; }
      if (l.trim()) pushLog('[bots] ' + l.trim());
    });
  });
  botsProc.on('exit', c => { pushLog('[bots] stopped (' + c + ')'); botsProc = null; state.bots.running = false; state.bots.pid = null; state.bots.connected = 0; state.bots.spawned = 0; });
  return { ok: true };
}
function stopBots() {
  if (!botsProc) return { ok: false, msg: 'no test running' };
  try { botsProc.kill('SIGTERM'); } catch (e) {}
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
  broadcast();
}
setInterval(poll, 2000);

// ---- express + ws ----
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
function auth(req, res, next) {
  const t = req.get('x-token') || req.query.token;
  if (TOKEN && t !== TOKEN) return res.status(401).json({ ok: false, msg: 'bad token' });
  next();
}
app.get('/api/stats', (req, res) => res.json({ server: state.server, bots: state.bots, stats: state.stats }));
app.get('/api/log', (req, res) => res.json(state.log.slice(-100)));
app.post('/api/server/start', auth, (req, res) => res.json(startServer()));
app.post('/api/server/stop', auth, async (req, res) => res.json(await stopServer()));
app.post('/api/test/start', auth, (req, res) => res.json(startBots(parseInt(req.body && req.body.count, 10) || CFG.bots.count)));
app.post('/api/test/stop', auth, (req, res) => res.json(stopBots()));

const server = app.listen(WEB_PORT, () => console.log('sourby-st monitor on http://0.0.0.0:' + WEB_PORT + '  (stats JSON: /api/stats)'));
const wss = new WebSocketServer({ server });
function broadcast() {
  const msg = JSON.stringify({ server: state.server, bots: state.bots, stats: state.stats });
  wss.clients.forEach(c => { if (c.readyState === 1) try { c.send(msg); } catch (e) {} });
}
wss.on('connection', ws => { ws.send(JSON.stringify({ server: state.server, bots: state.bots, stats: state.stats })); });

process.on('SIGINT', () => { try { botsProc && botsProc.kill(); } catch (e) {} process.exit(0); });
