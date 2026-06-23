# =============================================================================
# Local Values for Pronghorn Infrastructure
# =============================================================================

locals {
  # PBMM Landing Zone tags — only included when non-empty
  pbmm_tags = merge(
    var.client_organization != "" ? { ClientOrganization = var.client_organization } : {},
    var.cost_center != "" ? { CostCenter = var.cost_center } : {},
    var.data_sensitivity != "" ? { DataSensitivity = var.data_sensitivity } : {},
    var.project_contact != "" ? { ProjectContact = var.project_contact } : {},
    var.project_name_tag != "" ? { ProjectName = var.project_name_tag } : {},
    var.technical_contact != "" ? { TechnicalContact = var.technical_contact } : {},
  )

  # Common tags applied to all resources
  common_tags = merge({
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "Terraform"
  }, local.pbmm_tags, var.extra_tags)

  # Resource naming with random suffix for uniqueness
  log_analytics_name = "log-${var.project_name}-${random_string.suffix.result}"
  app_insights_name  = "appi-${var.project_name}-${random_string.suffix.result}"
  keyvault_name      = "kv-${var.project_name}-${random_string.suffix.result}"
  storage_name       = "st${var.project_name}${random_string.suffix.result}"
  # Dedicated storage account for generated-app code/file blob writes (repo blob store).
  # Kept separate from the platform storage account above so code-file traffic and
  # access control are isolated. Name must be globally unique, <=24 chars, lowercase
  # alphanumeric — "repo" infix keeps it distinct from local.storage_name.
  repo_storage_name  = "st${var.project_name}repo${random_string.suffix.result}"
  container_app_name = "ca-${var.project_name}-api"
  frontend_app_name  = "ca-${var.project_name}-frontend"
  apim_name          = "apim-${var.project_name}-${random_string.suffix.result}"
  frontdoor_name     = "afd-${var.project_name}-${random_string.suffix.result}"

  # AI Foundry naming
  ai_foundry_name = "ai-${var.project_name}-${random_string.suffix.result}"

  # Entra ID — prefer module outputs when app registration is created by Terraform
  effective_client_id = var.create_entra_app_registration ? module.entra_app_registration[0].client_id : var.azure_client_id
  effective_tenant_id = var.create_entra_app_registration ? module.entra_app_registration[0].tenant_id : var.azure_tenant_id

  # Platform RG defaults to the main deployment RG when not explicitly set.
  effective_platform_resource_group_name = var.platform_resource_group_name != "" ? var.platform_resource_group_name : var.resource_group_name

  # Canonical GitHub and workflow settings with compatibility fallback to
  # legacy api_extra_env_vars entries during migration.
  configured_github_org                 = var.github_org != "" ? var.github_org : lookup(var.api_extra_env_vars, "GITHUB_ORG", "")
  configured_genapp_workflow_owner      = var.genapp_workflow_owner != "" ? var.genapp_workflow_owner : lookup(var.api_extra_env_vars, "PRONGHORN_WORKFLOW_OWNER", "")
  configured_genapp_workflow_repository = var.genapp_workflow_repository != "" ? var.genapp_workflow_repository : lookup(var.api_extra_env_vars, "PRONGHORN_WORKFLOW_REPO", "")
  configured_genapp_workflow_ref        = var.genapp_workflow_ref != "" ? var.genapp_workflow_ref : lookup(var.api_extra_env_vars, "PRONGHORN_WORKFLOW_REF", "")
  configured_genapp_workflow_file       = var.genapp_workflow_file != "" ? var.genapp_workflow_file : (lookup(var.api_extra_env_vars, "DOCKER_DEPLOY_WORKFLOW_FILE", "") != "" ? lookup(var.api_extra_env_vars, "DOCKER_DEPLOY_WORKFLOW_FILE", "") : "genapp-deploy.yml")

  # Optional secrets — conditionally included in Key Vault and Container App configs.
  # Defined once here to avoid repeating the pattern in multiple module calls.
  # NOTE: jwt-secret is intentionally NOT here — it is a generated secret seeded
  # create-if-absent into Key Vault (see secrets.tf) so its value never lands in
  # Terraform state. It is always referenced by the container (see
  # api_secret_environment_variables below).
  optional_secrets = merge(
    var.github_pat != "" ? { "github-pat" = var.github_pat } : {},
    var.render_api_key != "" ? { "render-api-key" = var.render_api_key } : {},
    var.render_owner_id != "" ? { "render-owner-id" = var.render_owner_id } : {}
  )

  # Secret environment variable refs (maps env var name → secret name in container app)
  optional_secret_env_refs = merge(
    var.github_pat != "" ? { "GITHUB_PAT" = "github-pat" } : {},
    var.render_api_key != "" ? { "RENDER_API_KEY" = "render-api-key" } : {},
    var.render_owner_id != "" ? { "RENDER_OWNER_ID" = "render-owner-id" } : {}
  )

  # ---------------------------------------------------------------------------
  # API container app environment variables (single source of truth)
  # Terraform defines these; the CI workflow reads them via output and applies
  # with `az containerapp update --set-env-vars`, since the AVM module's
  # ignore_changes on body.properties.template prevents Terraform from
  # updating the template after initial creation.
  #
  # Static/configurable vars → var.api_extra_env_vars (set in tfvars)
  # Computed vars (module outputs) → merged here automatically
  #
  # NOTE — Entra IDs are exposed as ENTRA_TENANT_ID / ENTRA_CLIENT_ID, NOT
  # AZURE_TENANT_ID / AZURE_CLIENT_ID. The @azure/identity SDK reserves the
  # AZURE_* names (see DefaultAzureCredential / ManagedIdentityCredential):
  # if AZURE_CLIENT_ID is set in the container, the SDK treats it as a
  # user-assigned managed identity clientId and fails with
  # "No User Assigned or Delegated Managed Identity found for specified
  # ClientId" when only a system-assigned MI is attached. Keep the app's
  # Entra/MSAL values in the ENTRA_* namespace; backend code reads ENTRA_*
  # with an AZURE_* fallback for local dev compatibility.
  # ---------------------------------------------------------------------------
  api_environment_variables = merge(
    var.api_extra_env_vars,
    {
      # Infrastructure-derived values (cannot live in tfvars)
      "POSTGRES_DATABASE"           = var.postgresql_database_name
      "POSTGRES_USER"               = var.administrator_login
      "POSTGRES_HOST"               = module.postgresql.server_fqdn
      "POSTGRES_GENAPPS_USER"       = var.postgresql_genapps_administrator_login
      "POSTGRES_GENAPPS_HOST"       = module.postgresql_genapps.server_fqdn
      "ALLOWED_ORIGINS"             = join(",", concat(var.allowed_origins, var.enable_development_access ? ["http://localhost:5173"] : []))
      "AZURE_SUBSCRIPTION_ID"       = var.subscription_id
      "AZURE_DEPLOY_RESOURCE_GROUP" = var.resource_group_name
      "AZURE_ACR_RESOURCE_GROUP"    = local.effective_platform_resource_group_name
      "AZURE_ACR_AGENT_POOL"        = var.acr_agent_pool_name
      "AZURE_ACR_NAME"              = local.acr_name
      "AZURE_ACR_LOGIN_SERVER"      = local.acr_login_server
      "AZURE_CONTAINER_APPS_ENV"    = module.workload_environment.environment_id
      "GITHUB_ORG"                  = local.configured_github_org
      "PRONGHORN_WORKFLOW_OWNER"    = local.configured_genapp_workflow_owner
      "PRONGHORN_WORKFLOW_REPO"     = local.configured_genapp_workflow_repository
      "PRONGHORN_WORKFLOW_REF"      = local.configured_genapp_workflow_ref
      "DOCKER_DEPLOY_WORKFLOW_FILE" = local.configured_genapp_workflow_file
      # Region the backend creates per-generated-app Key Vaults in. Without this
      # genappKeyVaultLocation() falls back to a US default (eastus2), which the
      # "Canada Central/East regions only" Azure Policy rejects. Inherit the
      # platform region so genapp vaults land in an allowed region.
      "AZURE_LOCATION" = var.location
      # Points at the dedicated repo/code-writes storage account, not the platform account.
      "AZURE_STORAGE_ACCOUNT_NAME" = module.storage_repo.name
      # Central platform Key Vault data-plane URI. The backend stores project
      # database connection strings here (single fast write, vault already exists
      # with private endpoint + DNS + the API identity's Secrets User grant),
      # instead of in fragile lazily-created per-project vaults. Only the API
      # identity has a role on this vault, so cross-app isolation is preserved.
      "AZURE_PLATFORM_KEYVAULT_URI" = module.keyvault.vault_uri
      "ENTRA_TENANT_ID"             = var.azure_tenant_id # Bootstrap; output overrides with effective value. NOT AZURE_TENANT_ID — see note above.
      "ENTRA_CLIENT_ID"             = var.azure_client_id # Bootstrap; output overrides with effective value. NOT AZURE_CLIENT_ID — see note above.
      # Public network access for the per-generated-app Key Vaults the backend
      # creates at runtime. "Enabled" in dev (+ SecurityControl=Ignore tag),
      # "Disabled" in PBMM (private endpoints).
      "AZURE_GENAPP_KEYVAULT_PUBLIC_NETWORK_ACCESS" = var.genapp_keyvault_public_network_access
    },
    # Per-generated-app Key Vault private connectivity (PBMM). Only surfaced when
    # public access is Disabled: the backend creates a private endpoint per vault
    # in this subnet and (optionally) attaches the given DNS zone group, otherwise
    # it waits for landing-zone Policy. Subnet/zone default to the core KV values.
    var.genapp_keyvault_public_network_access == "Disabled" && local.genapp_keyvault_pe_subnet_id != null ? {
      "AZURE_GENAPP_KEYVAULT_PRIVATE_ENDPOINT_SUBNET_ID" = local.genapp_keyvault_pe_subnet_id
    } : {},
    var.genapp_keyvault_public_network_access == "Disabled" && local.genapp_keyvault_dns_zone_id != null ? {
      "AZURE_GENAPP_KEYVAULT_PRIVATE_DNS_ZONE_ID" = local.genapp_keyvault_dns_zone_id
    } : {},
    # Database migration toggle
    { "RUN_MIGRATIONS_ON_STARTUP" = tostring(var.run_migrations_on_startup) },
  )

  api_secret_environment_variables = merge(
    {
      "POSTGRES_PASSWORD"         = "postgres-password"
      "POSTGRES_GENAPPS_PASSWORD" = "postgres-genapps-password"
      # jwt-secret is a generated, seeded secret (see secrets.tf); always referenced.
      "JWT_SECRET" = "jwt-secret"
      # GitHub App identity is dummy-seeded in Key Vault (see secrets.tf); the
      # real values are set out-of-band. Always referenced so the container
      # resolves them once an operator populates the secrets.
      "GITHUB_APP_PRIVATE_KEY"     = "github-app-private-key"
      "GITHUB_APP_ID"              = "github-app-id"
      "GITHUB_APP_INSTALLATION_ID" = "github-app-installation-id"
    },
    local.optional_secret_env_refs
  )

  # ---------------------------------------------------------------------------
  # Frontend build-time environment variables (mirrors api_environment_variables)
  # Static/configurable vars → var.frontend_build_vars (set in tfvars)
  # Computed vars (module outputs) → merged here automatically
  # All keys MUST be VITE_ prefixed (Vite build requirement).
  # ---------------------------------------------------------------------------
  frontend_build_environment_variables = merge(
    var.frontend_build_vars,
    {
      # Infrastructure-derived values (override-aware)
      # VITE_API_BASE_URL / VITE_WS_URL: when api_base_url_override is set (public
      # custom domain fronting the API), the browser must use it instead of the
      # internal APIM gateway URL, which is not reachable from a public client.
      # VITE_AZURE_REDIRECT_URI: when frontend_app_url_override is set (public
      # custom domain fronting the frontend), bake it as the MSAL redirect URI.
      "VITE_ENTRA_CLIENT_ID"    = local.effective_client_id
      "VITE_ENTRA_TENANT_ID"    = local.effective_tenant_id
      "VITE_API_BASE_URL"       = coalesce(var.api_base_url_override, module.api_management.gateway_url)
      "VITE_AZURE_REDIRECT_URI" = coalesce(var.frontend_app_url_override, module.frontend.app_url)
      "VITE_WS_URL"             = var.api_base_url_override != null ? replace(var.api_base_url_override, "https://", "wss://") : module.container_apps.app_url
    },
    # Derive VITE_GITHUB_ORG from canonical github_org (with compatibility fallback)
    local.configured_github_org != "" ? {
      "VITE_GITHUB_ORG" = local.configured_github_org
    } : {}
  )
}

