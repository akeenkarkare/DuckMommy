#!/usr/bin/env bash
# Server auto-deploy: every minute, if origin/main has new commits, pull and restart the site
# (./stop.sh + ./dev.sh --prod). Also starts the site if it isn't running.
#   start:  setsid nohup scripts/autodeploy.sh > ~/autodeploy.log 2>&1 < /dev/null &
#   pause:  touch ~/DuckMommy/.no-autodeploy     (e.g. during judging: each deploy = ~2 min of downtime)
#   resume: rm ~/DuckMommy/.no-autodeploy
#   stop:   pkill -f scripts/autodeploy.sh
cd "$(dirname "$0")/.." || exit 1
BRANCH="${DEPLOY_BRANCH:-main}"
EVERY="${DEPLOY_EVERY_S:-60}"
SITE_LOG="${SITE_LOG:-$HOME/duck.log}"
log() { echo "$(date '+%m-%d %H:%M:%S') $*"; }

start_site() {
  ./stop.sh
  setsid nohup ./dev.sh --prod > "$SITE_LOG" 2>&1 < /dev/null &
  log "site starting (build takes ~1-2 min): $(git log -1 --format='%h %an: %s')"
}

log "watching origin/$BRANCH every ${EVERY}s"
while true; do
  if [ -e .no-autodeploy ]; then
    sleep "$EVERY"; continue
  fi
  if git fetch -q origin "$BRANCH" 2>/dev/null && [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$BRANCH")" ]; then
    if git pull -q --ff-only origin "$BRANCH"; then
      log "new commits pulled"
      start_site
    else
      log "pull failed (local changes on the server? run: git status). Not deploying."
    fi
  elif ! pgrep -f 'dev.sh --prod' >/dev/null; then
    log "site isn't running"
    start_site
  fi
  sleep "$EVERY"
done
