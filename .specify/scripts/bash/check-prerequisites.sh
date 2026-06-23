#!/usr/bin/env bash
# Consolidated prerequisite checking script (Bash)
#
# Usage: ./check-prerequisites.sh [OPTIONS]
#   --json            Output in JSON format
#   --require-tasks   Require tasks.md to exist
#   --include-tasks   Include tasks.md in AVAILABLE_DOCS
#   --paths-only      Only output path variables (no validation)
#   --help            Show help message

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

JSON=false
REQUIRE_TASKS=false
INCLUDE_TASKS=false
PATHS_ONLY=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --json) JSON=true; shift ;;
        --require-tasks) REQUIRE_TASKS=true; shift ;;
        --include-tasks) INCLUDE_TASKS=true; shift ;;
        --paths-only) PATHS_ONLY=true; shift ;;
        --help|-h)
            echo "Usage: check-prerequisites.sh [OPTIONS]"
            echo ""
            echo "OPTIONS:"
            echo "  --json            Output in JSON format"
            echo "  --require-tasks   Require tasks.md to exist"
            echo "  --include-tasks   Include tasks.md in AVAILABLE_DOCS"
            echo "  --paths-only      Only output path variables"
            echo "  --help            Show this help message"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

export_feature_paths

if ! test_feature_branch "$CURRENT_BRANCH" "$HAS_GIT"; then
    exit 1
fi

if $PATHS_ONLY; then
    if $JSON; then
        printf '{"REPO_ROOT":"%s","BRANCH":"%s","FEATURE_DIR":"%s","FEATURE_SPEC":"%s","IMPL_PLAN":"%s","TASKS":"%s"}\n' \
            "$REPO_ROOT" "$CURRENT_BRANCH" "$FEATURE_DIR" "$FEATURE_SPEC" "$IMPL_PLAN" "$TASKS"
    else
        echo "REPO_ROOT: $REPO_ROOT"
        echo "BRANCH: $CURRENT_BRANCH"
        echo "FEATURE_DIR: $FEATURE_DIR"
        echo "FEATURE_SPEC: $FEATURE_SPEC"
        echo "IMPL_PLAN: $IMPL_PLAN"
        echo "TASKS: $TASKS"
    fi
    exit 0
fi

if [ ! -d "$FEATURE_DIR" ]; then
    echo "ERROR: Feature directory not found: $FEATURE_DIR"
    echo "Run /speckit.specify first to create the feature structure."
    exit 1
fi

if [ ! -f "$IMPL_PLAN" ]; then
    echo "ERROR: plan.md not found in $FEATURE_DIR"
    echo "Run /speckit.plan first to create the implementation plan."
    exit 1
fi

if $REQUIRE_TASKS && [ ! -f "$TASKS" ]; then
    echo "ERROR: tasks.md not found in $FEATURE_DIR"
    echo "Run /speckit.tasks first to create the task list."
    exit 1
fi

# Build available docs list
docs=()
[ -f "$RESEARCH" ] && docs+=("research.md")
[ -f "$DATA_MODEL" ] && docs+=("data-model.md")
[ -d "$CONTRACTS_DIR" ] && [ -n "$(find "$CONTRACTS_DIR" -maxdepth 1 -type f -print -quit 2>/dev/null)" ] && docs+=("contracts/")
[ -f "$QUICKSTART" ] && docs+=("quickstart.md")
$INCLUDE_TASKS && [ -f "$TASKS" ] && docs+=("tasks.md")

if $JSON; then
    docs_json="["
    first=true
    for doc in "${docs[@]}"; do
        $first || docs_json+=","
        docs_json+="\"$doc\""
        first=false
    done
    docs_json+="]"
    printf '{"FEATURE_DIR":"%s","AVAILABLE_DOCS":%s}\n' "$FEATURE_DIR" "$docs_json"
else
    echo "FEATURE_DIR:$FEATURE_DIR"
    echo "AVAILABLE_DOCS:"
    test_file_exists "$RESEARCH" "research.md" || true
    test_file_exists "$DATA_MODEL" "data-model.md" || true
    test_dir_has_files "$CONTRACTS_DIR" "contracts/" || true
    test_file_exists "$QUICKSTART" "quickstart.md" || true
    $INCLUDE_TASKS && { test_file_exists "$TASKS" "tasks.md" || true; }
fi
