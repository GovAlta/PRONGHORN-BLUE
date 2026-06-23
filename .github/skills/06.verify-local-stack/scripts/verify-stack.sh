#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$(uname -s)" in
  Linux*|Darwin*)
    bash "${SCRIPT_DIR}/verify-local-stack.sh"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    if command -v pwsh >/dev/null 2>&1; then
      pwsh -File "${SCRIPT_DIR}/verify-stack.ps1"
    else
      echo "pwsh not found on Windows-like shell." >&2
      exit 1
    fi
    ;;
  *)
    echo "Unsupported OS for automated verification." >&2
    exit 1
    ;;
esac
