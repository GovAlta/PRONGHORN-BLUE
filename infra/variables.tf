# =============================================================================
# Azure Configuration Variables
# =============================================================================

variable "subscription_id" {
  description = "Azure subscription ID"
  type        = string
}

variable "archetype" {
  description = "Deployment archetype (online=non-pbmm, corp=pbmm)"
  type        = string
  default     = "online"

  validation {
    condition     = contains(["online", "corp"], var.archetype)
    error_message = "Archetype must be 'online' or 'corp'."
  }
}

# -----------------------------------------------------------------------------
# Central Private DNS (PBMM / vWAN hub) - optional
# -----------------------------------------------------------------------------
# When set, Terraform will look up existing privatelink.* zones in the central
# DNS subscription instead of requiring each *_private_dns_zone_id variable to
# be provided explicitly. Explicit per-zone IDs (if set) still take precedence.
# Leave empty in non-PBMM environments where the module creates its own zones.
# -----------------------------------------------------------------------------

variable "central_dns_subscription_id" {
  description = "Subscription ID hosting centralized Private DNS Zones (e.g. goa-it-connectivity). Leave empty to disable data-source lookups."
  type        = string
  default     = ""
}

variable "central_dns_resource_group_name" {
  description = "Resource group in central_dns_subscription_id that contains the privatelink.* zones. Required when central_dns_subscription_id is set."
  type        = string
  default     = ""
}

variable "delegate_private_dns_to_policy" {
  description = "When true, delegate ALL private DNS zone group attachment to the landing-zone Azure Policy (DeployIfNotExists). Terraform skips every central Private DNS Zone lookup and passes empty zone IDs to all private endpoints, so the deploying identity needs no access to the central DNS subscription. Use in PBMM/GoA-style environments where policy owns DNS. When false (default), Terraform resolves zone IDs from explicit *_private_dns_zone_id vars or the central DNS subscription."
  type        = bool
  default     = false
}

variable "dns_registration_wait_minutes" {
  description = "Minutes to wait after private endpoint creation before executing data-plane operations (blob container creation, key vault secret access, etc.). Required in environments where central Private DNS registration runs on a schedule (e.g. GoA PBMM ~15-minute auto-registration). Set to 0 when running from a network that can reach public endpoints."
  type        = number
  default     = 20
}

variable "private_endpoint_dns_wait" {
  description = "Configuration for waiting on Azure Policy to attach DNS zone groups to private endpoints. Enable in PBMM / landing-zone environments where platform automation manages DNS zones asynchronously."
  type = object({
    enabled  = bool
    timeout  = string
    interval = string
  })
  default = {
    enabled  = false
    timeout  = "10m"
    interval = "10s"
  }
}

variable "resource_group_name" {
  description = "Name of the resource group"
  type        = string
}

variable "location" {
  description = "Azure region for resources"
  type        = string
  default     = "canadacentral"
}

variable "project_name" {
  description = "Name of the project"
  type        = string
  default     = "pronghorn"
}

variable "environment" {
  description = "Environment name (dev, test, prod)"
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "test", "staging", "prod"], var.environment)
    error_message = "Environment must be one of: dev, test, staging, prod."
  }
}

# -----------------------------------------------------------------------------
# Platform Resource Group
# -----------------------------------------------------------------------------

variable "platform_resource_group_name" {
  description = "Name of the platform resource group for shared resources (ACR, ACA Environment). Leave empty to reuse resource_group_name."
  type        = string
  default     = ""
}

# =============================================================================
# Container Registry Configuration Variables
# =============================================================================

variable "use_existing_acr" {
  description = "Whether to use an existing ACR (true) or create a new one (false). When true, acr_name must reference an existing ACR in platform_resource_group_name."
  type        = bool
  default     = true
}

variable "enable_acr_agent_pool" {
  description = "Whether to create a dedicated ACR agent pool for private builds. Set to false if the customer manages their own build infrastructure."
  type        = bool
  default     = false
}

variable "acr_agent_pool_name" {
  description = "Name of the ACR dedicated agent pool."
  type        = string
  default     = "pronghorn-build-pool"
}

variable "acr_agent_pool_instance_count" {
  description = "Number of instances in the ACR agent pool."
  type        = number
  default     = 1
}

variable "acr_agent_pool_tier" {
  description = "SKU tier for ACR agent pool instances."
  type        = string
  default     = "S1"
}

variable "acr_name" {
  description = "Name of the Azure Container Registry (must be globally unique, alphanumeric only)"
  type        = string
}

variable "acr_sku" {
  description = "SKU for Azure Container Registry"
  type        = string
  default     = "Premium"

  validation {
    condition     = contains(["Basic", "Standard", "Premium"], var.acr_sku)
    error_message = "ACR SKU must be Basic, Standard, or Premium."
  }
}

variable "acr_public_network_access" {
  description = "Enable public network access to the container registry"
  type        = bool
  default     = false
}

variable "acr_private_endpoint_subnet_id" {
  description = "Subnet ID for ACR private endpoint. If provided, a private endpoint will be created."
  type        = string
  default     = null
}

