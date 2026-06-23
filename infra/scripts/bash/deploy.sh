#!/usr/bin/env bash
# =============================================================================
# Pronghorn Deployment Script (Bash)
# =============================================================================
# This script deploys the Pronghorn infrastructure and applications in the
# correct order:
#   1. Deploy core infrastructure (ACR, networking, databases, etc.)
#   2. Build and push container images to ACR
#   3. Deploy Container Apps with the built images
#
# Usage:
#   ./deploy.sh -e dev [-I] [-B] [-C] [-P]
#   ./deploy.sh --environment dev [--skip-infra] [--skip-build] [--skip-container-apps] [--plan]
#
# Options:
#   -e, --environment          Target environment: dev, test, prod (required)
#   -I, --skip-infra           Skip infrastructure deployment
#   -B, --skip-build           Skip container image build/push
#   -C, --skip-container-apps  Skip Container Apps deployment
#   -P, --plan                 Run terraform plan instead of apply
#       --postgres-password    PostgreSQL administrator password
#       --jwt-secret           JWT secret for the API
#       --apim-email           APIM publisher email override
#   -h, --help                 Show this help message
#
# Prerequisites:
#   - Azure CLI installed and logged in
#   - Terraform installed
#   - Node.js installed (for frontend/API builds)
#   - Docker installed (for container image builds)
#
# Example:
#   # Deploy everything to dev
#   ./deploy.sh -e dev
#
#   # Skip infra, just rebuild and push containers
#   ./deploy.sh -e dev --skip-infra
#
#   # Plan only (dry run)
#   ./deploy.sh -e dev --plan
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Resolve paths
# -----------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$INFRA_DIR/.." && pwd)"

# -----------------------------------------------------------------------------
# Defaults
# -----------------------------------------------------------------------------
ENVIRONMENT=""
SKIP_INFRA=false
SKIP_BUILD=false
SKIP_CONTAINER_APPS=false
PLAN_ONLY=false
POSTGRES_PASSWORD=""
JWT_SECRET=""
APIM_PUBLISHER_EMAIL=""

# -----------------------------------------------------------------------------
# Output helpers
# -----------------------------------------------------------------------------
step()    { printf '\n\033[36m=== %s ===\033[0m\n' "$1"; }
ok()      { printf '\033[32m[OK] %s\033[0m\n' "$1"; }
info()    { printf '\033[33m-> %s\033[0m\n' "$1"; }
err()     { printf '\033[31m[ERROR] %s\033[0m\n' "$1" >&2; }

die() { err "$1"; exit 1; }

# -----------------------------------------------------------------------------
# Usage
# -----------------------------------------------------------------------------
usage() {
  sed -n '/^# Usage:/,/^# =====/p' "$0" | sed 's/^# \?//'
  exit 0
}

# -----------------------------------------------------------------------------
# Parse arguments
# -----------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -e|--environment)       ENVIRONMENT="$2"; shift 2 ;;
    -I|--skip-infra)        SKIP_INFRA=true; shift ;;
    -B|--skip-build)        SKIP_BUILD=true; shift ;;
    -C|--skip-container-apps) SKIP_CONTAINER_APPS=true; shift ;;
    -P|--plan)              PLAN_ONLY=true; shift ;;
    --postgres-password)    POSTGRES_PASSWORD="$2"; shift 2 ;;
    --jwt-secret)           JWT_SECRET="$2"; shift 2 ;;
    --apim-email)           APIM_PUBLISHER_EMAIL="$2"; shift 2 ;;
    -h|--help)              usage ;;
    *) die "Unknown option: $1" ;;
  esac
done

if [[ -z "$ENVIRONMENT" ]]; then
  die "Environment is required. Use -e dev|test|prod"
fi

case "$ENVIRONMENT" in
  dev|test|prod) ;;
  *) die "Invalid environment '$ENVIRONMENT'. Must be one of: dev, test, prod" ;;
esac

