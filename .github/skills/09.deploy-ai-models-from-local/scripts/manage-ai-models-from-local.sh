#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

ACTION="all"
SUBSCRIPTION_ID=""
RESOURCE_GROUP_NAME=""
AI_SERVICES_NAME=""
TFVARS_PATH="infra/params/dev.tfvars"
AUTO_APPROVE="false"
FOUNDRY_ENDPOINT=""
FOUNDRY_API_KEY=""
APIM_OPENAI_URL=""

print_info() {
    printf '[INFO] %s\n' "$1"
}

print_ok() {
    printf '[OK] %s\n' "$1"
}

print_warn() {
    printf '[WARN] %s\n' "$1"
}

require_command() {
    local command_name="$1"
    if ! command -v "$command_name" >/dev/null 2>&1; then
        printf 'Required command not found: %s\n' "$command_name" >&2
        exit 1
    fi
}

set_or_replace_env() {
    local env_file="$1"
    local key="$2"
    local value="$3"

    if [[ -z "$value" ]]; then
        return 0
    fi

    if grep -qE "^${key}=" "$env_file" 2>/dev/null; then
        sed -i.bak "s|^${key}=.*|${key}=${value}|" "$env_file"
    else
        printf '%s=%s\n' "$key" "$value" >> "$env_file"
    fi
}

show_models() {
    local models_path="${REPO_ROOT}/infra/config/ai-models.json"
    if [[ ! -f "$models_path" ]]; then
        printf 'Model config not found: %s\n' "$models_path" >&2
        exit 1
    fi

    require_command jq

    printf '\n'
    jq -r '.defaultModels[] | [.name, .deploymentName, .category, (.capabilities|join(","))] | @tsv' "$models_path" | \
        awk 'BEGIN { printf "%-16s %-20s %-12s %s\n", "Model", "DeploymentName", "Category", "Capabilities" } { printf "%-16s %-20s %-12s %s\n", $1, $2, $3, $4 }'
    print_ok "Displayed available models (section 9.1)"
}

check_prereqs() {
    require_command az

    if ! az account show --query id -o tsv >/dev/null 2>&1; then
        printf "Azure CLI is not authenticated. Run: az login\n" >&2
        exit 1
    fi

    if [[ -n "$SUBSCRIPTION_ID" ]]; then
        az account set --subscription "$SUBSCRIPTION_ID"
        print_ok "Active subscription set to ${SUBSCRIPTION_ID}"
    fi

    for provider in Microsoft.CognitiveServices Microsoft.AppService; do
        state="$(az provider show --namespace "$provider" --query registrationState -o tsv)"
        if [[ "$state" != "Registered" ]]; then
            print_warn "${provider} is ${state}. Registering now..."
            az provider register --namespace "$provider"
            print_ok "${provider} registration requested"
        else
            print_ok "Provider registered: ${provider}"
        fi
    done

    print_ok "Prerequisites completed (section 9.2)"
}

run_terraform_deploy() {
    require_command terraform

    local infra_path="${REPO_ROOT}/infra"
    local tfvars_full_path="$TFVARS_PATH"

    if [[ "$TFVARS_PATH" != /* ]]; then
        tfvars_full_path="${REPO_ROOT}/${TFVARS_PATH}"
    fi

    if [[ ! -f "$tfvars_full_path" ]]; then
        printf 'tfvars file not found: %s\n' "$tfvars_full_path" >&2
        exit 1
    fi

    (cd "$infra_path" && terraform init)
    (cd "$infra_path" && terraform plan -var-file="$tfvars_full_path")

    if [[ "$AUTO_APPROVE" == "true" ]]; then
        (cd "$infra_path" && terraform apply -auto-approve -var-file="$tfvars_full_path")
    else
        (cd "$infra_path" && terraform apply -var-file="$tfvars_full_path")
    fi

    print_ok "Terraform deployment completed (section 9.3)"
}

resolve_foundry_values() {
    if [[ -n "$FOUNDRY_ENDPOINT" && -n "$FOUNDRY_API_KEY" ]]; then
        return 0
    fi

    if [[ -z "$RESOURCE_GROUP_NAME" || -z "$AI_SERVICES_NAME" ]]; then
        return 0
    fi

    require_command az

    if [[ -z "$FOUNDRY_ENDPOINT" ]]; then
        FOUNDRY_ENDPOINT="$(az cognitiveservices account show --resource-group "$RESOURCE_GROUP_NAME" --name "$AI_SERVICES_NAME" --query properties.endpoint -o tsv)"
    fi

    if [[ -z "$FOUNDRY_API_KEY" ]]; then
        FOUNDRY_API_KEY="$(az cognitiveservices account keys list --resource-group "$RESOURCE_GROUP_NAME" --name "$AI_SERVICES_NAME" --query key1 -o tsv)"
    fi
}

configure_api_env() {
    resolve_foundry_values

    if [[ -z "$FOUNDRY_ENDPOINT" || -z "$FOUNDRY_API_KEY" ]]; then
        printf 'Could not resolve FOUNDRY_ENDPOINT/FOUNDRY_API_KEY. Provide explicit values or ResourceGroup/AIServicesName.\n' >&2
        exit 1
    fi

    local env_file="${REPO_ROOT}/app/backend/.env"
    touch "$env_file"

    set_or_replace_env "$env_file" "FOUNDRY_ENDPOINT" "$FOUNDRY_ENDPOINT"
    set_or_replace_env "$env_file" "FOUNDRY_API_KEY" "$FOUNDRY_API_KEY"
    set_or_replace_env "$env_file" "APIM_OPENAI_URL" "$APIM_OPENAI_URL"

    rm -f "${env_file}.bak"
    print_ok "Updated API environment: ${env_file} (section 9.6)"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        list-models|check-prereqs|deploy-terraform|configure-api-env|all)
            ACTION="$1"
            shift
            ;;
        --subscription-id)
            SUBSCRIPTION_ID="$2"
            shift 2
            ;;
        --resource-group)
            RESOURCE_GROUP_NAME="$2"
            shift 2
            ;;
        --ai-services-name)
            AI_SERVICES_NAME="$2"
            shift 2
            ;;
        --tfvars-path)
            TFVARS_PATH="$2"
            shift 2
            ;;
        --auto-approve)
            AUTO_APPROVE="true"
            shift
            ;;
        --foundry-endpoint)
            FOUNDRY_ENDPOINT="$2"
            shift 2
            ;;
        --foundry-api-key)
            FOUNDRY_API_KEY="$2"
            shift 2
            ;;
        --apim-openai-url)
            APIM_OPENAI_URL="$2"
            shift 2
            ;;
        *)
            printf 'Unknown argument: %s\n' "$1" >&2
            exit 1
            ;;
    esac
done

case "$ACTION" in
    list-models)
        show_models
        ;;
    check-prereqs)
        check_prereqs
        ;;
    deploy-terraform)
        check_prereqs
        run_terraform_deploy
        ;;
    configure-api-env)
        configure_api_env
        ;;
    all)
        show_models
        check_prereqs
        run_terraform_deploy
        configure_api_env
        ;;
    *)
        printf 'Unsupported action: %s\n' "$ACTION" >&2
        exit 1
        ;;
esac
