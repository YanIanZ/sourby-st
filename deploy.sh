#!/usr/bin/env bash
# sourby-st: auto-deploy a Minecraft TEST server configured for load testing.
# Reads config.json. Sets up: offline-mode, RCON (for the dashboard), connection-throttle off,
# ViaVersion+ViaBackwards (so older-version bots connect), a big max-players, and a right-sized heap.
# Idempotent — safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

cfg() { node -e "const c=require('./config.json');console.log(($1)??'')"; }

SDIR=$(cfg "c.server.dir");            SDIR=${SDIR:-testserver}
PORT=$(cfg "c.server.port");           PORT=${PORT:-25565}
RCON_PORT=$(cfg "c.server.rconPort");  RCON_PORT=${RCON_PORT:-25575}
RCON_PW=$(cfg "c.server.rconPassword")
JAR_URL=$(cfg "c.server.jarUrl")
JAR_FILE=$(cfg "c.server.jarFile");    JAR_FILE=${JAR_FILE:-server.jar}
VD=$(cfg "c.server.viewDistance");     VD=${VD:-8}
MAXP=$(cfg "c.server.maxPlayers");     MAXP=${MAXP:-400}
INSTALL_VIA=$(cfg "c.server.installVia")

echo "sourby-st deploy -> $SDIR (port $PORT, rcon $RCON_PORT, view-distance $VD, max-players $MAXP)"
mkdir -p "$SDIR/plugins"

# --- server jar ---
if [ ! -f "$SDIR/$JAR_FILE" ]; then
  if [ -n "$JAR_URL" ]; then
    echo "downloading server jar from $JAR_URL"
    curl -fsSL "$JAR_URL" -o "$SDIR/$JAR_FILE"
  elif [ -f "./$JAR_FILE" ]; then
    cp "./$JAR_FILE" "$SDIR/$JAR_FILE"
  else
    echo "ERROR: no server jar. Put your SourbyCraft/Paper jar at ./$JAR_FILE or set server.jarUrl in config.json." >&2
    exit 1
  fi
fi

# --- eula + server.properties ---
echo "eula=true" > "$SDIR/eula.txt"
cat > "$SDIR/server.properties" <<EOF
server-port=$PORT
online-mode=false
enable-rcon=true
rcon.port=$RCON_PORT
rcon.password=$RCON_PW
broadcast-rcon-to-ops=false
level-name=stressworld
view-distance=$VD
simulation-distance=$VD
spawn-protection=0
max-players=$MAXP
motd=sourby-st test server
network-compression-threshold=256
allow-flight=true
EOF

# --- bukkit.yml: disable per-IP connection throttle so a swarm from one IP can connect fast ---
if [ ! -f "$SDIR/bukkit.yml" ]; then
  cat > "$SDIR/bukkit.yml" <<'EOF'
settings:
  connection-throttle: -1
  allow-end: true
spawn-limits:
  monsters: 70
EOF
else
  # patch existing
  if grep -q "connection-throttle:" "$SDIR/bukkit.yml"; then
    sed -i.bak 's/connection-throttle: [0-9-]*/connection-throttle: -1/' "$SDIR/bukkit.yml" && rm -f "$SDIR/bukkit.yml.bak"
  fi
fi

# --- ViaVersion + ViaBackwards (so 1.21.x bots reach a newer-protocol server) ---
if [ "$INSTALL_VIA" = "true" ]; then
  for SLUG in viaversion viabackwards; do
    if ! ls "$SDIR/plugins/"*"$SLUG"*.jar >/dev/null 2>&1 && ! ls "$SDIR/plugins/"*"${SLUG/via/Via}"*.jar >/dev/null 2>&1; then
      URL=$(curl -fsSL "https://api.modrinth.com/v2/project/$SLUG/version?loaders=%5B%22paper%22%5D" 2>/dev/null \
        | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);console.log((v[0]&&v[0].files[0]&&v[0].files[0].url)||'')})")
      if [ -n "$URL" ]; then
        echo "installing $SLUG"
        curl -fsSL "$URL" -o "$SDIR/plugins/$SLUG.jar"
      fi
    fi
  done
fi

echo "deploy complete. Start it with:  bash run-server.sh   (or via the dashboard)"
