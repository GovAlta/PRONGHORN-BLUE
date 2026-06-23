# =============================================================================
# Storage Module (AVM Wrapper)
# =============================================================================
# This module wraps Azure Verified Module for Storage Account:
# - avm-res-storage-storageaccount (core account + private endpoint)
# Containers, CORS, and DNS wait are managed externally for GoA PBMM compat.
# =============================================================================

data "azurerm_client_config" "current" {}

# -----------------------------------------------------------------------------
# Storage Account (AVM)
# -----------------------------------------------------------------------------

module "storage_account" {
  source  = "Azure/avm-res-storage-storageaccount/azurerm"
  version = "0.7.0"

  name      = var.storage_account_name
  location  = var.location
  parent_id = "/subscriptions/${var.subscription_id}/resourceGroups/${var.resource_group_name}"

  account_sku_name                = "${var.account_tier}_${var.replication_type}"
  min_tls_version                 = var.min_tls_version
  shared_access_key_enabled       = var.shared_access_key_enabled
  allow_nested_items_to_be_public = var.allow_public_blobs
  public_network_access_enabled   = var.public_network_access_enabled

  # No network rules to match existing behavior (allow all by default)
  network_rules = null

  # Private Endpoint
  private_endpoints = var.private_endpoint_subnet_id != null ? {
    blob = {
      subnet_resource_id            = var.private_endpoint_subnet_id
      subresource_name              = "blob"
      private_dns_zone_resource_ids = var.private_dns_zone_id != null ? [var.private_dns_zone_id] : []
    }
  } : {}

  # GoA PBMM: DNS zone group managed externally by Azure Policy
  private_endpoints_manage_dns_zone_group = false

  enable_telemetry = false
  tags             = local.common_tags
}

# -----------------------------------------------------------------------------
# Data source to read connection string and access key
# (AVM uses azapi internally; sensitive keys require listKeys API)
# -----------------------------------------------------------------------------

data "azurerm_storage_account" "main" {
  name                = var.storage_account_name
  resource_group_name = var.resource_group_name

  depends_on = [module.storage_account]
}

# -----------------------------------------------------------------------------
# Role Assignment for Azure AD Access
# -----------------------------------------------------------------------------

resource "azurerm_role_assignment" "storage_blob_contributor" {
  count                = var.enable_deployer_blob_access ? 1 : 0
  scope                = module.storage_account.resource_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_client_config.current.object_id
}

# -----------------------------------------------------------------------------
# CORS Rules (applied via azapi since AVM doesn't expose them directly)
# -----------------------------------------------------------------------------

resource "azapi_update_resource" "blob_cors" {
  count     = length(var.cors_rules) > 0 ? 1 : 0
  type      = "Microsoft.Storage/storageAccounts/blobServices@2023-05-01"
  name      = "default"
  parent_id = module.storage_account.resource_id

  body = {
    properties = {
      cors = {
        corsRules = [for rule in var.cors_rules : {
          allowedHeaders  = rule.allowed_headers
          allowedMethods  = rule.allowed_methods
          allowedOrigins  = rule.allowed_origins
          exposedHeaders  = rule.exposed_headers
          maxAgeInSeconds = rule.max_age_in_seconds
        }]
      }
    }
  }
}

# -----------------------------------------------------------------------------
# Storage Containers
# -----------------------------------------------------------------------------

# Wait for central Private DNS registration to complete before creating
# containers. In GoA PBMM the privatelink zone A-records are auto-registered
# on a ~15-minute schedule; container creation uses the blob data-plane
# endpoint, so DNS must resolve to the PE private IP first. Set
# dns_registration_wait_minutes = 0 to skip (e.g. when running from a network
# that can still reach the public blob endpoint).
resource "time_sleep" "wait_for_dns_registration" {
  count = var.private_endpoint_subnet_id != null && var.dns_registration_wait_minutes > 0 ? 1 : 0

  create_duration = "${var.dns_registration_wait_minutes}m"

  depends_on = [module.storage_account]
}

resource "azurerm_storage_container" "containers" {
  for_each = var.containers

  name                  = each.key
  storage_account_name  = module.storage_account.name
  container_access_type = each.value.access_type

  depends_on = [
    azurerm_role_assignment.storage_blob_contributor,
    module.storage_account,
    time_sleep.wait_for_dns_registration,
  ]
}
