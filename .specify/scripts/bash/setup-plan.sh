#!/usr/bin/env bash
# Setup implementation plan for a feature
#
# Usage: ./setup-plan.sh [--json] [--help]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

JSON=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --json) JSON=true; shift ;;
        --help|-h)
            echo "Usage: ./setup-plan.sh [--json] [--help]"
            echo "  --json   Output results in JSON format"
            echo "  --help   Show this help message"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

export_feature_paths

if ! test_feature_branch "$CURRENT_BRANCH" "$HAS_GIT"; then
    exit 1
fi

mkdir -p "$FEATURE_DIR"

TEMPLATE="$(resolve_template 'plan-template' "$REPO_ROOT" 2>/dev/null || true)"
if [ -n "$TEMPLATE" ] && [ -f "$TEMPLATE" ]; then
    cp "$TEMPLATE" "$IMPL_PLAN"
    echo "Copied plan template to $IMPL_PLAN"
else
    echo "WARNING: Plan template not found" >&2
    touch "$IMPL_PLAN"
fi

if $JSON; then
    printf '{"FEATURE_SPEC":"%s","IMPL_PLAN":"%s","SPECS_DIR":"%s","BRANCH":"%s","HAS_GIT":%s}\n' \
        "$FEATURE_SPEC" "$IMPL_PLAN" "$FEATURE_DIR" "$CURRENT_BRANCH" "$HAS_GIT"
else
    echo "FEATURE_SPEC: $FEATURE_SPEC"
    echo "IMPL_PLAN: $IMPL_PLAN"
    echo "SPECS_DIR: $FEATURE_DIR"
    echo "BRANCH: $CURRENT_BRANCH"
    echo "HAS_GIT: $HAS_GIT"
fi