variable "acr_private_dns_zone_id" {
  description = "Private DNS Zone ID for ACR (privatelink.azurecr.io). Required when using private endpoint."
  type        = string
  default     = null
}

# =============================================================================
# Azure AI Foundry Configuration Variables
# =============================================================================

variable "enable_ai_foundry" {
  description = "Enable Azure AI Foundry deployment"
  type        = bool
  default     = true
}

variable "ai_foundry_location" {
  description = "Azure region for AI Foundry (may differ from main location for model availability)"
  type        = string
  default     = "canadaeast" # Canada East has better GPT model availability
}

variable "ai_foundry_project_name" {
  description = "Name for the Foundry Project (child of AI Services account)"
  type        = string
  default     = "pronghorn-project"
}

variable "ai_foundry_project_description" {
  description = "Description for the AI Foundry project."
  type        = string
  default     = "Pronghorn AI development project"
}

variable "ai_foundry_enable_agent_service" {
  description = "Enable Agent service capability hosts for AI Agents"
  type        = bool
  default     = true
}

variable "ai_foundry_sku" {
  description = "SKU for Azure AI Foundry (S0 is standard)"
  type        = string
  default     = "S0"
}

variable "ai_foundry_public_network_access" {
  description = "Enable public network access to AI Foundry"
  type        = bool
  default     = true
}

variable "ai_foundry_disable_local_auth" {
  description = "Disable local (key-based) authentication for AI Foundry"
  type        = bool
  default     = false
}

variable "ai_foundry_private_endpoint_subnet_id" {
  description = "Subnet ID for AI Foundry private endpoint. If provided, a private endpoint will be created."
  type        = string
  default     = null
}

variable "ai_foundry_private_dns_zone_id" {
  description = "DEPRECATED: Use ai_foundry_private_dns_zone_ids instead. Single Private DNS Zone ID for backward compatibility."
  type        = string
  default     = null
}

variable "ai_foundry_private_dns_zone_ids" {
  description = "List of Private DNS Zone IDs for AI Foundry private endpoint. AIServices typically needs both privatelink.cognitiveservices.azure.com and privatelink.openai.azure.com."
  type        = list(string)
  default     = null
}

variable "ai_model_deployments" {
  description = "List of AI model deployments to create in Azure AI Foundry"
  type = list(object({
    deployment_name        = string
    model_name             = string
    model_version          = string
    model_format           = optional(string, "OpenAI")
    sku_name               = optional(string, "GlobalStandard")
    sku_capacity           = optional(number, 10)
    rai_policy_name        = optional(string, "Microsoft.Default")
    version_upgrade_option = optional(string, "OnceCurrentVersionExpired")
  }))
  default = [
    {
      deployment_name = "gpt-4-1"
      model_name      = "gpt-4.1"
      model_version   = "2025-04-14"
      sku_name        = "GlobalStandard"
      sku_capacity    = 20 # 20K TPM
    },
    {
      deployment_name = "gpt-4-1-mini"
      model_name      = "gpt-4.1-mini"
      model_version   = "2025-04-14"
      sku_name        = "GlobalStandard"
      sku_capacity    = 50 # 50K TPM
    }
  ]
}

# =============================================================================
# API Management Configuration Variables
# =============================================================================

variable "apim_sku" {
  description = "SKU for API Management"
  type        = string
  default     = "Consumption_0"
}

variable "apim_api_name" {
  description = "Resource name for the API definition in APIM."
  type        = string
  default     = "pronghorn-api"
}

variable "apim_api_display_name" {
  description = "Display name for the API definition in APIM."
  type        = string
  default     = "Pronghorn API"
}

variable "apim_api_path" {
  description = "URL path prefix for the API in APIM."
  type        = string
  default     = "api"
}

variable "apim_openai_api_version" {
  description = "Azure OpenAI API version used by the APIM proxy policy."
  type        = string
  default     = "2025-04-01-preview"
}

variable "apim_publisher_name" {
  description = "Publisher name for API Management"
  type        = string
  default     = "Pronghorn"
}

variable "apim_publisher_email" {
  description = "Publisher email for API Management"
  type        = string
}

variable "apim_virtual_network_type" {
  description = "VNet integration type for APIM: None, External, or Internal"
  type        = string
  default     = "None"

  validation {
    condition     = contains(["None", "External", "Internal"], var.apim_virtual_network_type)
    error_message = "APIM virtual network type must be None, External, or Internal."
  }
}

