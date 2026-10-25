#!/usr/bin/env bash
# Stop the relay + dashboard, however they were started (dev.sh, a leftover next-server, ...).
# Only touches whatever listens on RELAY_PORT (default 8080) and 3000. ./stop.sh && ./dev.sh --prod
cd "$(dirname "$0")"
RELAY_PORT="$(sed -nE 's/^RELAY_PORT=([0-9]+).*/\1/p' backend/.env 2>/dev/null | tail -1)"; RELAY_PORT="${RELAY_PORT:-8080}"
pids() { { ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2; lsof -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null; } | sort -u; }
for port in "$RELAY_PORT" 3000; do
  p="$(pids "$port")"; [ -n "$p" ] && kill $p 2>/dev/null
done
sleep 2
for port in "$RELAY_PORT" 3000; do
  p="$(pids "$port")"; [ -n "$p" ] && echo "port $port still held by $p: kill -9" && kill -9 $p 2>/dev/null
done
sleep 1
for port in "$RELAY_PORT" 3000; do
  [ -n "$(pids "$port")" ] && { echo "port $port is STILL in use"; exit 1; }
done
echo "stopped (ports $RELAY_PORT and 3000 are free)"
