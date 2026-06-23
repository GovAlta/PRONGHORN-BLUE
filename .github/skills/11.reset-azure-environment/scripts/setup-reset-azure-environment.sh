#!/usr/bin/env bash
# Wrapper entrypoint for Azure reset workflow.
# Example:
#   bash ./setup-reset-azure-environment.sh all --resource-group pronghorn-blue --app-display-name pronghorn-app

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANAGER_SCRIPT="$SCRIPT_DIR/manage-reset-azure-environment.sh"

if [[ ! -f "$MANAGER_SCRIPT" ]]; then
  echo "Missing script: $MANAGER_SCRIPT" >&2
  exit 1
fi

bash "$MANAGER_SCRIPT" "$@"
