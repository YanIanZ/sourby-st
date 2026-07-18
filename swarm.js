#!/usr/bin/env node
/*
 * sourby-st — lightweight load-test bot swarm.
 *
 * Connects N headless bots to a Minecraft server and walks each one outward so the server has to
 * generate fresh chunks continuously (the real bottleneck for exploration load). Bots use
 * minecraft-protocol DIRECTLY (no world/chunk parsing) so a single VPS can drive hundreds of them.
 *
 * FOR LOAD-TESTING A SERVER YOU OWN / ARE AUTHORISED TO TEST. See README.
 */
'use strict';

// Defaults come from config.json (so you can just `node swarm.js` with no flags); CLI flags override.
let CFG = { server: {}, bots: {} };
try { CFG = require('./config.json'); } catch (e) { /* run with flags/defaults */ }

// ---- args ----
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  const eq = process.argv.find(a => a.startsWith('--' + name + '='));
  if (eq) return eq.split('=').slice(1).join('=');
  return def;
}
const HOST = arg('host', CFG.server.host || '127.0.0.1');
const PORT = parseInt(arg('port', CFG.server.port || '25565'), 10);
const COUNT = parseInt(arg('count', CFG.bots.count || '100'), 10);
const VERSION = arg('version', CFG.server.version || '1.21.4'); // client version. Use 1.21.4: newer
// minecraft-data (1.21.5+) has a broken lpVec3 type that desyncs the play stream and drops bots.
// Via on the server bridges 1.21.4 up to any newer server protocol.
const STAGGER = parseInt(arg('stagger', CFG.bots.stagger || '80'), 10);        // ms between each bot connect (raise if server throttles)
const MOVE_MS = parseInt(arg('move-interval', CFG.bots.moveInterval || '500'), 10); // ms between movement packets (lower = faster)
const STEP = parseFloat(arg('step', CFG.bots.step || '8'));                    // blocks moved per movement packet (higher = faster)
const FLY = process.argv.includes('--fly') || String(arg('fly', CFG.bots.fly ?? '')).toLowerCase() === 'true'; // cruise airborne (needs allow-flight); covers ground faster
const CRUISE_Y = parseFloat(arg('cruise-y', CFG.bots.cruiseY || '120'));       // fly altitude
const PREFIX = arg('prefix', CFG.bots.prefix || 'ST_');                        // username prefix
const DURATION = parseInt(arg('duration', '0'), 10);       // seconds; 0 = run until Ctrl-C
const USERNAME_LIST = arg('usernames', '');                // optional comma list to use instead of PREFIX+i

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`sourby-st — load-test bot swarm

Usage: node swarm.js --host <ip> --port <port> --count <n> [options]

Options:
  --host <ip>            server address           (default 127.0.0.1)
  --port <n>             server port              (default 25565)
  --count <n>            number of bots           (default 100)
  --version <v>          client version           (default 1.21.4; avoid 1.21.5+ lpVec3 bug)
  --stagger <ms>         delay between connects    (default 80; raise if you see "Connection throttled")
  --move-interval <ms>   movement packet cadence   (default 500; lower = faster)
  --step <blocks>        blocks moved per packet   (default 8; higher = faster)
  --fly                  cruise airborne, faster   (server needs allow-flight=true)
  --cruise-y <n>         fly altitude              (default 120)
  --prefix <str>         username prefix           (default ST_)
  --usernames a,b,c      explicit username list    (overrides prefix/count)
  --duration <sec>       auto-stop after N seconds (default 0 = until Ctrl-C)

Notes:
  * Test ONLY servers you own or are authorised to test.
  * The server must be online-mode=false (offline) OR the bots need real accounts.
  * If your server runs a NEWER version than --version, install ViaVersion + ViaBackwards on it.
  * If you see "Connection throttled", raise --stagger (server's connection-throttle is per-IP).`);
  process.exit(0);
}

// Deferred so `--help` works before `npm install`.
let mc;
try { mc = require('minecraft-protocol'); }
catch (e) { console.error('Missing dependency. Run "npm install" first.'); process.exit(1); }

// ---- state ----
let connected = 0, spawned = 0, kicked = 0, errored = 0, ended = 0;
const bots = [];
const names = USERNAME_LIST
  ? USERNAME_LIST.split(',').map(s => s.trim()).filter(Boolean)
  : Array.from({ length: COUNT }, (_, i) => PREFIX + (i + 1));

function spawnBot(i) {
  const username = names[i];
  let client;
  try {
    client = mc.createClient({ host: HOST, port: PORT, username, version: VERSION, auth: 'offline', skipValidation: true, keepAlive: true });
  } catch (e) { errored++; return; }

  let x = 0, y = 70, z = 0, ready = false;
  const angle = (i % 360) * (Math.PI / 180);         // unique outward heading -> spreads chunk generation
  const dx = Math.cos(angle) * STEP, dz = Math.sin(angle) * STEP;

  client.on('login', () => { connected++; });
  client.on('position', (p) => {                      // server sets/corrects our position
    x = p.x; y = p.y; z = p.z; ready = true;
    try { client.write('teleport_confirm', { teleportId: p.teleportId }); } catch (e) {}
    if (!client._counted) { client._counted = true; spawned++; }
  });
  client.on('kick_disconnect', () => { kicked++; });
  client.on('error', () => { errored++; });
  client.on('end', () => { ended++; if (client._iv) clearInterval(client._iv); });

  client._iv = setInterval(() => {
    if (!ready) return;
    x += dx; z += dz;                                 // walk/fly outward -> forces new-chunk generation
    if (FLY && y < CRUISE_Y) y += 3;                  // climb to cruise altitude, then hold it
    // 1.21.2+ movement: MovementFlags bitfield (onGround / hasHorizontalCollision), not an onGround bool
    try { client.write('position', { x, y, z, flags: { onGround: FLY ? false : true, hasHorizontalCollision: false } }); } catch (e) {}
  }, MOVE_MS);

  bots.push(client);
}

console.log(`sourby-st: connecting ${names.length} bots to ${HOST}:${PORT} (v${VERSION}, ${STAGGER}ms stagger) ...`);
for (let i = 0; i < names.length; i++) setTimeout(() => spawnBot(i), i * STAGGER);

const statsIv = setInterval(() => {
  console.log(`[sourby-st] connected=${connected} spawned=${spawned} kicked=${kicked} err=${errored} ended=${ended}`);
}, 5000);

function shutdown() {
  clearInterval(statsIv);
  bots.forEach(b => { try { b.end(); } catch (e) {} });
  console.log('sourby-st: stopped.');
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
if (DURATION > 0) setTimeout(shutdown, DURATION * 1000);
