#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTION="${1:-start}"
SKIP_BUILD_ARG="${2:-}"

case "$(uname -s)" in
  Linux*|Darwin*)
    if [[ "$SKIP_BUILD_ARG" == "--skip-build" ]]; then
      SKIP_BUILD=true bash "${SCRIPT_DIR}/manage-docker-compose-local.sh" "$ACTION"
    else
      bash "${SCRIPT_DIR}/manage-docker-compose-local.sh" "$ACTION"
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    if command -v pwsh >/dev/null 2>&1; then
      if [[ "$SKIP_BUILD_ARG" == "--skip-build" ]]; then
        pwsh -File "${SCRIPT_DIR}/docker-compose-local.ps1" -Action "$ACTION" -SkipBuild
      else
        pwsh -File "${SCRIPT_DIR}/docker-compose-local.ps1" -Action "$ACTION"
      fi
    else
      echo "pwsh not found on Windows-like shell." >&2
      exit 1
    fi
    ;;
  *)
    echo "Unsupported OS for docker-compose-local wrapper." >&2
    exit 1
    ;;
esac
