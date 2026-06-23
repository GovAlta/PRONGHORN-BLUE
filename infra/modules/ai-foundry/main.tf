# =============================================================================
# Azure AI Foundry Module (New Project-Based Architecture)
# =============================================================================
# Uses the NEW Microsoft Foundry platform with Projects.
# Creates:
#   - AI Services Account (Foundry Resource) with allowProjectManagement
#   - Foundry Project (child resource)
#   - Capability Hosts for Agent service
#   - Model Deployments under the account
#
# API Version: 2025-04-01-preview
# Documentation: https://learn.microsoft.com/azure/ai-foundry/
# =============================================================================

terraform {
  required_providers {
    azapi = {
      source  = "azure/azapi"
      version = "~> 2.0"
    }
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

# Get current subscription info
data "azurerm_client_config" "current" {}

# Backward-compatible DNS zone ID resolution:
# Prefer the new list variable; fall back to wrapping the single-ID variable.
locals {
  effective_dns_zone_ids = var.private_dns_zone_ids != null ? var.private_dns_zone_ids : (
    var.private_dns_zone_id != null ? [var.private_dns_zone_id] : null
  )
}

# =============================================================================
# AI Services Account (Foundry Resource)
# =============================================================================
# This is the parent resource that manages projects, deployments, and capabilities.
# =============================================================================

resource "azapi_resource" "ai_services" {
  type      = "Microsoft.CognitiveServices/accounts@2025-04-01-preview"
  name      = var.ai_services_name
  location  = var.location
  parent_id = "/subscriptions/${var.subscription_id}/resourceGroups/${var.resource_group_name}"

  identity {
    type = "SystemAssigned"
  }

  body = {
    kind = "AIServices"
    sku = {
      name = var.sku_name
    }
    properties = {
      allowProjectManagement = true # Required for Foundry Projects
      customSubDomainName    = var.ai_services_name
      publicNetworkAccess    = var.public_network_access ? "Enabled" : "Disabled"
      disableLocalAuth       = var.disable_local_auth
      networkAcls = {
        defaultAction       = var.private_endpoint_subnet_id != null ? "Deny" : "Allow"
        virtualNetworkRules = []
        ipRules             = []
      }
    }
  }

  tags = var.tags

  response_export_values = ["*"]
}

# =============================================================================
# Foundry Project (Child Resource)
# =============================================================================
# A project organizes your AI development work. It's a child of the AI Services account.
# =============================================================================

resource "azapi_resource" "project" {
  type      = "Microsoft.CognitiveServices/accounts/projects@2025-04-01-preview"
  name      = var.project_name
  location  = var.location
  parent_id = azapi_resource.ai_services.id

  identity {
    type = "SystemAssigned"
  }

  body = {
    properties = {
      description = var.project_description
      displayName = var.project_display_name != "" ? var.project_display_name : var.project_name
    }
  }

  response_export_values = ["*"]

  depends_on = [azapi_resource.ai_services]
}

# =============================================================================
# Account Capability Host (for Agent Service)
# =============================================================================
# Enables the Agent service at the account level.
# =============================================================================

resource "azapi_resource" "account_capability_host" {
  count = var.enable_agent_service ? 1 : 0

  type      = "Microsoft.CognitiveServices/accounts/capabilityHosts@2025-04-01-preview"
  name      = "${var.ai_services_name}-capHost"
  parent_id = azapi_resource.ai_services.id

  schema_validation_enabled = false # Preview API, schema may not be accurate

  body = {
    properties = {
      capabilityHostKind = "Agents"
    }
  }

  depends_on = [azapi_resource.project]
}

# =============================================================================
# Project Capability Host (for Agent Service at Project Level)
# =============================================================================
# Enables the Agent service for the specific project.
# =============================================================================

resource "azapi_resource" "project_capability_host" {
  count = var.enable_agent_service ? 1 : 0

  type      = "Microsoft.CognitiveServices/accounts/projects/capabilityHosts@2025-04-01-preview"
  name      = "${var.project_name}-capHost"
  parent_id = azapi_resource.project.id

  schema_validation_enabled = false # Preview API, schema may not be accurate

  body = {
    properties = {
      capabilityHostKind    = "Agents"
      aiServicesConnections = []
    }
  }

  depends_on = [azapi_resource.account_capability_host]
}

# =============================================================================
# Model Deployments (under Account)
# =============================================================================
# Deploys AI models to the AI Services account.
# Azure Cognitive Services only allows one deployment operation at a time per
# account (409 RequestConflict). Split into first + rest to force sequential
# execution — Terraform cannot self-reference count instances.
# =============================================================================

resource "azapi_resource" "model_deployment_first" {
  count = length(var.model_deployments) > 0 ? 1 : 0

  type      = "Microsoft.CognitiveServices/accounts/deployments@2025-04-01-preview"
  name      = var.model_deployments[0].deployment_name
  parent_id = azapi_resource.ai_services.id

  body = {
    sku = {
      name     = var.model_deployments[0].sku_name
      capacity = var.model_deployments[0].sku_capacity
    }
    properties = {
      model = {
        format  = var.model_deployments[0].model_format
        name    = var.model_deployments[0].model_name
        version = var.model_deployments[0].model_version
      }
      raiPolicyName        = var.model_deployments[0].rai_policy_name
      versionUpgradeOption = var.model_deployments[0].version_upgrade_option
    }
  }

  depends_on = [azapi_resource.ai_services]

  response_export_values = ["*"]
}

resource "azapi_resource" "model_deployment_rest" {
  for_each = {
    for idx, d in slice(var.model_deployments, 1, length(var.model_deployments)) :
    d.deployment_name => d
  }

  type      = "Microsoft.CognitiveServices/accounts/deployments@2025-04-01-preview"
  name      = each.value.deployment_name
  parent_id = azapi_resource.ai_services.id

  body = {
    sku = {
      name     = each.value.sku_name
      capacity = each.value.sku_capacity
    }
    properties = {
      model = {
        format  = each.value.model_format
        name    = each.value.model_name
        version = each.value.model_version
      }
      raiPolicyName        = each.value.rai_policy_name
      versionUpgradeOption = each.value.version_upgrade_option
    }
  }

  # Wait for the first deployment to complete before starting any others
  depends_on = [azapi_resource.model_deployment_first]

  response_export_values = ["*"]
}

# =============================================================================
# Private Endpoint for AI Services
# =============================================================================
# Enables APIM and other VNet resources to reach AI Foundry over Private Link
# instead of traversing the public internet. The PE lives in the VNet region
# (canadacentral) and connects cross-region to AI Foundry (canadaeast).
# =============================================================================

resource "azurerm_private_endpoint" "ai_services" {
  count               = var.private_endpoint_subnet_id != null ? 1 : 0
  name                = "${var.ai_services_name}-pe"
  location            = var.private_endpoint_location != null ? var.private_endpoint_location : var.location
  resource_group_name = var.resource_group_name
  subnet_id           = var.private_endpoint_subnet_id

  private_service_connection {
    name                           = "${var.ai_services_name}-psc"
    private_connection_resource_id = azapi_resource.ai_services.id
    subresource_names              = ["account"]
    is_manual_connection           = false
  }
  tags = var.tags

  # Azure CognitiveServices accounts permit only one operation at a time. The PE
  # create issues an account-level write, so it must wait until every other
  # account operation (project, capability hosts, model deployments) has settled.
  # Otherwise the account is still in a transitional "Accepted" state and the PE
  # create fails with AccountProvisioningStateInvalid, aborting the whole apply.
  depends_on = [
    azapi_resource.ai_services,
    azapi_resource.project,
    azapi_resource.account_capability_host,
    azapi_resource.project_capability_host,
    azapi_resource.model_deployment_first,
    azapi_resource.model_deployment_rest,
  ]

  # GoA PBMM: A DeployIfNotExists policy attaches a privateDnsZoneGroup after
  # PE creation. Ignore it so Terraform doesn't force-replace the endpoint.
  lifecycle {
    ignore_changes = [private_dns_zone_group]
  }
}
