#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_SCRIPT="${SCRIPT_DIR}/manage-ai-models-from-local.sh"

if [[ ! -f "$TARGET_SCRIPT" ]]; then
    printf 'Missing script: %s\n' "$TARGET_SCRIPT" >&2
    exit 1
fi

bash "$TARGET_SCRIPT" "$@"
