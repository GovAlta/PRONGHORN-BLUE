# =============================================================================
# Key Vault Module Local Values
# =============================================================================

locals {
  # Common tags applied to all resources
  common_tags = merge(var.tags, {
    Module = "keyvault"
  })
}
