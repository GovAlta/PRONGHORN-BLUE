#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
ENV_PATH="${REPO_ROOT}/.env.local"
FORCE="${FORCE:-false}"

if ! command -v az >/dev/null 2>&1; then
  echo "Azure CLI not found. Install Azure CLI and run 'az login'." >&2
  exit 1
fi

if ! TENANT_ID="$(az account show --query tenantId -o tsv 2>/dev/null)" || [[ -z "${TENANT_ID}" ]]; then
  echo "Azure authentication required. Run 'az login' and rerun this script." >&2
  exit 1
fi

APP_DISPLAY_NAME="pronghorn-app"
REDIRECT_URIS=(
  "http://localhost:8080"
  "http://localhost:8080/auth-redirect.html"
  "http://localhost:8081"
  "http://localhost:8081/auth-redirect.html"
)

APP_OBJECT_ID="$(az ad app list --display-name "${APP_DISPLAY_NAME}" --query "[0].id" -o tsv 2>/dev/null || true)"
CLIENT_ID="$(az ad app list --display-name "${APP_DISPLAY_NAME}" --query "[0].appId" -o tsv 2>/dev/null || true)"

if [[ -z "${APP_OBJECT_ID}" || -z "${CLIENT_ID}" ]]; then
  read -r APP_OBJECT_ID CLIENT_ID < <(
    az ad app create \
      --display-name "${APP_DISPLAY_NAME}" \
      --sign-in-audience AzureADMyOrg \
      --query "[id,appId]" \
      -o tsv
  )
fi

az ad app update --id "${APP_OBJECT_ID}" --web-redirect-uris "${REDIRECT_URIS[@]}" >/dev/null

if [[ ! -d "${REPO_ROOT}" ]]; then
  echo "Repository root not found: ${REPO_ROOT}" >&2
  exit 1
fi

if [[ -f "${ENV_PATH}" && "${FORCE}" != "true" ]]; then
  echo "File already exists: ${ENV_PATH}. Re-run with FORCE=true to overwrite." >&2
  exit 1
fi

cat > "${ENV_PATH}" <<'EOF'
# ──────────────────────────────────────────────
# API Backend
# ──────────────────────────────────────────────
VITE_API_BASE_URL=http://localhost:3001
VITE_USE_AZURE_API=true
VITE_APIM_SUBSCRIPTION_KEY=

# ──────────────────────────────────────────────
# Authentication Mode
# ──────────────────────────────────────────────
VITE_AUTH_MODE=msal

# ──────────────────────────────────────────────
# Azure AD / MSAL Authentication
# ──────────────────────────────────────────────
VITE_AZURE_CLIENT_ID=${CLIENT_ID}
VITE_AZURE_TENANT_ID=${TENANT_ID}
VITE_AZURE_REDIRECT_URI=http://localhost:8080

# ──────────────────────────────────────────────
# WebSocket (realtime)
# ──────────────────────────────────────────────
VITE_WS_URL=ws://localhost:3001/ws
EOF

echo "Created: ${ENV_PATH}"
echo "Configured app registration: ${APP_DISPLAY_NAME}"
echo "VITE_AZURE_CLIENT_ID=${CLIENT_ID}"
echo "VITE_AZURE_TENANT_ID=${TENANT_ID}"
