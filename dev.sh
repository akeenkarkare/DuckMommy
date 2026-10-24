#!/usr/bin/env bash
# Start the website: the relay + the dashboard together. Ctrl+C stops both.
#   ./dev.sh              relay (ws://localhost:RELAY_PORT, default 8080) + dashboard (http://localhost:3000)
#   ./dev.sh --fake-duck  same, plus the simulated duck (no Pi needed)
set -euo pipefail
cd "$(dirname "$0")"

FAKE_DUCK=0
[[ "${1:-}" == "--fake-duck" ]] && FAKE_DUCK=1

die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "Node.js isn't installed. Mac: brew install node"
major="$(node -p 'process.versions.node.split(".")[0]')"
(( major >= 20 )) || die "Node $(node -v) is too old; the relay needs 20.6+. Mac: brew upgrade node"

[[ -f backend/.env ]] || die "Missing backend/.env. Copy backend/.env.example and fill in SUPABASE_URL, SUPABASE_SECRET_KEY and DUCK_TOKEN (ask whoever set up Supabase)."
[[ -f dashboard/.env.local || -f dashboard/.env ]] || die "Missing dashboard/.env.local. Copy dashboard/.env.example and fill in the Supabase URL, publishable key and NEXT_PUBLIC_RELAY_URL=ws://localhost:8080."

RELAY_PORT="$(sed -nE 's/^RELAY_PORT=([0-9]+).*/\1/p' backend/.env | tail -1 || true)"; RELAY_PORT="${RELAY_PORT:-8080}"
for f in dashboard/.env.local dashboard/.env; do
  [[ -f "$f" ]] || continue
  url="$(sed -nE 's/^NEXT_PUBLIC_RELAY_URL=(.*)/\1/p' "$f" | tail -1)"
  if [[ -n "$url" && "$url" != *":$RELAY_PORT"* ]]; then
    die "$f has NEXT_PUBLIC_RELAY_URL=$url but the relay runs on port $RELAY_PORT (backend/.env). Make them match."
  fi
done
for port in "$RELAY_PORT" 3000; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN | tail -n +2 >&2
    die "Port $port is already in use (above). If it's an old relay/dashboard (node): kill \$(lsof -t -iTCP:$port -sTCP:LISTEN). Otherwise pick another RELAY_PORT in backend/.env (and the matching NEXT_PUBLIC_RELAY_URL)."
  fi
done

echo "Installing packages (fast if nothing changed)..."
(cd backend && npm install --no-audit --no-fund --loglevel=error)
(cd dashboard && npm install --no-audit --no-fund --loglevel=error)

cleanup() { trap - EXIT INT TERM; echo; echo "Stopping..."; kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM
(cd backend && npm run --silent dev 2>&1 | sed -u 's/^/[relay] /') &
(cd dashboard && npm run --silent dev 2>&1 | sed -u 's/^/[web]   /') &
if (( FAKE_DUCK )); then
  sleep 3
  (cd backend && npm run --silent duck 2>&1 | sed -u 's/^/[duck]  /') &
fi

sleep 4
printf '\n\033[32mOpen http://localhost:3000\033[0m  (relay on ws://localhost:%s · Ctrl+C here stops everything)\n' "$RELAY_PORT"
printf 'First time on this Supabase project? Run backend/supabase/migrations/003_coach_and_calendar.sql once in its SQL editor.\n\n'
wait
