# =============================================================================
# Terraform Configuration
# =============================================================================

terraform {
  required_version = ">= 1.9"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 3.0"
    }
    azapi = {
      source  = "azure/azapi"
      version = "~> 2.4"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.5"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.12"
    }
    modtm = {
      source  = "azure/modtm"
      version = "~> 0.3"
    }
  }

  backend "azurerm" {}
}

# -----------------------------------------------------------------------------
# Provider Configuration
# -----------------------------------------------------------------------------

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id

  # Use Azure AD authentication for storage data plane operations
  # Required when shared_access_key is disabled on storage accounts (Landing Zone requirement)
  storage_use_azuread = true
}

# -----------------------------------------------------------------------------
# Aliased provider for the central Private DNS subscription (PBMM hub / vWAN).
# Used by data "azurerm_private_dns_zone" lookups in locals.tf to reference
# existing central privatelink.* zones without creating them.
# When central_dns_subscription_id is empty, this falls back to the main sub,
# but the data sources are count-guarded so no lookup is attempted.
# -----------------------------------------------------------------------------
provider "azurerm" {
  alias = "central_dns"
  features {}
  subscription_id     = var.central_dns_subscription_id != "" ? var.central_dns_subscription_id : var.subscription_id
  storage_use_azuread = true
}
