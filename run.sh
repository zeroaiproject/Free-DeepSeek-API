#!/usr/bin/env bash
# Restart the Free DeepSeek API server without killing unrelated processes.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="$DIR/.server.pid"
LOG="$DIR/.server.log"

# Load PORT/HOST from .env if present (server also auto-loads .env).
if [[ -f "$DIR/.env" ]]; then
  # shellcheck disable=SC2046
  export $(grep -E '^(PORT|HOST)=' "$DIR/.env" | sed 's/[[:space:]]*#.*//' | xargs) 2>/dev/null || true
fi
PORT="${PORT:-8787}"
HOST_CHECK="${HOST:-127.0.0.1}"
[[ "$HOST_CHECK" == "0.0.0.0" ]] && HOST_CHECK="127.0.0.1"

if [[ -f "$PIDFILE" ]]; then
  OLD="$(cat "$PIDFILE" || true)"
  if [[ -n "${OLD:-}" ]] && kill -0 "$OLD" 2>/dev/null; then
    kill "$OLD" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$OLD" 2>/dev/null || break
      sleep 0.1
    done
  fi
  rm -f "$PIDFILE"
fi

cd "$DIR"
nohup node server.js >>"$LOG" 2>&1 &
echo $! >"$PIDFILE"

for _ in $(seq 1 40); do
  if curl -s -m 2 "http://${HOST_CHECK}:${PORT}/health" >/dev/null 2>&1; then
    echo "server up (pid $(cat "$PIDFILE"), port ${PORT})"
    exit 0
  fi
  sleep 0.25
done

echo "server failed to start; last log lines:" >&2
tail -20 "$LOG" >&2
exit 1
