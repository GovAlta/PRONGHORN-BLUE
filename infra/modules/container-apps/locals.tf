# =============================================================================
# Container Apps Module Local Values
# =============================================================================

locals {
  # Common tags applied to all resources
  common_tags = merge(var.tags, {
    Module = "container-apps"
  })

  # Stable resource group ID constructed from known values (avoids data source staleness with -refresh=false)
  resource_group_id             = "/subscriptions/${var.subscription_id}/resourceGroups/${var.resource_group_name}"
  environment_resource_group_id = var.environment_resource_group_name != null ? "/subscriptions/${var.subscription_id}/resourceGroups/${var.environment_resource_group_name}" : local.resource_group_id

  # Determine the environment ID to use (existing or newly created)
  container_app_environment_id = var.existing_environment_id != null ? var.existing_environment_id : module.managed_environment[0].resource_id

  # Container environment variables (merge plain + secret refs into single list)
  container_env = length(var.environment_variables) > 0 || length(var.secret_environment_variables) > 0 ? concat(
    [for k, v in var.environment_variables : {
      name  = k
      value = v
    }],
    [for k, v in var.secret_environment_variables : {
      name        = k
      secret_name = v
    }]
  ) : null

  # Transform secrets into AVM format. Two sources are merged:
  # - var.secrets: plaintext values stored directly on the Container App.
  # - var.secret_key_vault_references: Key Vault references resolved at runtime
  #   using var.secret_identity_id (a user-assigned managed identity resource ID).
  secrets_map = (length(var.secrets) > 0 || length(var.secret_key_vault_references) > 0) ? merge(
    { for k, v in var.secrets : k => {
      name  = k
      value = v
    } },
    { for k, v in var.secret_key_vault_references : k => {
      name                = k
      key_vault_secret_id = v.key_vault_secret_id
      identity            = var.secret_identity_id
    } }
  ) : null

  # Container registry configuration
  registries = var.registry_server != null ? (
    var.use_managed_identity_for_acr ? [
      {
        server   = var.registry_server
        identity = var.user_assigned_identity_id != null ? var.user_assigned_identity_id : "System"
      }
      ] : [
      {
        server               = var.registry_server
        username             = var.registry_username
        password_secret_name = var.registry_password_secret_name
      }
    ]
  ) : null
}
