#!/usr/bin/env bash

set -euo pipefail

# Stops/removes frontend(nginx), api, and db(postgresql) containers,
# then lists containers for verification.
# Example:
#   bash ./manage-reset-docker-environment.sh all

ACTION="all"
REPO_ROOT=""

log_info() {
  local message="$1"
  echo "[INFO] ${message}"
}

log_ok() {
  local message="$1"
  echo "[OK] ${message}"
}

show_usage() {
  cat <<EOF
Usage:
  manage-reset-docker-environment.sh [action] [options]

Actions:
  reset-containers
  list-containers
  all

Options:
  --repo-root <path>    Repository root (default: auto-resolve)
  --help                Show this help
EOF
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker CLI not found. Install Docker Desktop/Engine and retry." >&2
    exit 1
  fi
}

resolve_repo_root() {
  if [[ -n "$REPO_ROOT" ]]; then
    (cd "$REPO_ROOT" && pwd)
    return
  fi

  (cd "${SCRIPT_DIR}/../../../.." && pwd)
}

reset_compose_services() {
  local root_path="$1"

  if [[ ! -f "$root_path/docker-compose.yml" ]]; then
    echo "docker-compose.yml not found at: $root_path/docker-compose.yml" >&2
    exit 1
  fi

  pushd "$root_path" >/dev/null
  docker compose stop frontend api db || true
  docker compose rm -f -s -v frontend api db || true
  popd >/dev/null
}

remove_direct_fallback() {
  local tokens=(frontend nginx api db postgres postgresql)

  for token in "${tokens[@]}"; do
    local container_ids
    container_ids="$(docker ps -a --filter "name=${token}" --format '{{.ID}}' || true)"

    while IFS= read -r container_id; do
      [[ -z "$container_id" ]] && continue
      docker rm -f "$container_id" >/dev/null 2>&1 || true
    done <<<"$container_ids"
  done
}

list_containers() {
  log_info "Container list (docker container ls -a):"
  docker container ls -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -gt 0 ]]; then
  case "$1" in
    reset-containers|list-containers|all)
      ACTION="$1"
      shift
      ;;
    --help|-h)
      show_usage
      exit 0
      ;;
  esac
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      REPO_ROOT="$2"
      shift 2
      ;;
    --help|-h)
      show_usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      show_usage
      exit 1
      ;;
  esac
done

require_docker
RESOLVED_REPO_ROOT="$(resolve_repo_root)"

case "$ACTION" in
  reset-containers)
    log_info "Stopping/removing frontend(nginx), api, and db(postgresql) containers..."
    reset_compose_services "$RESOLVED_REPO_ROOT"
    remove_direct_fallback
    ;;
  list-containers)
    list_containers
    ;;
  all)
    log_info "Stopping/removing frontend(nginx), api, and db(postgresql) containers..."
    reset_compose_services "$RESOLVED_REPO_ROOT"
    remove_direct_fallback

    list_containers
    ;;
  *)
    echo "Unsupported action: ${ACTION}" >&2
    exit 1
    ;;
esac

log_ok "Docker environment reset workflow completed."
