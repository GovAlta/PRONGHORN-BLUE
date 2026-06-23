#!/usr/bin/env bash
# Create a new feature branch and spec structure
#
# Usage: ./create-new-feature.sh [OPTIONS] <feature description>
#   --json              Output in JSON format
#   --short-name NAME   Custom short name for branch
#   --number N          Specify branch number manually
#   --timestamp         Use timestamp prefix instead of sequential
#   --help              Show help message

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

JSON=false
SHORT_NAME=""
NUMBER=0
TIMESTAMP=false
FEATURE_DESC=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --json) JSON=true; shift ;;
        --short-name) SHORT_NAME="$2"; shift 2 ;;
        --number) NUMBER="$2"; shift 2 ;;
        --timestamp) TIMESTAMP=true; shift ;;
        --help|-h)
            echo "Usage: ./create-new-feature.sh [OPTIONS] <feature description>"
            echo "  --json              Output in JSON format"
            echo "  --short-name NAME   Custom short name for branch"
            echo "  --number N          Specify branch number manually"
            echo "  --timestamp         Use timestamp prefix"
            echo "  --help              Show this help message"
            exit 0
            ;;
        *) FEATURE_DESC="${FEATURE_DESC:+$FEATURE_DESC }$1"; shift ;;
    esac
done

FEATURE_DESC="$(echo "$FEATURE_DESC" | xargs)"

if [ -z "$FEATURE_DESC" ]; then
    echo "Error: Feature description required" >&2
    exit 1
fi

clean_branch_name() {
    echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/-\{2,\}/-/g; s/^-//; s/-$//'
}

get_branch_name() {
    local desc="$1"
    local stop_words="i a an the to for of in on at by with from is are was were be been being have has had do does did will would should could can may might must shall this that these those my your our their want need add get set"
    local clean_name
    clean_name="$(echo "$desc" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9 ]/ /g')"
    local words=()
    for word in $clean_name; do
        local is_stop=false
        for sw in $stop_words; do
            [ "$word" = "$sw" ] && { is_stop=true; break; }
        done
        $is_stop && continue
        [ ${#word} -ge 3 ] && words+=("$word")
    done
    local max_words=3
    [ ${#words[@]} -eq 4 ] && max_words=4
    local result=""
    local count=0
    for word in "${words[@]}"; do
        [ $count -ge $max_words ] && break
        result="${result:+$result-}$word"
        ((count++))
    done
    echo "${result:-$(clean_branch_name "$desc" | cut -d- -f1-3)}"
}

get_highest_from_specs() {
    local specs_dir="$1"
    local highest=0
    [ -d "$specs_dir" ] || { echo 0; return; }
    for dir in "$specs_dir"/*/; do
        [ -d "$dir" ] || continue
        local name
        name="$(basename "$dir")"
        if [[ "$name" =~ ^([0-9]{3,})- ]] && [[ ! "$name" =~ ^[0-9]{8}-[0-9]{6}- ]]; then
            local num=$((10#${BASH_REMATCH[1]}))
            [ "$num" -gt "$highest" ] && highest=$num
        fi
    done
    echo "$highest"
}

get_highest_from_branches() {
    local highest=0
    if command -v git &>/dev/null; then
        while IFS= read -r branch; do
            branch="$(echo "$branch" | sed 's/^[* ]*//' | sed 's|^remotes/[^/]*/||')"
            if [[ "$branch" =~ ^([0-9]{3,})- ]] && [[ ! "$branch" =~ ^[0-9]{8}-[0-9]{6}- ]]; then
                local num=$((10#${BASH_REMATCH[1]}))
                [ "$num" -gt "$highest" ] && highest=$num
            fi
        done < <(git branch -a 2>/dev/null || true)
    fi
    echo "$highest"
}

REPO_ROOT="$(get_repo_root)"
HAS_GIT="$(test_has_git && echo true || echo false)"
cd "$REPO_ROOT"

SPECS_DIR="$REPO_ROOT/specs"
mkdir -p "$SPECS_DIR"

if [ -n "$SHORT_NAME" ]; then
    BRANCH_SUFFIX="$(clean_branch_name "$SHORT_NAME")"
else
    BRANCH_SUFFIX="$(get_branch_name "$FEATURE_DESC")"
fi

if $TIMESTAMP; then
    FEATURE_NUM="$(date '+%Y%m%d-%H%M%S')"
    BRANCH_NAME="$FEATURE_NUM-$BRANCH_SUFFIX"
else
    if [ "$NUMBER" -eq 0 ]; then
        if [ "$HAS_GIT" = "true" ]; then
            git fetch --all --prune 2>/dev/null || true
            HIGHEST_BRANCH="$(get_highest_from_branches)"
            HIGHEST_SPEC="$(get_highest_from_specs "$SPECS_DIR")"
            MAX=$(( HIGHEST_BRANCH > HIGHEST_SPEC ? HIGHEST_BRANCH : HIGHEST_SPEC ))
            NUMBER=$(( MAX + 1 ))
        else
            NUMBER=$(( $(get_highest_from_specs "$SPECS_DIR") + 1 ))
        fi
    fi
    FEATURE_NUM="$(printf '%03d' "$NUMBER")"
    BRANCH_NAME="$FEATURE_NUM-$BRANCH_SUFFIX"
fi

if [ "$HAS_GIT" = "true" ]; then
    if ! git checkout -q -b "$BRANCH_NAME" 2>/dev/null; then
        echo "Error: Failed to create branch '$BRANCH_NAME'" >&2
        exit 1
    fi
else
    echo "WARNING: Git not detected; skipped branch creation for $BRANCH_NAME" >&2
fi

FEATURE_DIR="$SPECS_DIR/$BRANCH_NAME"
mkdir -p "$FEATURE_DIR"

TEMPLATE="$(resolve_template 'spec-template' "$REPO_ROOT" 2>/dev/null || true)"
SPEC_FILE="$FEATURE_DIR/spec.md"
if [ -n "$TEMPLATE" ] && [ -f "$TEMPLATE" ]; then
    cp "$TEMPLATE" "$SPEC_FILE"
else
    touch "$SPEC_FILE"
fi

export SPECIFY_FEATURE="$BRANCH_NAME"

if $JSON; then
    printf '{"BRANCH_NAME":"%s","SPEC_FILE":"%s","FEATURE_NUM":"%s","HAS_GIT":%s}\n' \
        "$BRANCH_NAME" "$SPEC_FILE" "$FEATURE_NUM" "$HAS_GIT"
else
    echo "BRANCH_NAME: $BRANCH_NAME"
    echo "SPEC_FILE: $SPEC_FILE"
    echo "FEATURE_NUM: $FEATURE_NUM"
    echo "HAS_GIT: $HAS_GIT"
    echo "SPECIFY_FEATURE environment variable set to: $BRANCH_NAME"
fi
