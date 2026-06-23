#!/usr/bin/env bash
# Common bash functions analogous to common.ps1

set -euo pipefail

# Find repository root by searching upward for .specify directory
find_specify_root() {
    local current="${1:-$(pwd)}"
    current="$(cd "$current" 2>/dev/null && pwd)" || return 1

    while true; do
        if [ -d "$current/.specify" ]; then
            echo "$current"
            return 0
        fi
        local parent
        parent="$(dirname "$current")"
        if [ "$parent" = "$current" ]; then
            return 1
        fi
        current="$parent"
    done
}

# Get repository root, prioritizing .specify directory over git
get_repo_root() {
    local specify_root
    specify_root="$(find_specify_root 2>/dev/null)" && { echo "$specify_root"; return 0; }

    if command -v git &>/dev/null; then
        local git_root
        git_root="$(git rev-parse --show-toplevel 2>/dev/null)" && { echo "$git_root"; return 0; }
    fi

    # Fallback to script location
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    echo "$(cd "$script_dir/../../.." && pwd)"
}

# Check if git is available at the repo root
test_has_git() {
    command -v git &>/dev/null || return 1
    local repo_root
    repo_root="$(get_repo_root)"
    [ -e "$repo_root/.git" ] || return 1
    git -C "$repo_root" rev-parse --is-inside-work-tree &>/dev/null
}

# Get current branch name
get_current_branch() {
    # Check SPECIFY_FEATURE env var first
    if [ -n "${SPECIFY_FEATURE:-}" ]; then
        echo "$SPECIFY_FEATURE"
        return 0
    fi

    local repo_root
    repo_root="$(get_repo_root)"

    # Try git
    if test_has_git; then
        local branch
        branch="$(git -C "$repo_root" rev-parse --abbrev-ref HEAD 2>/dev/null)" && { echo "$branch"; return 0; }
    fi

    # For non-git repos, find latest feature directory
    local specs_dir="$repo_root/specs"
    if [ -d "$specs_dir" ]; then
        local latest_feature="" highest=0 latest_ts=""
        for dir in "$specs_dir"/*/; do
            [ -d "$dir" ] || continue
            local name
            name="$(basename "$dir")"
            if [[ "$name" =~ ^([0-9]{8}-[0-9]{6})- ]]; then
                local ts="${BASH_REMATCH[1]}"
                if [[ "$ts" > "$latest_ts" ]]; then
                    latest_ts="$ts"
                    latest_feature="$name"
                fi
            elif [[ "$name" =~ ^([0-9]{3,})- ]] && [[ ! "$name" =~ ^[0-9]{8}-[0-9]{6}- ]]; then
                local num="${BASH_REMATCH[1]}"
                num=$((10#$num))
                if [ "$num" -gt "$highest" ]; then
                    highest="$num"
                    [ -z "$latest_ts" ] && latest_feature="$name"
                fi
            fi
        done
        if [ -n "$latest_feature" ]; then
            echo "$latest_feature"
            return 0
        fi
    fi

    echo "main"
}

# Validate feature branch naming
test_feature_branch() {
    local branch="$1"
    local has_git="${2:-true}"

    if [ "$has_git" != "true" ]; then
        echo "WARNING: Git repository not detected; skipped branch validation" >&2
        return 0
    fi

    if [[ "$branch" =~ ^[0-9]{3}- ]] || [[ "$branch" =~ ^[0-9]{8}-[0-9]{6}- ]]; then
        return 0
    fi

    echo "ERROR: Not on a feature branch. Current branch: $branch"
    echo "Feature branches should be named like: 001-feature-name or 20260319-143022-feature-name"
    return 1
}

# Get feature directory path
get_feature_dir() {
    local repo_root="$1"
    local branch="$2"
    echo "$repo_root/specs/$branch"
}

# Get all feature paths as exported variables
export_feature_paths() {
    REPO_ROOT="$(get_repo_root)"
    CURRENT_BRANCH="$(get_current_branch)"
    HAS_GIT="$(test_has_git && echo true || echo false)"
    FEATURE_DIR="$(get_feature_dir "$REPO_ROOT" "$CURRENT_BRANCH")"
    FEATURE_SPEC="$FEATURE_DIR/spec.md"
    IMPL_PLAN="$FEATURE_DIR/plan.md"
    TASKS="$FEATURE_DIR/tasks.md"
    RESEARCH="$FEATURE_DIR/research.md"
    DATA_MODEL="$FEATURE_DIR/data-model.md"
    QUICKSTART="$FEATURE_DIR/quickstart.md"
    CONTRACTS_DIR="$FEATURE_DIR/contracts"
}

# Test if a file exists and print status
test_file_exists() {
    local path="$1"
    local desc="$2"
    if [ -f "$path" ]; then
        echo "  ✓ $desc"
        return 0
    else
        echo "  ✗ $desc"
        return 1
    fi
}

# Test if a directory has files
test_dir_has_files() {
    local path="$1"
    local desc="$2"
    if [ -d "$path" ] && [ -n "$(find "$path" -maxdepth 1 -type f -print -quit 2>/dev/null)" ]; then
        echo "  ✓ $desc"
        return 0
    else
        echo "  ✗ $desc"
        return 1
    fi
}

# Resolve template with priority stack
resolve_template() {
    local template_name="$1"
    local repo_root="$2"
    local base="$repo_root/.specify/templates"

    # Priority 1: Project overrides
    local override="$base/overrides/$template_name.md"
    [ -f "$override" ] && { echo "$override"; return 0; }

    # Priority 2: Installed presets
    local presets_dir="$repo_root/.specify/presets"
    if [ -d "$presets_dir" ]; then
        local registry_file="$presets_dir/.registry"
        if [ -f "$registry_file" ] && command -v jq &>/dev/null; then
            local preset_ids
            preset_ids="$(jq -r '.presets | to_entries | sort_by(.value.priority // 10) | .[].key' "$registry_file" 2>/dev/null)"
            while IFS= read -r preset_id; do
                [ -z "$preset_id" ] && continue
                local candidate="$presets_dir/$preset_id/templates/$template_name.md"
                [ -f "$candidate" ] && { echo "$candidate"; return 0; }
            done <<< "$preset_ids"
        else
            for preset_dir in "$presets_dir"/*/; do
                [ -d "$preset_dir" ] || continue
                local candidate="$preset_dir/templates/$template_name.md"
                [ -f "$candidate" ] && { echo "$candidate"; return 0; }
            done
        fi
    fi

    # Priority 3: Extensions
    local ext_dir="$repo_root/.specify/extensions"
    if [ -d "$ext_dir" ]; then
        for ext in "$ext_dir"/*/; do
            [ -d "$ext" ] || continue
            local candidate="$ext/templates/$template_name.md"
            [ -f "$candidate" ] && { echo "$candidate"; return 0; }
        done
    fi

    # Priority 4: Core templates
    local core="$base/$template_name.md"
    [ -f "$core" ] && { echo "$core"; return 0; }

    return 1
}
