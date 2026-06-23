#!/usr/bin/env bash
set -euo pipefail

FRONTEND_URL="${FRONTEND_URL:-http://localhost:8080}"
API_HEALTH_URL="${API_HEALTH_URL:-http://localhost:3001/health}"
DB_CONTAINER_NAME="${DB_CONTAINER_NAME:-pronghorn-db}"

check_http() {
  local url="$1"
  local name="$2"

  if command -v curl >/dev/null 2>&1; then
    local code
    code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url" || true)"
    if [[ "$code" =~ ^2|3 ]]; then
      echo "✅ ${name} is reachable: ${url} (HTTP ${code})"
      return 0
    fi
  elif command -v wget >/dev/null 2>&1; then
    if wget -q --spider --timeout=10 "$url"; then
      echo "✅ ${name} is reachable: ${url}"
      return 0
    fi
  else
    echo "❌ Neither curl nor wget found to check ${name}" >&2
    return 1
  fi

  echo "❌ ${name} is not reachable: ${url}"
  return 1
}

check_docker_db() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "⚠️ Docker CLI not found; skipping DB container check."
    return 0
  fi

  local container_id
  container_id="$(docker ps -aq -f "name=^${DB_CONTAINER_NAME}$" 2>/dev/null || true)"
  if [[ -z "$container_id" ]]; then
    echo "⚠️ Docker container '${DB_CONTAINER_NAME}' not found; skipping DB readiness check."
    return 0
  fi

  local running
  running="$(docker inspect -f "{{.State.Running}}" "$DB_CONTAINER_NAME" 2>/dev/null || true)"
  if [[ "$running" != "true" ]]; then
    echo "❌ DB container '${DB_CONTAINER_NAME}' exists but is not running."
    return 1
  fi

  if docker exec "$DB_CONTAINER_NAME" pg_isready -U pronghorn_admin -d pronghorn >/dev/null 2>&1; then
    echo "✅ PostgreSQL container is accepting connections: ${DB_CONTAINER_NAME}"
    return 0
  fi

  echo "❌ PostgreSQL container is running but not ready: ${DB_CONTAINER_NAME}"
  return 1
}

echo "Verifying local Pronghorn stack..."

frontend_ok=0
api_ok=0
db_ok=0

check_http "$FRONTEND_URL" "Frontend" || frontend_ok=1
check_http "$API_HEALTH_URL" "API health" || api_ok=1
check_docker_db || db_ok=1

if [[ $frontend_ok -ne 0 && "$FRONTEND_URL" == "http://localhost:8080" ]]; then
  if command -v curl >/dev/null 2>&1; then
    alt_code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:8081" || true)"
    if [[ "$alt_code" =~ ^2|3 ]]; then
      echo "⚠️ Frontend appears reachable on http://localhost:8081. Port 8080 is likely occupied; free 8080 and restart frontend for redirect URI consistency."
    fi
  elif command -v wget >/dev/null 2>&1; then
    if wget -q --spider --timeout=5 "http://localhost:8081"; then
      echo "⚠️ Frontend appears reachable on http://localhost:8081. Port 8080 is likely occupied; free 8080 and restart frontend for redirect URI consistency."
    fi
  fi
fi

if [[ $frontend_ok -eq 0 && $api_ok -eq 0 && $db_ok -eq 0 ]]; then
  echo
  echo "✅ Stack verification passed."
  echo "Frontend: ${FRONTEND_URL}"
  echo "API:      ${API_HEALTH_URL}"
  echo "DB:       ${DB_CONTAINER_NAME}"
  exit 0
fi

echo
echo "❌ Stack verification failed."
echo "Next checks:"
echo "- Start frontend: npm run dev (repo root)"
echo "- Start API: cd app/backend && npm run dev (or: npm --prefix app/backend run dev)"
echo "- Start DB container: docker start pronghorn-db"
exit 1