# =============================================================================
# Central Private DNS Zone References (PBMM / vWAN hub)
# =============================================================================
# In PBMM Landing Zone deployments (e.g. GoA), creating privatelink.* Private
# DNS Zones is blocked by Azure Policy. All zones live centrally in a hub
# subscription (e.g. goa-it-connectivity). These data sources reference the
# existing zones via the "central_dns" aliased provider so Terraform can pass
# their IDs to private-endpoint zone groups without creating new zones.
#
# Behavior:
#   - Data source lookups activate only when central_dns_subscription_id and
#     central_dns_resource_group_name are both non-empty.
#   - When delegate_private_dns_to_policy = true, ALL lookups are skipped and
#     every resolved_*_dns_zone_id is forced to null so the landing-zone Azure
#     Policy attaches the DNS zone groups out-of-band. The deploying identity
#     then needs no access to the central DNS subscription.
#   - Explicit *_private_dns_zone_id tfvars still take precedence via the
#     local.resolved_*_dns_zone_id locals below (unless policy delegation is on).
#   - If neither is set, resolved values are null and the PE is created
#     without a zone group (resolution then relies on the Private Resolver).
# =============================================================================

locals {
  central_dns_enabled = !var.delegate_private_dns_to_policy && var.central_dns_subscription_id != "" && var.central_dns_resource_group_name != ""

  # Map of logical key => zone name. The ACA zone is region-specific.
  central_dns_zone_names = {
    postgres  = "privatelink.postgres.database.azure.com"
    blob      = "privatelink.blob.core.windows.net"
    keyvault  = "privatelink.vaultcore.azure.net"
    acr       = "privatelink.azurecr.io"
    cognitive = "privatelink.cognitiveservices.azure.com"
    openai    = "privatelink.openai.azure.com"
    aca       = "privatelink.${var.location}.azurecontainerapps.io"
  }
}

