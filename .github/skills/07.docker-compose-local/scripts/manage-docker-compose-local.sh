#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-start}"
SKIP_BUILD="${SKIP_BUILD:-false}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

log_step() {
  echo
  echo "==> $1"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

require_cmd docker

cd "$REPO_ROOT"

build_prereqs() {
  if [[ "$SKIP_BUILD" == "true" ]]; then
    return
  fi

  log_step "Build frontend (development mode)"
  npx vite build --mode development

  log_step "Build API"
  (
    cd app/backend
    npm run build
  )
}

verify_stack() {
  log_step "Container status"
  docker compose ps

  log_step "API health check"
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error http://localhost:3001/health >/dev/null
    echo "API health OK"
  else
    echo "curl not found; skipping API health check" >&2
  fi

  log_step "Database table check"
  docker compose exec db psql -U pronghorn_admin -d pronghorn -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';"
}

case "$ACTION" in
  start)
    build_prereqs
    log_step "Start Docker Compose stack"
    docker compose up --build -d
    log_step "Show stack status"
    docker compose ps
    ;;

  verify)
    verify_stack
    ;;

  logs)
    log_step "Streaming compose logs"
    docker compose logs -f
    ;;

  status)
    log_step "Container status"
    docker compose ps
    ;;

  stop)
    log_step "Stop containers (preserve data)"
    docker compose down
    ;;

  reset)
    log_step "Stop and remove volumes"
    docker compose down -v
    build_prereqs
    log_step "Recreate stack"
    docker compose up --build -d
    log_step "Show stack status"
    docker compose ps
    ;;

  *)
    echo "Unsupported action: $ACTION" >&2
    echo "Use: start | verify | logs | status | stop | reset" >&2
    exit 1
    ;;
esac
