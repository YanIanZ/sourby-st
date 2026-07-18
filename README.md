# sourby-st

Lightweight distributed **load-test bot swarm** for a Minecraft server you own — Paper / Folia /
SourbyCraft. It connects many headless bots and walks each one outward so the server generates
fresh chunks continuously, which is the real bottleneck for exploration load. Bots talk raw
[`minecraft-protocol`](https://github.com/PrismarineJS/node-minecraft-protocol) (no world/chunk
parsing), so a single small VPS can drive **hundreds** of them.

> ⚠️ **Only test servers you own or are explicitly authorised to test.** This is a load-testing tool
> for capacity planning, like SoulFire — not an attack tool. Do not point it at servers you don't
> control. It uses normal client connections; it does **not** spoof IPs, use proxies, or evade
> rate-limits.

## Why run it from a VPS (not the same box as the server)

The bots + Node.js overhead compete with the server for CPU/RAM. To measure the SERVER's true
ceiling (e.g. 300 players), run the swarm on a **separate machine** — a cheap VPS is ideal — pointed
at your server's public IP. Running both on one box just measures that box.

## Requirements

- **Node.js 18+** and **git** on the VPS.
- Your server must be **`online-mode=false`** (offline) so bots can join with any username — OR give
  the bots real accounts (not supported here; use offline for load tests).
- If your server runs a **newer** version than the bot's `--version` (e.g. SourbyCraft reports
  `26.2`), install **ViaVersion + ViaBackwards** on the server so the bots' `1.21.11` clients are
  accepted.

## Install (clean VPS)

```bash
# Debian/Ubuntu example
sudo apt update && sudo apt install -y nodejs npm git   # or use nvm for a newer Node
git clone https://github.com/YanIanZ/sourby-st.git
cd sourby-st
npm install
```

## Run

```bash
# 300 bots exploring your server
node swarm.js --host YOUR.SERVER.IP --port 25565 --count 300 --version 1.21.11
```

Ramp gradually the first time to find the ceiling:

```bash
node swarm.js --host YOUR.SERVER.IP --count 50    # then 100, 200, 300 ...
```

Stop with `Ctrl-C` (bots disconnect cleanly), or set `--duration 300` to auto-stop after 5 minutes.

### Options

| Flag | Default | Meaning |
|------|---------|---------|
| `--host <ip>` | `127.0.0.1` | server address |
| `--port <n>` | `25565` | server port |
| `--count <n>` | `100` | number of bots |
| `--version <v>` | `1.21.11` | client protocol version (server needs Via if older than server) |
| `--stagger <ms>` | `80` | delay between each connect — **raise this if you see "Connection throttled"** |
| `--move-interval <ms>` | `700` | movement-packet cadence |
| `--step <blocks>` | `4` | blocks moved outward per packet |
| `--prefix <str>` | `ST_` | bot username prefix |
| `--usernames a,b,c` | — | explicit username list (overrides prefix/count) |
| `--duration <sec>` | `0` | auto-stop after N seconds (0 = until Ctrl-C) |

`node swarm.js --help` prints the same.

## Server-side prep for a big test

- **Connection throttle:** Paper's `bukkit.yml` `settings.connection-throttle` is per-IP (default
  4000 ms). Since all bots share the VPS IP, either set it to `-1` for the test, or raise `--stagger`
  above the throttle (e.g. `--stagger 4500`).
- **`max-players`** in `server.properties` must be ≥ your bot count.
- Measure with [spark](https://spark.lucko.me/): `/spark health`, `/spark profiler --timeout 60`.
  Watch TPS, tick durations, memory, and where tick time goes.
- Give the server a right-sized heap with off-heap headroom, e.g.
  `-Xmx8G -XX:+UseZGC -XX:+ZGenerational -XX:SoftMaxHeapSize=6800M -XX:ZUncommitDelay=60 -XX:MaxDirectMemorySize=1G -XX:+ExplicitGCInvokesConcurrent` on a 12 GB box.

## How it works

Each bot: connects → confirms the server's spawn-position teleport → sends a `position` movement
packet every `--move-interval` ms with coordinates stepped `--step` blocks along a unique outward
heading. Continuous outward movement across many headings forces the server to generate new chunks
in every direction — the same load a wave of exploring players creates. Bots never parse chunk data,
so each one is just a socket plus a timer.

## License

MIT.