data "azurerm_private_dns_zone" "central" {
  provider            = azurerm.central_dns
  for_each            = local.central_dns_enabled ? local.central_dns_zone_names : {}
  name                = each.value
  resource_group_name = var.central_dns_resource_group_name
}

# -----------------------------------------------------------------------------
# Resolved DNS zone IDs
# -----------------------------------------------------------------------------
# Precedence: explicit tfvars value > central DNS data-source lookup > null
# -----------------------------------------------------------------------------
locals {
  resolved_postgres_dns_zone_id = var.delegate_private_dns_to_policy ? null : try(coalesce(
    var.postgresql_pe_private_dns_zone_id,
    var.private_dns_zone_id,
    try(data.azurerm_private_dns_zone.central["postgres"].id, null),
  ), null)

  resolved_storage_dns_zone_id = var.delegate_private_dns_to_policy ? null : try(coalesce(
    var.storage_private_dns_zone_id,
    try(data.azurerm_private_dns_zone.central["blob"].id, null),
  ), null)

  resolved_keyvault_dns_zone_id = var.delegate_private_dns_to_policy ? null : try(coalesce(
    var.keyvault_private_dns_zone_id,
    try(data.azurerm_private_dns_zone.central["keyvault"].id, null),
  ), null)

  # Per-generated-app Key Vault private connectivity, defaulting to the core
  # Key Vault's PE subnet / DNS zone when not explicitly overridden.
  genapp_keyvault_pe_subnet_id = try(coalesce(
    var.genapp_keyvault_private_endpoint_subnet_id,
    var.keyvault_private_endpoint_subnet_id,
  ), null)

  genapp_keyvault_dns_zone_id = var.delegate_private_dns_to_policy ? null : try(coalesce(
    var.genapp_keyvault_private_dns_zone_id,
    local.resolved_keyvault_dns_zone_id,
  ), null)

  resolved_acr_dns_zone_id = var.delegate_private_dns_to_policy ? null : try(coalesce(
    var.acr_private_dns_zone_id,
    try(data.azurerm_private_dns_zone.central["acr"].id, null),
  ), null)

  resolved_aca_env_dns_zone_id = var.delegate_private_dns_to_policy ? null : try(coalesce(
    var.aca_environment_private_dns_zone_id,
    try(data.azurerm_private_dns_zone.central["aca"].id, null),
  ), null)

  resolved_workload_aca_dns_zone_id = var.delegate_private_dns_to_policy ? null : try(coalesce(
    var.workload_aca_private_dns_zone_id,
    try(data.azurerm_private_dns_zone.central["aca"].id, null),
  ), null)

  # AI Foundry needs BOTH cognitiveservices and openai zones linked to its PE.
  resolved_ai_foundry_dns_zone_ids = (
    var.delegate_private_dns_to_policy
    ? null
    : (
      var.ai_foundry_private_dns_zone_ids != null && length(coalesce(var.ai_foundry_private_dns_zone_ids, [])) > 0
      ? var.ai_foundry_private_dns_zone_ids
      : (
        local.central_dns_enabled
        ? [
          data.azurerm_private_dns_zone.central["cognitive"].id,
          data.azurerm_private_dns_zone.central["openai"].id,
        ]
        : (var.ai_foundry_private_dns_zone_id != null ? [var.ai_foundry_private_dns_zone_id] : null)
      )
    )
  )
}
