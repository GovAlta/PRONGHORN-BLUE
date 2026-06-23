# =============================================================================
# Container Apps Module (AVM Wrapper)
# =============================================================================
# This module wraps Azure Verified Modules:
# - avm-res-app-managedenvironment v0.4.0 (conditional environment creation)
# - avm-res-app-containerapp v0.9.0 (container app)
#
# Features:
# - Conditional environment creation or use of existing
# - Container app with lifecycle-managed template (CI/CD safe)
# - Private endpoint for environment (PBMM pattern)
# - Certificate management
# =============================================================================

# -----------------------------------------------------------------------------
# Container App Environment (AVM) — only when not using existing
# -----------------------------------------------------------------------------

module "managed_environment" {
  count   = var.existing_environment_id == null ? 1 : 0
  source  = "Azure/avm-res-app-managedenvironment/azurerm"
  version = "0.4.0"

  name                = var.environment_name
  location            = var.location
  resource_group_name = var.environment_resource_group_name != null ? var.environment_resource_group_name : var.resource_group_name

  # Pin parent_id to avoid data source staleness with -refresh=false
  parent_id = local.environment_resource_group_id

  # Log Analytics — always pass the object to avoid count/known-after-apply issues
  # in the AVM module. The workspace_id is always provided (logging module is always created).
  log_analytics_workspace = {
    resource_id = var.log_analytics_workspace_id
  }

  # VNet Integration
  infrastructure_subnet_id       = var.infrastructure_subnet_id
  internal_load_balancer_enabled = var.infrastructure_subnet_id != null ? var.internal_load_balancer_enabled : false

  # Certificates
  certificates = { for k, v in var.certificates : k => {
    certificate_password = v.certificate_password
    certificate_value    = v.certificate_blob_base64
  } }

  # Zone redundancy disabled to match previous behavior
  zone_redundancy_enabled = false

  enable_telemetry = false
  tags             = local.common_tags
}

# -----------------------------------------------------------------------------
# Container App Environment Private Endpoint (external to AVM)
# AVM managed environment module does not support private endpoints directly.
# -----------------------------------------------------------------------------

resource "azurerm_private_endpoint" "environment" {
  count               = var.existing_environment_id == null && var.environment_private_endpoint_subnet_id != null ? 1 : 0
  name                = "${var.environment_name}-pe"
  location            = var.location
  resource_group_name = var.environment_resource_group_name != null ? var.environment_resource_group_name : var.resource_group_name
  subnet_id           = var.environment_private_endpoint_subnet_id

  private_service_connection {
    name                           = "${var.environment_name}-psc"
    private_connection_resource_id = module.managed_environment[0].resource_id
    is_manual_connection           = false
    subresource_names              = ["managedEnvironments"]
  }
  tags = local.common_tags

  # GoA PBMM: A DeployIfNotExists policy attaches a privateDnsZoneGroup after
  # PE creation. Ignore it so Terraform doesn't force-replace the endpoint.
  lifecycle {
    ignore_changes = [private_dns_zone_group]
  }
}

# -----------------------------------------------------------------------------
# Container App (AVM)
# The AVM module uses azapi_resource internally and ignores
# body.properties.template changes, making it safe for CI/CD-deployed
# image/env/secret updates.
# -----------------------------------------------------------------------------

module "container_app" {
  source  = "Azure/avm-res-app-containerapp/azurerm"
  version = "0.9.0"

  name                                  = var.container_app_name
  resource_group_name                   = var.resource_group_name
  container_app_environment_resource_id = local.container_app_environment_id

  # Pin location explicitly to avoid ForceNew on azapi_resource (computed from data source = known after apply)
  location = var.location

  # Pin resource_group_id to avoid data source staleness with -refresh=false
  resource_group_id = local.resource_group_id

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
        env    = local.container_env

        liveness_probes = var.liveness_probe != null ? [{
          path             = var.liveness_probe.path
          port             = var.liveness_probe.port
          transport        = var.liveness_probe.transport
          interval_seconds = var.liveness_probe.interval_seconds
        }] : null

        readiness_probes = var.readiness_probe != null ? [{
          path             = var.readiness_probe.path
          port             = var.readiness_probe.port
          transport        = var.readiness_probe.transport
          interval_seconds = var.readiness_probe.interval_seconds
        }] : null
      }
    ]
  }

  # Secrets
  secrets = local.secrets_map

  # Ingress
  ingress = var.enable_ingress ? {
    external_enabled = var.external_ingress
    target_port      = var.target_port
    transport        = var.ingress_transport
    traffic_weight = [{
      percentage      = 100
      latest_revision = true
    }]
  } : null

  # Container Registry
  registries = local.registries

  enable_telemetry = false
  tags             = local.common_tags
}