TFVARS_FILE="$INFRA_DIR/params/$ENVIRONMENT.tfvars"

# =============================================================================
# STEP 1: Validate Prerequisites
# =============================================================================
step "Validating Prerequisites"

command -v az        >/dev/null 2>&1 || die "Azure CLI is not installed. Please install it first."
ok "Azure CLI found"

command -v terraform >/dev/null 2>&1 || die "Terraform is not installed. Please install it first."
ok "Terraform found"

command -v node      >/dev/null 2>&1 || die "Node.js is not installed. Please install it first."
ok "Node.js found"

command -v docker    >/dev/null 2>&1 || die "Docker is not installed. Please install it first."
ok "Docker found"

[[ -f "$TFVARS_FILE" ]] || die "Terraform variables file not found: $TFVARS_FILE"
ok "Found tfvars: $TFVARS_FILE"

# Verify Azure login
ACCOUNT_JSON="$(az account show 2>/dev/null)" || die "Not logged into Azure. Run 'az login' first."
ACCOUNT_USER="$(echo "$ACCOUNT_JSON" | grep -o '"name": *"[^"]*"' | head -1 | sed 's/"name": *"\(.*\)"/\1/')"
ok "Logged in as: $ACCOUNT_USER"

# Resolve APIM publisher email
if [[ -z "$APIM_PUBLISHER_EMAIL" ]]; then
  if echo "$ACCOUNT_USER" | grep -qE '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'; then
    APIM_PUBLISHER_EMAIL="$ACCOUNT_USER"
  else
    APIM_PUBLISHER_EMAIL="pronghorn-dev@local.invalid"
    info "Using fallback APIM publisher email: $APIM_PUBLISHER_EMAIL"
  fi
fi
info "APIM publisher email: $APIM_PUBLISHER_EMAIL"

# =============================================================================
# STEP 2: Deploy Core Infrastructure (ACR, Networking, DB, etc.)
# =============================================================================
if [[ "$SKIP_INFRA" == false ]]; then
  step "Deploying Core Infrastructure"

  cd "$INFRA_DIR"

  info "Initializing Terraform..."
  terraform init

  # Build terraform variable arguments
  TF_ARGS=(
    "-var-file=$TFVARS_FILE"
    "-var=apim_publisher_email=$APIM_PUBLISHER_EMAIL"
  )

  [[ -n "$POSTGRES_PASSWORD" ]] && TF_ARGS+=("-var=administrator_password=$POSTGRES_PASSWORD")
  [[ -n "$JWT_SECRET" ]]        && TF_ARGS+=("-var=jwt_secret=$JWT_SECRET")

  # Target only core infrastructure (not container apps)
  INFRA_TARGETS=(
    "-target=random_string.suffix"
    "-target=azurerm_resource_group.main"
    "-target=module.logging"
    "-target=module.container_registry"
    "-target=module.keyvault"
    "-target=module.storage"
    "-target=module.postgresql"
  )

  if [[ "$PLAN_ONLY" == true ]]; then
    info "Planning infrastructure..."
    terraform plan "${TF_ARGS[@]}" "${INFRA_TARGETS[@]}"
  else
    info "Applying infrastructure..."
    terraform apply "${TF_ARGS[@]}" "${INFRA_TARGETS[@]}" -auto-approve
    ok "Core infrastructure deployed"
  fi

  cd "$ROOT_DIR"
fi

# =============================================================================
# STEP 3: Get ACR Details from Terraform Output
# =============================================================================
step "Getting ACR Details"

cd "$INFRA_DIR"
ACR_NAME="$(terraform output -raw container_registry_name 2>/dev/null)" \
  || die "Could not get ACR name from Terraform. Make sure infrastructure is deployed."
ACR_LOGIN_SERVER="$(terraform output -raw container_registry_login_server 2>/dev/null)" \
  || die "Could not get ACR login server from Terraform."
RESOURCE_GROUP="$(terraform output -raw resource_group_name 2>/dev/null)" \
  || die "Could not get resource group name from Terraform."

ok "ACR Name: $ACR_NAME"
ok "ACR Login Server: $ACR_LOGIN_SERVER"
ok "Resource Group: $RESOURCE_GROUP"
cd "$ROOT_DIR"

# =============================================================================
# STEP 4: Build and Push Container Images
# =============================================================================
if [[ "$SKIP_BUILD" == false ]]; then
  step "Building and Pushing Container Images"

  # Login to ACR
  info "Logging into ACR..."
  az acr login --name "$ACR_NAME" || die "ACR login failed"
  ok "Logged into ACR"

  # --- Frontend ---
  info "Building frontend app..."
  cd "$ROOT_DIR"
  npm run build || die "Frontend build failed"
  ok "Frontend built successfully"

  FRONTEND_IMAGE="$ACR_LOGIN_SERVER/pronghorn-frontend:latest"
  info "Building frontend Docker image..."
  docker build -t "$FRONTEND_IMAGE" -f Dockerfile . || die "Frontend Docker build failed"
  ok "Frontend image built"

  info "Pushing frontend image to ACR..."
  docker push "$FRONTEND_IMAGE" || die "Frontend image push failed"
  ok "Frontend image pushed: $FRONTEND_IMAGE"

  # --- API ---
  info "Building API..."
  cd "$ROOT_DIR/api"
  npm run build || die "API build failed"
  ok "API built successfully"

  API_IMAGE="$ACR_LOGIN_SERVER/pronghorn-api:latest"
  info "Building API Docker image..."
  docker build -t "$API_IMAGE" -f Dockerfile . || die "API Docker build failed"
  ok "API image built"

  info "Pushing API image to ACR..."
  docker push "$API_IMAGE" || die "API image push failed"
  ok "API image pushed: $API_IMAGE"

  cd "$ROOT_DIR"
fi

# =============================================================================
# STEP 5: Deploy Container Apps
# =============================================================================
if [[ "$SKIP_CONTAINER_APPS" == false ]]; then
  step "Deploying Container Apps"

  cd "$INFRA_DIR"

  TF_ARGS=(
    "-var-file=$TFVARS_FILE"
    "-var=apim_publisher_email=$APIM_PUBLISHER_EMAIL"
    "-var=container_image=${ACR_LOGIN_SERVER}/pronghorn-api:latest"
    "-var=frontend_container_image=${ACR_LOGIN_SERVER}/pronghorn-frontend:latest"
  )

  [[ -n "$POSTGRES_PASSWORD" ]] && TF_ARGS+=("-var=administrator_password=$POSTGRES_PASSWORD")
  [[ -n "$JWT_SECRET" ]]        && TF_ARGS+=("-var=jwt_secret=$JWT_SECRET")

  if [[ "$PLAN_ONLY" == true ]]; then
    info "Planning Container Apps deployment..."
    terraform plan "${TF_ARGS[@]}"
  else
    info "Applying full infrastructure with Container Apps..."
    terraform apply "${TF_ARGS[@]}" -auto-approve || die "Container Apps deployment failed"
    ok "Container Apps deployed"

    # --- Show outputs ---
    step "Deployment Complete!"

    API_URL="$(terraform output -raw container_app_url 2>/dev/null || echo 'N/A')"
    FRONTEND_URL="$(terraform output -raw frontend_app_url 2>/dev/null || echo 'N/A')"
    APIM_URL="$(terraform output -raw api_management_gateway_url 2>/dev/null || echo 'N/A')"

    printf '\n\033[36mDeployed Resources:\033[0m\n'
    printf '  \033[32mFrontend URL: %s\033[0m\n' "$FRONTEND_URL"
    printf '  \033[32mAPI URL:      %s\033[0m\n' "$API_URL"
    printf '  \033[32mAPIM URL:     %s\033[0m\n' "$APIM_URL"
  fi

  cd "$ROOT_DIR"
fi

printf '\n\033[32m[OK] Deployment completed successfully!\033[0m\n'
