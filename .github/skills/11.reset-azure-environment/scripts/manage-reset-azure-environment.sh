#!/usr/bin/env bash

set -euo pipefail

# Automates reset actions for pronghorn-app and pronghorn-blue and marks env values.
# Example:
#   bash ./manage-reset-azure-environment.sh all --resource-group pronghorn-blue --app-display-name pronghorn-app

ACTION="all"
RESOURCE_GROUP_NAME="pronghorn-blue"
APP_DISPLAY_NAME="pronghorn-app"
REPO_ROOT=""

log_info() {
  local message="$1"
  echo "[INFO] ${message}"
}

log_ok() {
  local message="$1"
  echo "[OK] ${message}"
}

show_usage() {
  cat <<EOF
Usage:
  manage-reset-azure-environment.sh [action] [options]

Actions:
  remove-app-registration
  remove-resource-group
  update-env-files
  all

Options:
  --resource-group <name>      Resource group name (default: pronghorn-blue)
  --app-display-name <name>    App display name (default: pronghorn-app)
  --repo-root <path>           Repo root path (default: auto-resolve)
  --help                       Show this help
EOF
}

require_azure_login() {
  if ! command -v az >/dev/null 2>&1; then
    echo "Azure CLI not found. Install from https://learn.microsoft.com/cli/azure/install-azure-cli" >&2
    exit 1
  fi

  if ! az account show --query id -o tsv >/dev/null 2>&1; then
    echo "Azure CLI is not authenticated. Run 'az login' and retry." >&2
    exit 1
  fi
}

resolve_repo_root() {
  if [[ -n "$REPO_ROOT" ]]; then
    (cd "$REPO_ROOT" && pwd)
    return
  fi

  (cd "${SCRIPT_DIR}/../../../.." && pwd)
}

remove_app_registration() {
  local display_name="$1"

  require_azure_login

  local app_ids
  app_ids="$(az ad app list --display-name "$display_name" --query "[].appId" -o tsv || true)"

  if [[ -z "${app_ids}" ]]; then
    log_info "No app registration found for display name '${display_name}'."
    return
  fi

  while IFS= read -r app_id; do
    [[ -z "$app_id" ]] && continue
    az ad app delete --id "$app_id"
    log_ok "Deleted app registration: ${app_id}"
  done <<<"$app_ids"
}

remove_resource_group() {
  local resource_group_name="$1"

  require_azure_login

  local exists
  exists="$(az group exists --name "$resource_group_name")"
  if [[ "$exists" != "true" ]]; then
    log_info "Resource group '${resource_group_name}' was not found."
    return
  fi

  az group delete --name "$resource_group_name" --yes --no-wait
  log_ok "Deletion requested for resource group: ${resource_group_name}"
}

is_actual_value() {
  local value="$1"

  [[ -z "${value// }" ]] && return 1
  [[ "$value" == *"(reset/removed)" ]] && return 1

  if [[ "$value" =~ ^(your-|<|\$\{|\{\{|REPLACE_ME) ]]; then
    return 1
  fi

  return 0
}

update_env_file() {
  local env_file="$1"

  local tmp_file
  tmp_file="$(mktemp)"

  local has_updates="false"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ -z "${line// }" || "$line" == \#* || "$line" != *"="* ]]; then
      printf '%s\n' "$line" >>"$tmp_file"
      continue
    fi

    local key="${line%%=*}"
    local value="${line#*=}"

    case "$key" in
      FOUNDRY_ENDPOINT|FOUNDRY_API_KEY|APIM_OPENAI_URL|AZURE_TENANT_ID|AZURE_CLIENT_ID|AZURE_OAUTH_CLIENT_ID|VITE_AZURE_CLIENT_ID|VITE_AZURE_TENANT_ID|VITE_AZURE_REDIRECT_URI|VITE_API_BASE_URL|API_BASE_URL|FRONTEND_URL)
        if is_actual_value "$value"; then
          printf '%s=%s(reset/removed)\n' "$key" "$value" >>"$tmp_file"
          has_updates="true"
        else
          printf '%s\n' "$line" >>"$tmp_file"
        fi
        ;;
      *)
        printf '%s\n' "$line" >>"$tmp_file"
        ;;
    esac
  done <"$env_file"

  if [[ "$has_updates" == "true" ]]; then
    mv "$tmp_file" "$env_file"
    log_ok "Updated env values in: $env_file"
  else
    rm -f "$tmp_file"
  fi
}

update_env_files() {
  local root_path="$1"
  local env_files=(
    "$root_path/.env"
    "$root_path/.env.local"
    "$root_path/.env.development"
    "$root_path/.env.production"
    "$root_path/.env.test"
    "$root_path/app/backend/.env"
    "$root_path/app/backend/.env.local"
    "$root_path/app/backend/.env.development"
    "$root_path/app/backend/.env.production"
    "$root_path/app/backend/.env.test"
  )

  local found_any="false"
  for env_file in "${env_files[@]}"; do
    if [[ -f "$env_file" ]]; then
      found_any="true"
      update_env_file "$env_file"
    fi
  done

  if [[ "$found_any" == "false" ]]; then
    log_info "No .env* files found to update."
  fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -gt 0 ]]; then
  case "$1" in
    remove-app-registration|remove-resource-group|update-env-files|all)
      ACTION="$1"
      shift
      ;;
    --help|-h)
      show_usage
      exit 0
      ;;
  esac
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resource-group)
      RESOURCE_GROUP_NAME="$2"
      shift 2
      ;;
    --app-display-name)
      APP_DISPLAY_NAME="$2"
      shift 2
      ;;
    --repo-root)
      REPO_ROOT="$2"
      shift 2
      ;;
    --help|-h)
      show_usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      show_usage
      exit 1
      ;;
  esac
done

RESOLVED_REPO_ROOT="$(resolve_repo_root)"

case "$ACTION" in
  remove-app-registration)
    log_info "Removing app registration '${APP_DISPLAY_NAME}'..."
    remove_app_registration "$APP_DISPLAY_NAME"
    ;;
  remove-resource-group)
    log_info "Removing resource group '${RESOURCE_GROUP_NAME}'..."
    remove_resource_group "$RESOURCE_GROUP_NAME"
    ;;
  update-env-files)
    log_info "Updating relevant .env* files with reset marker..."
    update_env_files "$RESOLVED_REPO_ROOT"
    ;;
  all)
    log_info "Removing app registration '${APP_DISPLAY_NAME}'..."
    remove_app_registration "$APP_DISPLAY_NAME"

    log_info "Removing resource group '${RESOURCE_GROUP_NAME}'..."
    remove_resource_group "$RESOURCE_GROUP_NAME"

    log_info "Updating relevant .env* files with reset marker..."
    update_env_files "$RESOLVED_REPO_ROOT"
    ;;
  *)
    echo "Unsupported action: ${ACTION}" >&2
    exit 1
    ;;
esac

log_ok "Azure environment reset workflow completed."
