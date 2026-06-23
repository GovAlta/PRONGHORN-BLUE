# =============================================================================
# Frontend Module Local Values
# =============================================================================

locals {
  # Common tags applied to all resources
  common_tags = merge(var.tags, {
    Module = "frontend"
  })

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
