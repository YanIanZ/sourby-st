# sourby-st

Self-hosted Minecraft **load-test platform**: an auto-deployed test server, a lightweight bot
swarm that explores the world to stress chunk generation, and a **web dashboard** with live
stats + remote start/stop — all driven from one `config.json`, so you never pass `--host … --port …`
by hand.

> ⚠️ **Authorised testing only.** Point this at a server **you own or are explicitly allowed to test.**
> Do not route bots through third-party/anonymous proxies and do not aim it at anyone else's server —
> that is a denial-of-service attack, not a load test. It uses normal client connections; it does not
> spoof IPs or evade rate-limits.

---

## What's in the box

| Piece | File | Does |
|-------|------|------|
| Auto-deploy | `deploy.sh` | Builds a test server: offline-mode, RCON on, connection-throttle off, ViaVersion+ViaBackwards, big max-players, right-sized heap. Idempotent. |
| Server runner | `run-server.sh` | Boots the server with a sane ZGC flag set (SoftMax heap, off-heap headroom, SIMD). |
| Bot swarm | `swarm.js` | N headless bots (raw `minecraft-protocol`, no chunk parsing) each walking outward → continuous fresh-chunk load. Hundreds per box. |
| Web monitor | `monitor/server.js` + `monitor/public/` | Live dashboard (TPS/MSPT/players/RSS/bots), `/api/stats` JSON you can share, and token-gated Start/Stop for both server and test. |

Everything reads **`config.json`** — set it once, no CLI flags needed.

---

## Quick start (clean VPS)

```bash
git clone https://github.com/YanIanZ/sourby-st.git
cd sourby-st
bash install.sh        # installs Node + Java, npm install, seeds config.json from example
nano config.json       # set jarUrl (or drop your server.jar here), rconPassword, web.token
bash deploy.sh         # build the test server
node monitor/server.js # dashboard on http://<vps-ip>:8080
```

Open `http://<vps-ip>:8080`, paste your `web.token`, hit **Start server**, then **Start test**.
Both the dashboard and swarm read `config.json` — no `--host … --port … --count …` by hand.

### Share live stats
`http://<vps-ip>:8080/api/stats` returns JSON (TPS/MSPT/players/RSS/bots). Send that URL to anyone
(or your assistant) to watch the run remotely. It's read-only; controls stay behind `web.token`.

---

## config.json

```jsonc
{
  "server": {
    "host": "127.0.0.1",         // dashboard/swarm target (leave local for on-box tests)
    "port": 25565,
    "rconPort": 25575,
    "rconPassword": "CHANGE_ME",  // dashboard reads this to poll TPS/MSPT/list
    "jarUrl": "",                // URL to your server jar, OR drop server.jar in this folder
    "jarFile": "server.jar",
    "dir": "testserver",
    "heapGb": 8,                  // size to the box; leave headroom for the OS + bots
    "version": "1.21.4",          // client the bots speak — 1.21.4 avoids the 1.21.5+ lpVec3 bug
    "viewDistance": 8,
    "maxPlayers": 400,
    "installVia": true
  },
  "bots":  { "count": 300, "stagger": 80, "moveInterval": 700, "step": 4, "prefix": "ST_" },
  "web":   { "port": 5555, "token": "CHANGE_ME" }
}
```

> **Bot client version:** keep it at **1.21.4**. minecraft-data for 1.21.5+ has a broken `lpVec3`
> packet type that desyncs the play stream and drops bots seconds after they join. Via on the server
> bridges 1.21.4 up to any newer server protocol (e.g. 26.2), so this costs nothing.

## Spark profiler

If the server bundles [spark](https://spark.lucko.me/), the dashboard's **Profile 30s / 60s**
buttons run `spark profiler` on the server console and surface the resulting `spark.lucko.me` report
URL (auto-opened in a new tab, and listed under "recent"). Use it to see exactly where tick time goes
under load.

## Manual bot swarm (optional)

```bash
node swarm.js                              # uses config.json
node swarm.js --count 150 --stagger 120    # flags override config
node swarm.js --host YOUR.IP --count 50    # ramp: 50 → 100 → 200 → 300 to find the ceiling
node swarm.js --help
```

- If you see `Connection throttled`, raise `--stagger` (the server throttles connects per-IP; the
  auto-deploy already sets `connection-throttle: -1` on the test server).
- If bots bounce with *"Outdated client"*, the server speaks a newer protocol — `installVia:true`
  handles it (ViaVersion + ViaBackwards).
- `--duration 300` auto-stops after 5 min; otherwise `Ctrl-C` disconnects cleanly.

## How the load works

Each bot connects → confirms the spawn teleport → sends a `position` packet every `moveInterval` ms,
stepped `step` blocks along a **unique outward heading**. Many headings at once force new-chunk
generation in every direction — the same load a wave of exploring players creates. Bots never parse
chunk data, so each is just a socket plus a timer → hundreds fit on a small VPS.

## Measuring

- Dashboard shows TPS / MSPT / players / server RSS / connected bots, with a rolling TPS graph.
- Or use [spark](https://spark.lucko.me/): `/spark health`, `/spark profiler --timeout 60`.

## Notes / safety
- **Same-box testing** (server + bots + dashboard on one machine) competes for CPU/RAM. If a
  production server shares the box, size `heapGb` down and keep the bot count modest — watch the
  dashboard RSS so you don't OOM the host. For a server's true ceiling, run the swarm from a
  **separate** VPS pointed at the server's public IP.
- Test server runs **offline-mode** (`online-mode=false`) so bots join without accounts. Never expose
  it as a real server.
- MIT licensed. No warranty.
