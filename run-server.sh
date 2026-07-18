#!/usr/bin/env bash
# Start the deployed test server with a right-sized heap (ZGC + off-heap headroom + SIMD).
# Reads config.json. Run after deploy.sh. The dashboard can also start/stop it.
set -euo pipefail
cd "$(dirname "$0")"
cfg() { node -e "const c=require('./config.json');console.log(($1)??'')"; }

SDIR=$(cfg "c.server.dir");   SDIR=${SDIR:-testserver}
JAR=$(cfg "c.server.jarFile"); JAR=${JAR:-server.jar}
HEAP=$(cfg "c.server.heapGb"); HEAP=${HEAP:-8}
SOFT=$(( HEAP * 85 / 100 ))

cd "$SDIR"
echo "starting server: -Xmx${HEAP}G (ZGC, SoftMax ${SOFT}G, +ExplicitGCInvokesConcurrent, SIMD)"
exec java --add-modules=jdk.incubator.vector \
  -Xms1G -Xmx${HEAP}G -XX:+UseZGC -XX:+ZGenerational \
  -XX:SoftMaxHeapSize=${SOFT}G -XX:ZUncommitDelay=60 \
  -XX:MaxDirectMemorySize=1G -XX:+ExplicitGCInvokesConcurrent \
  -jar "$JAR" nogui
