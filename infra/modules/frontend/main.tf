# =============================================================================
# Frontend Container App Module (AVM Wrapper)
# =============================================================================
# Wraps Azure Verified Module for Container App:
# - avm-res-app-containerapp v0.9.0
#
# Uses an existing Container App Environment.
# The AVM module internally ignores body.properties.template changes,
# making it safe for CI/CD-deployed image/env/secret updates.
# =============================================================================

# -----------------------------------------------------------------------------
# Frontend Container App (AVM)
# -----------------------------------------------------------------------------

module "frontend" {
  source  = "Azure/avm-res-app-containerapp/azurerm"
  version = "0.9.0"

  name                                  = var.container_app_name
  resource_group_name                   = var.resource_group_name
  container_app_environment_resource_id = var.container_app_environment_id

  # Pin location explicitly to avoid ForceNew on azapi_resource (computed from data source = known after apply)
  location = var.location

  # Pin resource_group_id to avoid data source staleness with -refresh=false
  resource_group_id = "/subscriptions/${var.subscription_id}/resourceGroups/${var.resource_group_name}"

  revision_mode = var.revision_mode

  # Managed identity: always system-assigned, plus optional user-assigned for ACR
  managed_identities = {
    system_assigned            = true
    user_assigned_resource_ids = var.user_assigned_identity_id != null ? toset([var.user_assigned_identity_id]) : toset([])
  }

  # Template — AVM internally ignores body.properties.template changes (CI/CD safe)
  template = {
    min_replicas = var.min_replicas
    max_replicas = var.max_replicas
    containers = [
      {
        name   = var.container_name
        image  = var.container_image
        cpu    = var.container_cpu
        memory = var.container_memory
        env = length(var.environment_variables) > 0 ? [
          for k, v in var.environment_variables : {
            name  = k
            value = v
          }
        ] : null
      }
    ]
  }

  # Secrets
  secrets = length(var.secrets) > 0 ? { for k, v in var.secrets : k => {
    name  = k
    value = v
  } } : null

  # Ingress — always external for frontend
  ingress = {
    external_enabled = true
    target_port      = var.target_port
    transport        = "http"
    traffic_weight = [{
      percentage      = 100
      latest_revision = true
    }]
  }

  # Container Registry
  registries = local.registries

  enable_telemetry = false
  tags             = local.common_tags
}
