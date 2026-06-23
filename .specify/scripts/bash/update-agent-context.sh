#!/usr/bin/env bash
# Update agent context files with information from plan.md
#
# Usage: ./update-agent-context.sh [agent-type]
#   agent-type: Optional. One of: claude, gemini, copilot, cursor-agent, etc.
#               If omitted, updates all existing agent files.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

AGENT_TYPE="${1:-}"

export_feature_paths

# Agent file paths
CLAUDE_FILE="$REPO_ROOT/CLAUDE.md"
GEMINI_FILE="$REPO_ROOT/GEMINI.md"
COPILOT_FILE="$REPO_ROOT/.github/agents/copilot-instructions.md"
TEMPLATE_FILE="$REPO_ROOT/.specify/templates/agent-file-template.md"

# Extract tech stack from plan.md
extract_plan_data() {
    local plan_file="$1"
    if [ ! -f "$plan_file" ]; then
        echo "WARNING: plan.md not found at $plan_file" >&2
        return
    fi

    # Extract tech context section
    NEW_LANG="$(grep -i 'language\|runtime' "$plan_file" 2>/dev/null | head -3 || true)"
    NEW_FRAMEWORK="$(grep -i 'framework\|library' "$plan_file" 2>/dev/null | head -3 || true)"
}

# Generate content block for agent file
generate_content() {
    local date_str
    date_str="$(date '+%Y-%m-%d')"
    cat <<EOF
# $(basename "$REPO_ROOT") Development Guidelines

Auto-generated from all feature plans. Last updated: $date_str

## Active Technologies

- Extracted from plan.md (see specs/$CURRENT_BRANCH/plan.md for details)

## Project Structure

\`\`\`text
src/                    # React frontend
api/src/                # Express API
infra/                  # Terraform modules
.github/workflows/      # GitHub Actions
\`\`\`

## Recent Changes

- $CURRENT_BRANCH: Updated from plan.md

<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->
EOF
}

# Update or create an agent file
update_agent_file() {
    local target_file="$1"
    local dir
    dir="$(dirname "$target_file")"
    mkdir -p "$dir"

    if [ -f "$target_file" ]; then
        # Preserve manual additions
        local manual_start manual_end
        manual_start="$(grep -n '<!-- MANUAL ADDITIONS START -->' "$target_file" 2>/dev/null | head -1 | cut -d: -f1 || true)"
        manual_end="$(grep -n '<!-- MANUAL ADDITIONS END -->' "$target_file" 2>/dev/null | head -1 | cut -d: -f1 || true)"

        if [ -n "$manual_start" ] && [ -n "$manual_end" ]; then
            local manual_content
            manual_content="$(sed -n "${manual_start},${manual_end}p" "$target_file")"
            generate_content > "$target_file"
            # Replace the manual additions block with preserved content
            local new_start
            new_start="$(grep -n '<!-- MANUAL ADDITIONS START -->' "$target_file" | head -1 | cut -d: -f1)"
            local new_end
            new_end="$(grep -n '<!-- MANUAL ADDITIONS END -->' "$target_file" | head -1 | cut -d: -f1)"
            if [ -n "$new_start" ] && [ -n "$new_end" ]; then
                local tmp_file
                tmp_file="$(mktemp)"
                head -n "$((new_start - 1))" "$target_file" > "$tmp_file"
                echo "$manual_content" >> "$tmp_file"
                tail -n "+$((new_end + 1))" "$target_file" >> "$tmp_file"
                mv "$tmp_file" "$target_file"
            fi
        else
            generate_content > "$target_file"
        fi
    else
        generate_content > "$target_file"
    fi

    echo "✓ Updated: $target_file"
}

# Main logic
extract_plan_data "$IMPL_PLAN"

if [ -n "$AGENT_TYPE" ]; then
    case "$AGENT_TYPE" in
        claude) update_agent_file "$CLAUDE_FILE" ;;
        gemini) update_agent_file "$GEMINI_FILE" ;;
        copilot) update_agent_file "$COPILOT_FILE" ;;
        *) echo "Agent type '$AGENT_TYPE' — using AGENTS.md"; update_agent_file "$REPO_ROOT/AGENTS.md" ;;
    esac
else
    # Update all existing agent files
    for file in "$CLAUDE_FILE" "$GEMINI_FILE" "$COPILOT_FILE" "$REPO_ROOT/AGENTS.md"; do
        if [ -f "$file" ]; then
            update_agent_file "$file"
        fi
    done
    # If no agent files exist, create Claude as default
    local found=false
    for file in "$CLAUDE_FILE" "$GEMINI_FILE" "$COPILOT_FILE" "$REPO_ROOT/AGENTS.md"; do
        [ -f "$file" ] && { found=true; break; }
    done
    if [ "$found" = "false" ]; then
        update_agent_file "$CLAUDE_FILE"
    fi
fi
