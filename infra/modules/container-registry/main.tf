# =============================================================================
# Container Registry Module (AVM Wrapper)
# =============================================================================
# This module wraps Azure Verified Module for Container Registry:
# - avm-res-containerregistry-registry
# =============================================================================

# -----------------------------------------------------------------------------
# Container Registry (AVM)
# -----------------------------------------------------------------------------

module "acr" {
  source  = "Azure/avm-res-containerregistry-registry/azurerm"
  version = "0.5.1"

  name                          = var.registry_name
  resource_group_name           = var.resource_group_name
  location                      = var.location
  sku                           = var.sku
  admin_enabled                 = var.admin_enabled
  public_network_access_enabled = var.public_network_access_enabled
  zone_redundancy_enabled       = false

  # Geo-replication (Premium SKU only)
  georeplications = var.sku == "Premium" ? var.georeplications : []

  # Private Endpoint (conditionally created when subnet_id is provided)
  private_endpoints = var.private_endpoint_subnet_id != null ? {
    registry = {
      subnet_resource_id            = var.private_endpoint_subnet_id
      private_dns_zone_resource_ids = var.private_dns_zone_id != null ? [var.private_dns_zone_id] : []
      location                      = var.private_endpoint_location
      resource_group_name           = var.private_endpoint_resource_group_name
    }
  } : {}

  # GoA PBMM: DNS zone group managed externally by Azure Policy
  private_endpoints_manage_dns_zone_group = false

  enable_telemetry = false
  tags             = local.common_tags
}
