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
const MOVE_MS = parseInt(arg('move-interval', CFG.bots.moveInterval || '700'), 10); // ms between movement packets (classic default; lower = faster)
const STEP = parseFloat(arg('step', CFG.bots.step || '4'));                    // blocks moved per movement packet (classic default; higher = faster)
const FLY = process.argv.includes('--fly') || String(arg('fly', CFG.bots.fly ?? '')).toLowerCase() === 'true'; // cruise airborne (needs allow-flight); covers ground faster
const CRUISE_Y = parseFloat(arg('cruise-y', CFG.bots.cruiseY || '120'));       // fly altitude
const WANDER = process.argv.includes('--wander') || String(arg('wander', CFG.bots.wander ?? '')).toLowerCase() === 'true';
// Irregular fly-away path (simulate a real exploring player): random initial heading + periodic
// course/altitude changes, instead of a straight fixed-angle line. Each bot wanders off in its own
// unpredictable direction, so chunk generation spreads naturally like real players scattering.
const SPECTATOR = process.argv.includes('--spectator') || String(arg('spectator', CFG.bots.spectator ?? '')).toLowerCase() === 'true';
// Spectator bots (server default gamemode spectator): fly freely, no collision, no fly-grant needed.
// Skip the survival fly handshake and move immediately, gently, so nothing trips "moved too quickly".
const SPREAD = parseInt(arg('spread', CFG.bots.spread || '0'), 10);            // blocks between bots' home
// positions (0 = all at spawn). CRITICAL for a real Folia test: Folia ticks per-REGION on separate
// threads, so 150+ players only scale when spread across the map (different regions). Clustered at
// spawn they share one region = one thread = collapse (Folia's worst case, not a server fault).
const PREFIX = arg('prefix', CFG.bots.prefix || 'ST_');                        // username prefix
const DURATION = parseInt(arg('duration', '0'), 10);       // seconds; 0 = run until Ctrl-C
const USERNAME_LIST = arg('usernames', '');                // optional comma list to use instead of PREFIX+i
const RECONNECT = !process.argv.includes('--no-reconnect'); // sustained-test self-heal: respawn a bot
// whenever its connection ends. This makes the swarm population RECOVER on its own — connect-burst
// timeouts and slow long-run drops keep retrying (with backoff+jitter) until they seat, so an
// unattended multi-hour run holds a stable population instead of decaying. Disable with --no-reconnect.
const RECONNECT_MS = parseInt(arg('reconnect-ms', CFG.bots.reconnectMs || '8000'), 10);

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
  --spread <blocks>      space bots this far apart (0=all at spawn; use >1000 for a real Folia
                         test so bots land in separate regions = separate threads)
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
let shuttingDown = false;      // set on SIGINT/SIGTERM so reconnect stops and the process can exit
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
  // WANDER: random initial heading (irregular). Otherwise: unique per-index outward angle (orderly spread).
  let angle = WANDER ? Math.random() * Math.PI * 2 : (i % 360) * (Math.PI / 180);
  let dx = Math.cos(angle) * STEP, dz = Math.sin(angle) * STEP;
  // Home position: when SPREAD>0, place each bot on a grid SPREAD blocks apart (centred on spawn) so
  // every bot lands in its own Folia region -> ticked on a separate thread -> real parallelism.
  const cols = SPREAD > 0 ? Math.max(1, Math.ceil(Math.sqrt(names.length))) : 1;
  const homeX = SPREAD > 0 ? ((i % cols) - cols / 2) * SPREAD : null;
  const homeZ = SPREAD > 0 ? (Math.floor(i / cols) - cols / 2) * SPREAD : null;

  client.on('login', () => { connected++; });
  // CRITICAL for movement: after each chunk batch the server waits for our ack before sending more.
  // Without it the server stops streaming chunks and won't let the player advance past the initially-
  // loaded area (the bot moves a few blocks then freezes). Ack with a high chunks/tick so it keeps up.
  client.on('chunk_batch_finished', () => {
    try { client.write('chunk_batch_received', { chunksPerTick: 40.0 }); } catch (e) {}
  });
  client.on('position', (p) => {
    // ALWAYS adopt the server's authoritative position. This is the critical fix: if the client keeps
    // an absolute position that runs away from the server's (e.g. it rejected a move), every later
    // packet reports a huge delta -> "moved too quickly" -> permanent rejection. Adopting the
    // corrected position on each server packet keeps every subsequent move a small, legal delta.
    x = p.x; y = p.y; z = p.z; ready = true;
    try { client.write('teleport_confirm', { teleportId: p.teleportId }); } catch (e) {}
    // Signal "world loaded" (1.21.2+) so the server starts ticking/streaming for us.
    if (!client._loaded) { client._loaded = true; try { client.write('player_loaded', {}); } catch (e) {} }
    if (!client._counted) {
      client._counted = true; spawned++;
      // Spectator: no grant needed, fly freely immediately. Survival fly: request the grant (/cmi fly).
      if (SPECTATOR) { client._flyReady = true; }
      else if (FLY) { try { client.chat('/cmi fly'); } catch (e) {} }
    }
  });
  // Clientbound abilities: once the server grants may-fly (bit 0x04), tell it we ARE flying (serverbound
  // flags 0x02) and unlock movement. Until then we stay put so the server never sees an illegal airborne move.
  client.on('abilities', (p) => {
    if (FLY && (p.flags & 0x04) && !client._flyReady) {
      client._flyReady = true;
      try { client.write('abilities', { flags: 0x02 }); } catch (e) {}
    }
  });
  client.on('kick_disconnect', () => { kicked++; });
  client.on('error', () => { errored++; });
  client.on('end', () => {
    ended++;
    if (client._iv) clearInterval(client._iv);
    // Self-heal: respawn this slot after a backoff (+jitter so a mass-drop doesn't reconnect in lockstep).
    if (RECONNECT && !shuttingDown) {
      setTimeout(() => { if (!shuttingDown) spawnBot(i); }, RECONNECT_MS + Math.floor(Math.random() * 4000));
    }
  });

  client._iv = setInterval(() => {
    if (!ready) return;
    if (FLY && !client._flyReady) return;             // wait until the server granted + we enabled fly
    if (FLY && y < CRUISE_Y - 1) {
      // ASCEND phase: climb GENTLY (small per-packet delta) so the server never flags "moved too
      // quickly" on a big vertical jump — that single mistake blocks all further movement.
      y += 1.5;
      try { client.write('position', { x, y, z, flags: { onGround: false, hasHorizontalCollision: false } }); } catch (e) {}
      return;
    }
    // CRUISE phase: wander horizontally at altitude (open air, no collision).
    if (WANDER && Math.random() < 0.25) {             // ~1-in-4 ticks: change course -> irregular path
      angle += (Math.random() - 0.5) * 1.4;           // turn up to ~40deg either way
      dx = Math.cos(angle) * STEP; dz = Math.sin(angle) * STEP;
    }
    x += dx; z += dz;                                 // fly outward -> forces new-chunk generation
    if (FLY && WANDER) {
      y += (Math.random() - 0.5) * 1.5;               // gentle irregular altitude drift
      y = Math.max(CRUISE_Y - 8, Math.min(CRUISE_Y + 8, y)); // stay in a high band, well above terrain
    }
    // 1.21.2+ movement: MovementFlags bitfield (onGround / hasHorizontalCollision), not an onGround bool
    try { client.write('position', { x, y, z, flags: { onGround: FLY ? false : true, hasHorizontalCollision: false } }); } catch (e) {}
  }, MOVE_MS);

  bots[i] = client;   // index by slot so a reconnect replaces the dead client instead of leaking it
}

console.log(`sourby-st: connecting ${names.length} bots to ${HOST}:${PORT} (v${VERSION}, ${STAGGER}ms stagger) ...`);
for (let i = 0; i < names.length; i++) setTimeout(() => spawnBot(i), i * STAGGER);

const statsIv = setInterval(() => {
  console.log(`[sourby-st] connected=${connected} spawned=${spawned} kicked=${kicked} err=${errored} ended=${ended}`);
}, 5000);

function shutdown() {
  shuttingDown = true;   // stop all reconnect timers from respawning after we start tearing down
  clearInterval(statsIv);
  bots.forEach(b => { try { b.end(); } catch (e) {} });
  console.log('sourby-st: stopped.');
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
if (DURATION > 0) setTimeout(shutdown, DURATION * 1000);
