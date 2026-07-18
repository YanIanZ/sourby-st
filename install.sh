#!/usr/bin/env bash
# sourby-st bootstrap for a clean Debian/Ubuntu VPS.
# Installs Node.js (>=18), a JRE (for the test server), git, then `npm install`.
# Safe to re-run. Uses sudo only if not already root.
set -euo pipefail
cd "$(dirname "$0")"

SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

have() { command -v "$1" >/dev/null 2>&1; }

echo "== sourby-st bootstrap =="

if have apt-get; then
  $SUDO apt-get update -y
  have git  || $SUDO apt-get install -y git
  have curl || $SUDO apt-get install -y curl

  # Node >=18 — use NodeSource if the distro's node is old/missing.
  NODE_OK=0
  if have node; then
    MAJ=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    [ "$MAJ" -ge 18 ] && NODE_OK=1
  fi
  if [ "$NODE_OK" -ne 1 ]; then
    echo "installing Node.js 20.x (NodeSource)"
    curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
    $SUDO apt-get install -y nodejs
  fi

  # JRE for the test server (Temurin 21 preferred; fall back to distro default-jre).
  if ! have java; then
    echo "installing a JRE"
    $SUDO apt-get install -y default-jre-headless || {
      echo "default-jre unavailable; install Java 21 manually (Temurin) for the test server."; }
  fi
else
  echo "!! non-apt distro — install git, Node>=18, and a JRE yourself, then re-run." >&2
fi

echo "== versions =="
have node && node -v || echo "node: MISSING"
have npm  && npm -v  || echo "npm: MISSING"
have java && java -version 2>&1 | head -1 || echo "java: MISSING (needed only to run the test server)"

echo "== npm install =="
npm install --no-audit --no-fund

echo
echo "Done. Next:"
echo "  1) edit config.json  (jarUrl or drop server.jar here, rconPassword, web.token)"
echo "  2) bash deploy.sh"
echo "  3) node monitor/server.js   -> http://<vps-ip>:8080"