variable "apim_subnet_id" {
  description = "Subnet ID for APIM VNet integration"
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# CORS Configuration
# -----------------------------------------------------------------------------

variable "allowed_origins" {
  description = "List of allowed CORS origins"
  type        = list(string)
  default     = ["*"]
}

# =============================================================================
# Container Apps Configuration Variables
# =============================================================================

variable "api_container_name" {
  description = "Name of the container inside the API container app."
  type        = string
  default     = "api"
}

variable "api_target_port" {
  description = "Target port for the API container app ingress."
  type        = number
  default     = 8080
}

variable "api_ingress_transport" {
  description = "Transport protocol for the API container app ingress (auto, http, http2, tcp)."
  type        = string
  default     = "auto"
}

variable "container_image" {
  description = "Container image to deploy"
  type        = string
  default     = "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest"
}

variable "container_cpu" {
  description = "CPU cores for container"
  type        = number
  default     = 0.5
}

variable "container_memory" {
  description = "Memory for container"
  type        = string
  default     = "1Gi"
}

variable "container_min_replicas" {
  description = "Minimum container replicas"
  type        = number
  default     = 0
}

variable "container_max_replicas" {
  description = "Maximum container replicas"
  type        = number
  default     = 10
}

variable "container_apps_subnet_id" {
  description = "Subnet ID for Container Apps Environment (requires /21 or larger, must be delegated to Microsoft.App/environments)"
  type        = string
  default     = null
}

variable "container_apps_internal_only" {
  description = "Enable internal-only load balancer for Container Apps (requires container_apps_subnet_id)"
  type        = bool
  default     = false
}

variable "existing_container_app_environment_id" {
  description = "Resource ID of the platform ACA environment (managed outside Terraform, e.g. VNet-injected with internal LB)"
  type        = string
  default     = null
}

variable "aca_environment_name" {
  description = "Name of the Container App Environment to create/manage"
  type        = string
}

variable "aca_environment_private_endpoint_subnet_id" {
  description = "Subnet ID for Container App Environment private endpoint"
  type        = string
  default     = null
}

variable "aca_environment_private_dns_zone_id" {
  description = "Private DNS Zone ID for Container App Environment"
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# API Container App — Extra Environment Variables
# -----------------------------------------------------------------------------

variable "api_extra_env_vars" {
  description = <<-EOT
    Static environment variables for the API container app, set per-environment
    via tfvars.  These are merged with infrastructure-derived values (database
    FQDNs, ACR login server, etc.) that Terraform computes automatically.
    The combined map is exported as the `api_container_env_vars` output so the
    CI workflow can apply them via `az containerapp update --set-env-vars`.
  EOT
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# Workload Container Apps Environment (tenant-deployed containers)
# -----------------------------------------------------------------------------

variable "workload_aca_environment_name" {
  description = "Name of the workload Container App Environment for user-deployed containers"
  type        = string
  default     = "PronghornWorkloadEnv"
}

variable "workload_aca_subnet_id" {
  description = "Infrastructure subnet ID for the workload ACA environment (requires /21 or larger)"
  type        = string
  default     = null
}

variable "workload_aca_internal_only" {
  description = "Enable internal-only load balancer for the workload ACA environment"
  type        = bool
  default     = true
}

variable "workload_aca_private_endpoint_subnet_id" {
  description = "Subnet ID for workload ACA environment private endpoint"
  type        = string
  default     = null
}

variable "workload_aca_private_dns_zone_id" {
  description = "Private DNS Zone ID for workload ACA environment"
  type        = string
  default     = null
}

# =============================================================================
# Entra ID (Azure AD) Configuration Variables
# =============================================================================

variable "create_entra_app_registration" {
  description = "Whether to create the Entra ID App Registration via Terraform. If false, azure_client_id must be provided manually."
  type        = bool
  default     = false
}

variable "entra_app_display_name" {
  description = "Display name for the Entra ID App Registration. Only used when create_entra_app_registration is true."
  type        = string
  default     = "Pronghorn"
}

variable "entra_app_sign_in_audience" {
  description = "Supported account types for the App Registration. 'AzureADMyOrg' (single-tenant, recommended for PBMM) or 'AzureADMultipleOrgs' (multi-tenant)."
  type        = string
  default     = "AzureADMyOrg"

  validation {
    condition     = contains(["AzureADMyOrg", "AzureADMultipleOrgs"], var.entra_app_sign_in_audience)
    error_message = "Sign-in audience must be AzureADMyOrg or AzureADMultipleOrgs."
  }
}

variable "entra_app_redirect_uris" {
  description = "Additional redirect URIs for the App Registration (e.g. custom domain). The frontend Container App URL is included automatically. Set to [] if no additional URIs are needed."
  type        = list(string)
  default     = []
}

variable "entra_app_include_localhost_redirect" {
  description = "Whether to include http://localhost:5173 as a redirect URI. Should be false for production."
  type        = bool
  default     = false
}

variable "entra_app_owners" {
  description = "List of Azure AD Object IDs to set as owners of the app registration. If empty, the deploying principal is used."
  type        = list(string)
  default     = []
}

variable "frontend_app_url_override" {
  description = "Frontend application URL used as the primary redirect URI for the Entra App Registration. Required when create_entra_app_registration is true."
  type        = string
  default     = null
}

variable "api_base_url_override" {
  description = "Public base URL the browser uses to reach the API (e.g. https://api.example.com). When set, overrides the auto-derived internal APIM gateway URL for the frontend build (VITE_API_BASE_URL and the derived VITE_WS_URL). Use when the API is fronted by a public custom domain / App Gateway. Leave null to use the internal APIM gateway URL."
  type        = string
  default     = null
}

variable "azure_tenant_id" {
  description = "Azure Entra ID tenant ID for authentication. When create_entra_app_registration is true, this is read from the azuread provider automatically."
  type        = string
  default     = null
}

variable "azure_client_id" {
  description = "Azure Entra ID application (client) ID for authentication. When create_entra_app_registration is true, this is set automatically from the created app registration."
  type        = string
  default     = null
}

variable "vite_auth_mode" {
  description = "DEPRECATED: Use frontend_build_vars instead."
  type        = string
  default     = "msal"
}

variable "vite_github_org" {
  description = "DEPRECATED: Use frontend_build_vars instead."
  type        = string
  default     = ""
}

variable "vite_use_azure_api" {
  description = "DEPRECATED: Use frontend_build_vars instead."
  type        = bool
  default     = true
}

variable "frontend_build_vars" {
  description = <<-EOT
    Static build-time environment variables for the frontend container, set
    per-environment via tfvars. These are merged with infrastructure-derived
    values (Entra IDs, APIM URL, etc.) that Terraform computes automatically.
    Keys must be VITE_ prefixed (Vite requirement). The combined map is
    exported as the `frontend_build_env_vars` output so the CI workflow can
    pass them to `npm run build`.
  EOT
  type        = map(string)
  default     = {}
}

# =============================================================================
# Front Door Configuration Variables
# =============================================================================

variable "enable_frontdoor" {
  description = "Whether to deploy Azure Front Door in front of the Application Gateway"
  type        = bool
  default     = false
}

variable "frontdoor_sku" {
  description = "Front Door SKU. Premium_AzureFrontDoor enables WAF policies and Private Link."
  type        = string
  default     = "Premium_AzureFrontDoor"

  validation {
    condition     = contains(["Standard_AzureFrontDoor", "Premium_AzureFrontDoor"], var.frontdoor_sku)
    error_message = "Front Door SKU must be Standard_AzureFrontDoor or Premium_AzureFrontDoor."
  }
}

variable "app_gateway_fqdn" {
  description = "FQDN or public IP of the Application Gateway that Front Door routes to"
  type        = string
  default     = ""
}

variable "app_gateway_http_port" {
  description = "HTTP port on the Application Gateway"
  type        = number
  default     = 80
}

variable "app_gateway_https_port" {
  description = "HTTPS port on the Application Gateway"
  type        = number
  default     = 443
}

variable "frontdoor_origin_host_header" {
  description = "Host header sent to the Application Gateway origin. Leave empty to use the origin hostname."
  type        = string
  default     = ""
}

variable "frontdoor_health_probe_path" {
  description = "Health probe path for the Application Gateway origin"
  type        = string
  default     = "/"
}

variable "frontdoor_health_probe_protocol" {
  description = "Health probe protocol (Http or Https)"
  type        = string
  default     = "Https"
}

variable "frontdoor_health_probe_interval" {
  description = "Interval in seconds between health probes"
  type        = number
  default     = 100
}

variable "frontdoor_forwarding_protocol" {
  description = "Protocol used when forwarding to the origin (HttpOnly, HttpsOnly, MatchRequest)"
  type        = string
  default     = "HttpsOnly"

  validation {
    condition     = contains(["HttpOnly", "HttpsOnly", "MatchRequest"], var.frontdoor_forwarding_protocol)
    error_message = "Forwarding protocol must be HttpOnly, HttpsOnly, or MatchRequest."
  }
}

variable "frontdoor_enable_waf" {
  description = "Whether to create and associate a WAF policy with Front Door"
  type        = bool
  default     = true
}

variable "frontdoor_waf_mode" {
  description = "WAF policy mode: Detection or Prevention"
  type        = string
  default     = "Prevention"

  validation {
    condition     = contains(["Detection", "Prevention"], var.frontdoor_waf_mode)
    error_message = "WAF mode must be Detection or Prevention."
  }
}

variable "frontdoor_custom_domains" {
  description = "List of custom domains to attach to Front Door (e.g., [{host_name = 'pronghorn.blue'}])"
  type = list(object({
    host_name        = string
    certificate_type = optional(string, "ManagedCertificate")
    tls_version      = optional(string, "TLS12")
  }))
  default = []
}

# =============================================================================
# Frontend Configuration Variables
# =============================================================================

variable "frontend_container_name" {
  description = "Name of the container inside the frontend container app."
  type        = string
  default     = "frontend"
}

variable "frontend_container_image" {
  description = "Container image for frontend"
  type        = string
  default     = "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest"
}

variable "frontend_container_cpu" {
  description = "CPU cores for frontend container"
  type        = number
  default     = 0.25
}

variable "frontend_container_memory" {
  description = "Memory for frontend container"
  type        = string
  default     = "0.5Gi"
}

variable "frontend_min_replicas" {
  description = "Minimum frontend container replicas"
  type        = number
  default     = 1
}

variable "frontend_max_replicas" {
  description = "Maximum frontend container replicas"
  type        = number
  default     = 5
}

# =============================================================================
# Key Vault and Secrets Configuration Variables
# =============================================================================

variable "jwt_secret" {
  description = "JWT secret for local development authentication. Not required when using Entra ID + APIM in production."
  type        = string
  sensitive   = true
  default     = ""
}

# Note: Third-party AI provider API keys (Gemini, Anthropic, xAI) have been removed.
# All AI calls now go through Azure AI Foundry via APIM with Managed Identity authentication.

variable "github_pat" {
  description = "GitHub Personal Access Token for repository operations (legacy)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "github_app_id" {
  description = "GitHub App ID for platform workflow dispatch (phb-user-app-deploy)"
  type        = string
  default     = ""
}

variable "github_app_installation_id" {
  description = "GitHub App Installation ID for the pronghorn repo"
  type        = string
  default     = ""
}

variable "github_app_private_key" {
  description = "GitHub App private key (PEM) for generating installation tokens"
  type        = string
  sensitive   = true
  default     = ""
}

variable "run_migrations_on_startup" {
  description = "Run database migrations automatically when the API container starts. Enable in dev, disable in production."
  type        = bool
  default     = false
}

variable "gemini_api_key" {
  description = "Google Gemini API key"
  type        = string
  sensitive   = true
  default     = ""
}

variable "anthropic_api_key" {
  description = "Anthropic API key"
  type        = string
  sensitive   = true
  default     = ""
}

variable "github_org" {
  description = "GitHub organization name for repository operations and frontend links"
  type        = string
  default     = ""
}

variable "genapp_workflow_owner" {
  description = "Owner (organization/user) of the repository that hosts the generated-app deploy workflow"
  type        = string
  default     = ""
}

variable "genapp_workflow_repository" {
  description = "Repository name that hosts the generated-app deploy workflow"
  type        = string
  default     = "pronghorn"
}

variable "genapp_workflow_ref" {
  description = "Branch/tag ref used when dispatching the generated-app deploy workflow"
  type        = string
  default     = ""
}

variable "genapp_workflow_file" {
  description = "Workflow file name used for generated-app deployment dispatch"
  type        = string
  default     = "genapp-deploy.yml"
}

variable "keyvault_sku" {
  description = "SKU for Key Vault. Use 'standard' for dev, 'premium' for HSM-backed keys in production."
  type        = string
  default     = "standard"

  validation {
    condition     = contains(["standard", "premium"], var.keyvault_sku)
    error_message = "Key Vault SKU must be 'standard' or 'premium'."
  }
}

variable "keyvault_soft_delete_retention_days" {
  description = "Number of days to retain soft-deleted Key Vault resources. Production should use 90."
  type        = number
  default     = 7

  validation {
    condition     = var.keyvault_soft_delete_retention_days >= 7 && var.keyvault_soft_delete_retention_days <= 90
    error_message = "Soft delete retention must be between 7 and 90 days."
  }
}

variable "keyvault_purge_protection_enabled" {
  description = "Enable purge protection on Key Vault. Production/PBMM should set true (irreversible once enabled)."
  type        = bool
  default     = false
}

variable "keyvault_public_network_access" {
  description = "Enable public network access to Key Vault. Set to false for production with private endpoints."
  type        = bool
  default     = true
}

variable "genapp_keyvault_public_network_access" {
  description = "Public network access for the per-generated-app Key Vaults that the backend creates at runtime (\"Enabled\" or \"Disabled\"). Dev uses \"Enabled\" (no private endpoints for the lazily-created vaults; the backend also tags them SecurityControl=Ignore to satisfy corporate policy). PBMM uses \"Disabled\" and reaches the vaults via private endpoints. Surfaced to the API container as AZURE_GENAPP_KEYVAULT_PUBLIC_NETWORK_ACCESS."
  type        = string
  default     = "Disabled"

  validation {
    condition     = contains(["Enabled", "Disabled"], var.genapp_keyvault_public_network_access)
    error_message = "genapp_keyvault_public_network_access must be \"Enabled\" or \"Disabled\"."
  }
}

variable "genapp_keyvault_private_endpoint_subnet_id" {
  description = "Subnet ID the backend places per-generated-app Key Vault private endpoints in (PBMM, when genapp_keyvault_public_network_access = \"Disabled\"). Defaults to the core Key Vault PE subnet (keyvault_private_endpoint_subnet_id) when left null. Surfaced to the API container as AZURE_GENAPP_KEYVAULT_PRIVATE_ENDPOINT_SUBNET_ID."
  type        = string
  default     = null
}

variable "genapp_keyvault_private_dns_zone_id" {
  description = "Optional Private DNS Zone ID (privatelink.vaultcore.azure.net) for the per-generated-app Key Vault private endpoints. When set, the backend attaches the DNS zone group itself; when null, it waits for landing-zone Azure Policy to attach it. Defaults to the resolved core Key Vault zone. Surfaced as AZURE_GENAPP_KEYVAULT_PRIVATE_DNS_ZONE_ID."
  type        = string
  default     = null
}

variable "keyvault_network_default_action" {
  description = "Default action for Key Vault network rules (Allow or Deny). Set to Deny for production."
  type        = string
  default     = "Allow"

  validation {
    condition     = contains(["Allow", "Deny"], var.keyvault_network_default_action)
    error_message = "Network default action must be Allow or Deny."
  }
}

variable "keyvault_allowed_ip_ranges" {
  description = "List of IP ranges allowed to access Key Vault during deployment (CIDR notation). Include your deployment machine/pipeline IP."
  type        = list(string)
  default     = []
}

variable "keyvault_private_endpoint_subnet_id" {
  description = "Subnet ID for Key Vault private endpoint. If provided, a private endpoint will be created. For Landing Zone deployments."
  type        = string
  default     = null
}

variable "keyvault_private_dns_zone_id" {
  description = "Private DNS Zone ID for Key Vault (privatelink.vaultcore.azure.net). Required when using private endpoint."
  type        = string
  default     = null
}

# =============================================================================
# Storage Configuration Variables
# =============================================================================

variable "storage_account_tier" {
  description = "Performance tier for the storage account. Standard for most workloads, Premium for high-IOPS."
  type        = string
  default     = "Standard"

  validation {
    condition     = contains(["Standard", "Premium"], var.storage_account_tier)
    error_message = "Storage account tier must be 'Standard' or 'Premium'."
  }
}

variable "storage_replication_type" {
  description = "Replication type for the storage account. LRS for dev, GRS or ZRS for production."
  type        = string
  default     = "LRS"

  validation {
    condition     = contains(["LRS", "GRS", "ZRS", "GZRS", "RAGRS", "RAGZRS"], var.storage_replication_type)
    error_message = "Invalid storage replication type."
  }
}

variable "storage_blob_containers" {
  description = "Map of blob container names to their access type configuration."
  type        = map(object({ access_type = string }))
  default = {
    "pronghorn-files" = { access_type = "private" }
    "artifacts"       = { access_type = "private" }
  }
}

variable "storage_cors_max_age" {
  description = "Maximum age in seconds for CORS preflight caching."
  type        = number
  default     = 3600
}

# =============================================================================
# Logging Configuration Variables
# =============================================================================

variable "app_insights_type" {
  description = "Application type for Application Insights."
  type        = string
  default     = "web"
}

variable "resource_group_wait_duration" {
  description = "Duration to wait after resource group creation before provisioning child resources."
  type        = string
  default     = "30s"
}

variable "log_analytics_sku" {
  description = "SKU for Log Analytics workspace"
  type        = string
  default     = "PerGB2018"

  validation {
    condition     = contains(["PerGB2018", "Free", "Standalone", "PerNode", "Standard", "Premium", "CapacityReservation"], var.log_analytics_sku)
    error_message = "Invalid Log Analytics SKU."
  }
}

variable "log_retention_days" {
  description = "Log retention in days"
  type        = number
  default     = 30
}

# =============================================================================
# PostgreSQL Configuration Variables
# =============================================================================

variable "postgresql_disable_public_access" {
  description = "Disable public network access on PostgreSQL. Defaults to true (PBMM-safe). Set to false for dev environments without VNet/PE."
  type        = bool
  default     = true
}

variable "postgresql_server_name" {
  description = "Name of the PostgreSQL Flexible Server"
  type        = string
}

variable "postgresql_database_name" {
  description = "Name of the PostgreSQL database"
  type        = string
  default     = "pronghorn"
}

variable "administrator_login" {
  description = "Administrator login for PostgreSQL"
  type        = string
  default     = "pronghornAdmin"
}

variable "administrator_password" {
  description = "Break-glass override for the app PostgreSQL admin password. Leave null (default) to use the generated write-only password seeded into Key Vault. When set, also bump administrator_password_wo_version so the change is applied."
  type        = string
  sensitive   = true
  default     = null
}

variable "administrator_password_wo_version" {
  description = "Version integer for the app PostgreSQL write-only admin password. Increment to force the seeded/overridden password to be re-sent to the server (rotation / break-glass)."
  type        = number
  default     = 1
}

variable "postgresql_version" {
  description = "PostgreSQL version"
  type        = string
  default     = "16"

  validation {
    condition     = contains(["14", "15", "16"], var.postgresql_version)
    error_message = "PostgreSQL version must be 14, 15, or 16."
  }
}

variable "postgresql_sku_name" {
  description = "SKU name for PostgreSQL Flexible Server"
  type        = string
  default     = "B_Standard_B2s"
}

variable "postgresql_storage_mb" {
  description = "Storage size in MB for PostgreSQL"
  type        = number
  default     = 32768
}

variable "availability_zone" {
  description = "Availability zone for the primary server"
  type        = string
  default     = "1"

  validation {
    condition     = contains(["1", "2", "3"], var.availability_zone)
    error_message = "Availability zone must be 1, 2, or 3."
  }
}

# -----------------------------------------------------------------------------
# High Availability
# -----------------------------------------------------------------------------

variable "enable_high_availability" {
  description = "Enable zone-redundant high availability"
  type        = bool
  default     = false
}

variable "standby_availability_zone" {
  description = "Availability zone for the standby server"
  type        = string
  default     = "1"
}

# -----------------------------------------------------------------------------
# Backup Configuration
# -----------------------------------------------------------------------------

variable "backup_retention_days" {
  description = "Backup retention days"
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_days >= 7 && var.backup_retention_days <= 35
    error_message = "Backup retention days must be between 7 and 35."
  }
}

variable "geo_redundant_backup_enabled" {
  description = "Enable geo-redundant backup"
  type        = bool
  default     = false
}

# -----------------------------------------------------------------------------
# Maintenance Window
# -----------------------------------------------------------------------------

variable "maintenance_day" {
  description = "Day of week for maintenance window (0=Sunday, 6=Saturday)"
  type        = number
  default     = 0

  validation {
    condition     = var.maintenance_day >= 0 && var.maintenance_day <= 6
    error_message = "Maintenance day must be between 0 (Sunday) and 6 (Saturday)."
  }
}

variable "maintenance_hour" {
  description = "Start hour for maintenance window (0-23 UTC)"
  type        = number
  default     = 2

  validation {
    condition     = var.maintenance_hour >= 0 && var.maintenance_hour <= 23
    error_message = "Maintenance hour must be between 0 and 23."
  }
}

# -----------------------------------------------------------------------------
# Security Configuration
# -----------------------------------------------------------------------------

variable "require_ssl" {
  description = "Require SSL connections"
  type        = bool
  default     = true
}

variable "enable_connection_throttling" {
  description = "Enable connection throttling"
  type        = bool
  default     = true
}

variable "log_connections" {
  description = "Enable logging of connections"
  type        = bool
  default     = true
}

variable "log_disconnections" {
  description = "Enable logging of disconnections"
  type        = bool
  default     = true
}

# -----------------------------------------------------------------------------
# Network Configuration
# -----------------------------------------------------------------------------

variable "vnet_id" {
  description = "The resource ID of the VNet (for reference/documentation)"
  type        = string
  default     = null
}

variable "delegated_subnet_id" {
  description = "The resource ID of the delegated subnet where PostgreSQL will be deployed (must be delegated to Microsoft.DBforPostgreSQL/flexibleServers)"
  type        = string
  default     = null
}

variable "private_dns_zone_id" {
  description = "The resource ID of the private DNS zone (e.g., privatelink.postgres.database.azure.com)"
  type        = string
  default     = null
}

variable "postgresql_private_endpoint_subnet_id" {
  description = "Subnet ID for PostgreSQL private endpoint (use when server is NOT VNet-injected)"
  type        = string
  default     = null
}

variable "postgresql_pe_private_dns_zone_id" {
  description = "Private DNS zone ID for PostgreSQL private endpoint (privatelink.postgres.database.azure.com)"
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# Firewall Configuration
# -----------------------------------------------------------------------------

variable "enable_development_access" {
  description = "Allow all IP addresses (for development only) - Only applies when NOT using delegated subnet"
  type        = bool
  default     = false
}

variable "allowed_ip_start" {
  description = "Start IP address for allowed range (set both start and end to enable)"
  type        = string
  default     = null
}

variable "allowed_ip_end" {
  description = "End IP address for allowed range (set both start and end to enable)"
  type        = string
  default     = null
}

variable "custom_firewall_rules" {
  description = "Custom firewall rules as a map of name => {start_ip, end_ip}"
  type = map(object({
    start_ip = string
    end_ip   = string
  }))
  default = {}
}

# -----------------------------------------------------------------------------
# Extensions
# -----------------------------------------------------------------------------

variable "postgresql_extensions" {
  description = "List of PostgreSQL extensions to enable"
  type        = list(string)
  default     = ["UUID-OSSP", "PGCRYPTO"]
}

# =============================================================================
# PostgreSQL Generated Applications Server Configuration Variables
# =============================================================================
# Second PostgreSQL Flexible Server dedicated to per-project databases (proj_*)
# created dynamically by the API. Separates user-generated workloads from
# platform metadata for failure isolation and independent scaling.
# =============================================================================

variable "postgresql_genapps_database_name" {
  description = "Name of the default database on the Generated Applications PostgreSQL server."
  type        = string
  default     = "genapps_default"
}

variable "postgresql_genapps_server_name" {
  description = "Name of the PostgreSQL Flexible Server for Generated Applications"
  type        = string
}

variable "postgresql_genapps_administrator_login" {
  description = "Administrator login for the Generated Applications PostgreSQL server (distinct from app server)"
  type        = string
  default     = "pronghornGenAppsAdmin"
}

variable "postgresql_genapps_administrator_password" {
  description = "Break-glass override for the Generated Applications PostgreSQL admin password. Leave null (default) to use the generated write-only password seeded into Key Vault. When set, also bump postgresql_genapps_administrator_password_wo_version."
  type        = string
  sensitive   = true
  default     = null
}

variable "postgresql_genapps_administrator_password_wo_version" {
  description = "Version integer for the Generated Applications PostgreSQL write-only admin password. Increment to force the seeded/overridden password to be re-sent to the server."
  type        = number
  default     = 1
}

variable "postgresql_genapps_version" {
  description = "PostgreSQL version for the Generated Applications server"
  type        = string
  default     = "16"

  validation {
    condition     = contains(["14", "15", "16"], var.postgresql_genapps_version)
    error_message = "PostgreSQL version must be 14, 15, or 16."
  }
}

variable "postgresql_genapps_sku_name" {
  description = "SKU name for the Generated Applications PostgreSQL Flexible Server"
  type        = string
  default     = "B_Standard_B2s"
}

variable "postgresql_genapps_storage_mb" {
  description = "Storage size in MB for the Generated Applications PostgreSQL server"
  type        = number
  default     = 32768
}

variable "postgresql_genapps_disable_public_access" {
  description = "Disable public network access on the Generated Applications PostgreSQL server. Defaults to true (PBMM-safe). Set to false for dev environments without VNet/PE."
  type        = bool
  default     = true
}

variable "postgresql_genapps_private_endpoint_subnet_id" {
  description = "Subnet ID for the Generated Applications PostgreSQL private endpoint (use when server is NOT VNet-injected)"
  type        = string
  default     = null
}

variable "postgresql_genapps_pe_private_dns_zone_id" {
  description = "Private DNS zone ID for the Generated Applications PostgreSQL private endpoint (privatelink.postgres.database.azure.com)"
  type        = string
  default     = null
}

variable "postgresql_genapps_availability_zone" {
  description = "Availability zone for the Generated Applications PostgreSQL server. Stagger from app server to spread across zones."
  type        = string
  default     = "1"

  validation {
    condition     = contains(["1", "2", "3"], var.postgresql_genapps_availability_zone)
    error_message = "Availability zone must be 1, 2, or 3."
  }
}

# -----------------------------------------------------------------------------
# Generated Applications — High Availability
# -----------------------------------------------------------------------------

variable "postgresql_genapps_enable_high_availability" {
  description = "Enable zone-redundant high availability for the Generated Applications server"
  type        = bool
  default     = false
}

# -----------------------------------------------------------------------------
# Generated Applications — Backup
# -----------------------------------------------------------------------------

variable "postgresql_genapps_backup_retention_days" {
  description = "Backup retention days for the Generated Applications server"
  type        = number
  default     = 7

  validation {
    condition     = var.postgresql_genapps_backup_retention_days >= 7 && var.postgresql_genapps_backup_retention_days <= 35
    error_message = "Backup retention days must be between 7 and 35."
  }
}

variable "postgresql_genapps_geo_redundant_backup_enabled" {
  description = "Enable geo-redundant backup for the Generated Applications server"
  type        = bool
  default     = false
}

# -----------------------------------------------------------------------------
# Generated Applications — Maintenance Window
# -----------------------------------------------------------------------------

variable "postgresql_genapps_maintenance_day" {
  description = "Day of week for Generated Applications maintenance window (0=Sunday, 6=Saturday). Stagger from app server to avoid simultaneous downtime."
  type        = number
  default     = 3

  validation {
    condition     = var.postgresql_genapps_maintenance_day >= 0 && var.postgresql_genapps_maintenance_day <= 6
    error_message = "Maintenance day must be between 0 (Sunday) and 6 (Saturday)."
  }
}

variable "postgresql_genapps_maintenance_hour" {
  description = "Start hour for Generated Applications maintenance window (0-23 UTC). Stagger from app server to avoid simultaneous downtime."
  type        = number
  default     = 4

  validation {
    condition     = var.postgresql_genapps_maintenance_hour >= 0 && var.postgresql_genapps_maintenance_hour <= 23
    error_message = "Maintenance hour must be between 0 and 23."
  }
}

# =============================================================================
# Storage Configuration Variables
# =============================================================================

variable "storage_public_network_access" {
  description = "Enable public network access to storage account. Set to false for Landing Zone deployments with private endpoints."
  type        = bool
  default     = true
}

variable "storage_shared_access_key_enabled" {
  description = "Enable shared access key authentication for storage. Set to false for Landing Zone with RBAC-only access."
  type        = bool
  default     = true
}

variable "storage_private_endpoint_subnet_id" {
  description = "Subnet ID for Storage private endpoint. If provided, a private endpoint will be created. For Landing Zone deployments."
  type        = string
  default     = null
}

variable "storage_private_dns_zone_id" {
  description = "Private DNS Zone ID for Storage blob (privatelink.blob.core.windows.net). Required when using private endpoint."
  type        = string
  default     = null
}

# =============================================================================
# Tags and External Service Configuration Variables
# =============================================================================

# -----------------------------------------------------------------------------
# PBMM Landing Zone Tags
# -----------------------------------------------------------------------------

variable "client_organization" {
  description = "Client organization name for PBMM tagging"
  type        = string
  default     = ""
}

variable "cost_center" {
  description = "Cost center code for PBMM tagging"
  type        = string
  default     = ""
}

variable "data_sensitivity" {
  description = "Data sensitivity classification for PBMM tagging"
  type        = string
  default     = ""
}

variable "project_contact" {
  description = "Project contact email for PBMM tagging"
  type        = string
  default     = ""
}

variable "project_name_tag" {
  description = "Project name tag for PBMM tagging (distinct from project_name used in resource naming)"
  type        = string
  default     = ""
}

variable "technical_contact" {
  description = "Technical contact email for PBMM tagging"
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# External Service Keys
# -----------------------------------------------------------------------------

variable "render_api_key" {
  description = "Render API key for deployment operations"
  type        = string
  sensitive   = true
  default     = ""
}

variable "render_owner_id" {
  description = "Render owner ID for deployment operations"
  type        = string
  sensitive   = true
  default     = ""
}

# -----------------------------------------------------------------------------
# Tags
# -----------------------------------------------------------------------------

variable "extra_tags" {
  description = "Additional tags to apply to resources"
  type        = map(string)
  default     = {}
}
