# =============================================================================
# Key Vault Module (AVM Wrapper)
# =============================================================================
# This module wraps Azure Verified Module for Key Vault:
# - avm-res-keyvault-vault
# =============================================================================

data "azurerm_client_config" "current" {}

# -----------------------------------------------------------------------------
# Key Vault (AVM)
# -----------------------------------------------------------------------------

module "keyvault" {
  source  = "Azure/avm-res-keyvault-vault/azurerm"
  version = "0.10.2"

  name                = var.key_vault_name
  location            = var.location
  resource_group_name = var.resource_group_name
  tenant_id           = data.azurerm_client_config.current.tenant_id

  sku_name                      = var.sku_name
  soft_delete_retention_days    = var.soft_delete_retention_days
  purge_protection_enabled      = var.purge_protection_enabled
  public_network_access_enabled = var.public_network_access_enabled

  # Network ACLs
  network_acls = {
    bypass                     = "AzureServices"
    default_action             = var.network_default_action
    ip_rules                   = var.allowed_ip_ranges
    virtual_network_subnet_ids = var.allowed_subnet_ids
  }

  # Azure RBAC for data-plane access. Legacy (vault) access policies are
  # disabled — access is granted exclusively via role assignments below.
  legacy_access_policies_enabled = false

  # Role assignments (Azure RBAC, data-plane):
  # - deployer  → "Key Vault Secrets Officer" so the running principal can
  #   create/update the secrets defined below.
  # - each principal in `secrets_user_principal_ids` → "Key Vault Secrets User"
  #   (read-only) so managed identities (e.g. the API container app) can
  #   resolve Key Vault references at runtime.
  role_assignments = merge(
    {
      deployer = {
        role_definition_id_or_name = "Key Vault Secrets Officer"
        principal_id               = data.azurerm_client_config.current.object_id
      }
    },
    { for idx, principal_id in var.secrets_user_principal_ids : "secrets_user_${idx}" => {
      role_definition_id_or_name = "Key Vault Secrets User"
      principal_id               = principal_id
      principal_type             = "ServicePrincipal"
    } }
  )

  # Secrets are created externally (below) with a time_sleep to allow
  # RBAC role assignment propagation. Do not pass secrets to the AVM module.

  # Private Endpoint (conditionally created when subnet_id is provided)
  private_endpoints = var.private_endpoint_subnet_id != null ? {
    vault = {
      subnet_resource_id            = var.private_endpoint_subnet_id
      private_dns_zone_resource_ids = var.private_dns_zone_id != null ? [var.private_dns_zone_id] : []
    }
  } : {}

  # GoA PBMM: DNS zone group managed externally by Azure Policy
  private_endpoints_manage_dns_zone_group = false

  enable_telemetry = false
  tags             = local.common_tags
}

# -----------------------------------------------------------------------------
# Wait for RBAC role assignment propagation before creating secrets
# Azure RBAC role assignments can take up to ~60 seconds to propagate. Without
# this delay, secret creation fails with 403 Forbidden on first deploy because
# the deployer's "Key Vault Secrets Officer" role is not yet effective.
# -----------------------------------------------------------------------------

resource "time_sleep" "wait_for_access_policy" {
  depends_on      = [module.keyvault]
  create_duration = "60s"
}

# -----------------------------------------------------------------------------
# Wait for Azure Policy to attach the DNS zone group to the Key Vault private
# endpoint (PBMM / GoA landing zones).
#
# In these environments a DeployIfNotExists policy asynchronously creates the
# "default" privateDnsZoneGroup on the private endpoint a few minutes after the
# PE is created (the AVM module sets private_endpoints_manage_dns_zone_group =
# false). Until that A-record exists, the vault's privatelink FQDN does not
# resolve, so the data-plane secret writes below fail when public network access
# is disabled.
#
# This data source polls natively via azapi's retry-on-404 until the zone group
# is attached (or the read timeout elapses), replacing the external
# Wait-ForDnsZoneGroup.ps1 poll script with pure Terraform. The zone-group name
# "default" is the deterministic name assigned by the GoA policy.
# -----------------------------------------------------------------------------

data "azapi_resource" "pe_dns_zone_group" {
  count = var.private_endpoint_subnet_id != null && var.private_endpoint_dns_wait.enabled ? 1 : 0

  type      = "Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01"
  parent_id = module.keyvault.private_endpoints["vault"].id
  name      = "default"

  retry = {
    error_message_regex  = ["ResourceNotFound", "NotFound", "was not found"]
    interval_seconds     = 10
    max_interval_seconds = 30
  }

  timeouts {
    read = var.private_endpoint_dns_wait.timeout
  }
}

# -----------------------------------------------------------------------------
# Key Vault Secrets (created externally to allow access policy propagation)
# -----------------------------------------------------------------------------

resource "azurerm_key_vault_secret" "secrets" {
  for_each = nonsensitive(toset(keys(var.secrets)))

  name         = each.key
  value        = var.secrets[each.key]
  key_vault_id = module.keyvault.resource_id
  content_type = "text/plain"

  # Gate on both RBAC propagation and (in PBMM) Policy DNS zone-group attachment
  # so first-deploy secret writes never race ahead of private DNS registration.
  depends_on = [
    time_sleep.wait_for_access_policy,
    data.azapi_resource.pe_dns_zone_group,
  ]
}
