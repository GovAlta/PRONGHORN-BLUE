#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORCE_ARG="${1:-}"

case "$(uname -s)" in
  Linux*|Darwin*)
    if [[ "${FORCE_ARG}" == "--force" ]]; then
      FORCE=true bash "${SCRIPT_DIR}/new-api-env.sh"
    else
      bash "${SCRIPT_DIR}/new-api-env.sh"
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    if command -v pwsh >/dev/null 2>&1; then
      if [[ "${FORCE_ARG}" == "--force" ]]; then
        pwsh -File "${SCRIPT_DIR}/setup-api-env.ps1" -Force
      else
        pwsh -File "${SCRIPT_DIR}/setup-api-env.ps1"
      fi
    else
      echo "pwsh not found on Windows-like shell." >&2
      exit 1
    fi
    ;;
  *)
    echo "Unsupported OS for automated setup." >&2
    exit 1
    ;;
esac
