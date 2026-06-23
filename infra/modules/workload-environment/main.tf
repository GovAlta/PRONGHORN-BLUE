# =============================================================================
# Workload Environment Module (AVM Wrapper)
# =============================================================================
# Wraps Azure Verified Module for Container App Managed Environment:
# - avm-res-app-managedenvironment v0.4.0
#
# Creates a dedicated Container App Environment for user-deployed workloads,
# isolated from the platform environment (API + frontend).
# No Container Apps are created here — they are deployed dynamically by the API.
# =============================================================================

locals {
  common_tags = merge(var.tags, {
    Module = "workload-environment"
  })
}

# -----------------------------------------------------------------------------
# Workload Container App Environment (AVM)
# WARNING: Do not change infrastructure_subnet_id in-place. The ACA RP caches
# subnet-to-environment associations; destroying and recreating on a different
# subnet in a single apply will fail with ManagedEnvironmentSubnetInUse.
# Split into two applies (destroy first, then create) or wait ~1 hour for
# the RP cache to clear. Open a Microsoft support ticket if blocked longer.
# -----------------------------------------------------------------------------

module "workload_environment" {
  source  = "Azure/avm-res-app-managedenvironment/azurerm"
  version = "0.4.0"

  name                = var.environment_name
  location            = var.location
  resource_group_name = var.resource_group_name

  # Pin parent_id to avoid data source staleness with -refresh=false
  parent_id = "/subscriptions/${var.subscription_id}/resourceGroups/${var.resource_group_name}"

  # Log Analytics — always pass the object to avoid count/known-after-apply issues
  # in the AVM module. The workspace_id is always provided (logging module is always created).
  log_analytics_workspace = {
    resource_id = var.log_analytics_workspace_id
  }

  # VNet Integration
  infrastructure_subnet_id       = var.infrastructure_subnet_id
  internal_load_balancer_enabled = var.infrastructure_subnet_id != null ? var.internal_load_balancer_enabled : false

  # Zone redundancy disabled to match previous behavior
  zone_redundancy_enabled = false

  enable_telemetry = false
  tags             = local.common_tags
}

# -----------------------------------------------------------------------------
# Private Endpoint (external to AVM — managed environment AVM doesn't support PEs)
# -----------------------------------------------------------------------------

resource "azurerm_private_endpoint" "workload" {
  count               = var.private_endpoint_subnet_id != null ? 1 : 0
  name                = "${var.environment_name}-pe"
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = var.private_endpoint_subnet_id

  private_service_connection {
    name                           = "${var.environment_name}-psc"
    private_connection_resource_id = module.workload_environment.resource_id
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
