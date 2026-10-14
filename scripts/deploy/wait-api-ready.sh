#!/bin/sh

# The container health check calls /api/health/ready, which verifies both the
# current migration sentinel and the runtime-role privilege manifest. Do not
# let an operator mistake `docker compose up` for a usable release when either
# schema or grants were skipped.
wait_api_ready() {
  api_container=$(compose ps -q api)
  [ -n "$api_container" ] || { echo 'API container was not created' >&2; return 1; }
  attempts=0
  while [ "$attempts" -lt 30 ]; do
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$api_container" 2>/dev/null || echo missing)
    [ "$health" = healthy ] && return 0
    running=$(docker inspect --format '{{.State.Running}}' "$api_container" 2>/dev/null || echo false)
    [ "$running" = true ] || break
    attempts=$((attempts + 1))
    sleep 2
  done
  echo 'API readiness failed; verify migrations and runtime database privileges before continuing' >&2
  return 1
}
