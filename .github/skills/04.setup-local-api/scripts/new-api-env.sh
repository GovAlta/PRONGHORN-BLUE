#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
API_DIR="${1:-${REPO_ROOT}/app/backend}"
ENV_PATH="${API_DIR}/.env"
FORCE="${FORCE:-false}"

run_with_privilege() {
  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    "$@"
  fi
}

install_openssl_if_missing() {
  if command -v openssl >/dev/null 2>&1; then
    return 0
  fi

  echo "openssl not found. Attempting installation..."

  case "$(uname -s)" in
    Darwin*)
      if command -v brew >/dev/null 2>&1; then
        brew install openssl@3 || brew install openssl
      fi
      ;;
    Linux*)
      if command -v apt-get >/dev/null 2>&1; then
        run_with_privilege apt-get update
        run_with_privilege apt-get install -y openssl
      elif command -v dnf >/dev/null 2>&1; then
        run_with_privilege dnf install -y openssl
      elif command -v yum >/dev/null 2>&1; then
        run_with_privilege yum install -y openssl
      elif command -v zypper >/dev/null 2>&1; then
        run_with_privilege zypper --non-interactive install openssl
      elif command -v pacman >/dev/null 2>&1; then
        run_with_privilege pacman -Sy --noconfirm openssl
      elif command -v apk >/dev/null 2>&1; then
        run_with_privilege apk add --no-cache openssl
      fi
      ;;
  esac

  if command -v openssl >/dev/null 2>&1; then
    echo "openssl installed successfully."
    return 0
  fi

  echo "Warning: Unable to install openssl automatically. Falling back to other generators if available." >&2
  return 1
}

if [[ ! -d "${API_DIR}" ]]; then
  echo "API directory not found: ${API_DIR}" >&2
  exit 1
fi

if [[ -f "${ENV_PATH}" && "${FORCE}" != "true" ]]; then
  echo "File already exists: ${ENV_PATH}. Re-run with FORCE=true to overwrite." >&2
  exit 1
fi

install_openssl_if_missing || true

if command -v openssl >/dev/null 2>&1; then
  JWT_SECRET="$(openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | head -c 32)"
elif command -v python3 >/dev/null 2>&1; then
  JWT_SECRET="$(python3 - <<'PY'
import secrets, string
alphabet = string.ascii_letters + string.digits
print(''.join(secrets.choice(alphabet) for _ in range(32)))
PY
)"
elif command -v node >/dev/null 2>&1; then
  JWT_SECRET="$(node -e "const c='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';const b=require('crypto').randomBytes(64);let o='';for(const x of b){if(o.length===32)break;o+=c[x%c.length]}process.stdout.write(o)")"
else
  echo "Error: Unable to generate JWT_SECRET. Install openssl, python3, or node." >&2
  exit 1
fi

cat > "${ENV_PATH}" <<EOF
# ──────────────────────────────────────────────
# Database
# ──────────────────────────────────────────────
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DATABASE=pronghorn
POSTGRES_USER=pronghorn_admin
POSTGRES_PASSWORD=localdev123
POSTGRES_SSL=false

# ──────────────────────────────────────────────
# Server
# ──────────────────────────────────────────────
PORT=3001
NODE_ENV=development
ALLOWED_ORIGINS=http://localhost:8080,http://localhost:8081

# ──────────────────────────────────────────────
# Authentication
# ──────────────────────────────────────────────
JWT_SECRET=${JWT_SECRET}

# ──────────────────────────────────────────────
# Azure AI Foundry (required — AI features)
# ──────────────────────────────────────────────
# AI agent/chat, code generation, reasoning, and
# presentation features require these credentials.
FOUNDRY_ENDPOINT=https://ai-pronghorn-xxx.services.ai.azure.com/
FOUNDRY_API_KEY=your-foundry-api-key
APIM_OPENAI_URL=https://apim-pronghorn-xxx.azure-api.net/openai

# ──────────────────────────────────────────────
# WebSocket (realtime features)
# ──────────────────────────────────────────────
# WebSocket is built into the API server on the /ws path.
# No additional configuration needed for local development.

# ──────────────────────────────────────────────
# Azure Blob Storage (optional — file uploads)
# ──────────────────────────────────────────────
# Leave empty to disable storage. Use az login with a dev storage account for local.
AZURE_STORAGE_ACCOUNT_NAME=
EOF

echo "Created: ${ENV_PATH}"
echo "Generated JWT_SECRET (32 chars): ${JWT_SECRET}"
