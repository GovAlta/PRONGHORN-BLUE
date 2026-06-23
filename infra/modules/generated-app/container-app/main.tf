terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.12"
    }
  }
}

resource "azurerm_user_assigned_identity" "this" {
  name                = "uami-${var.app_name}"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                = var.acr_id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.this.principal_id
}

# ---------------------------------------------------------------------------
# Per-deployment Key Vault (env vars + user secrets)
#
# The backend creates/owns this vault in a shared platform resource group and
# writes every env-var / secret VALUE into it. Terraform only CONSUMES it: it
# enumerates the secrets, grants the container's user-assigned identity read
# access, and wires each secret into the container as a `secretRef` env var.
# The original env-var NAME is carried on each secret's `envName` tag.
# ---------------------------------------------------------------------------
locals {
  kv_enabled = var.key_vault_name != ""
}

data "azurerm_key_vault" "genapp" {
  count               = local.kv_enabled ? 1 : 0
  name                = var.key_vault_name
  resource_group_name = var.key_vault_resource_group
}

data "azurerm_key_vault_secrets" "genapp" {
  count        = local.kv_enabled ? 1 : 0
  key_vault_id = data.azurerm_key_vault.genapp[0].id
}

data "azurerm_key_vault_secret" "genapp" {
  for_each     = local.kv_enabled ? toset(data.azurerm_key_vault_secrets.genapp[0].names) : toset([])
  name         = each.value
  key_vault_id = data.azurerm_key_vault.genapp[0].id
}

# Grant the container's managed identity read access to the vault so the ACA
# revision can resolve the `secretRef` values at runtime.
resource "azurerm_role_assignment" "kv_secrets_user" {
  count                = local.kv_enabled ? 1 : 0
  scope                = data.azurerm_key_vault.genapp[0].id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.this.principal_id
}

# Azure RBAC is eventually consistent: a freshly created role assignment can
# take up to a few minutes to propagate. Without this pause the Container App
# revision may come up before the identity can read the vault and fail to
# resolve its `secretRef` values. Wait after the grant before creating the app.
resource "time_sleep" "wait_for_kv_rbac" {
  count           = local.kv_enabled ? 1 : 0
  depends_on      = [azurerm_role_assignment.kv_secrets_user]
  create_duration = "120s"
}

resource "azurerm_container_app" "this" {
  name                         = var.app_name
  container_app_environment_id = var.container_app_environment_id
  resource_group_name          = var.resource_group_name
  revision_mode                = "Single"
  tags                         = var.tags

  identity {
    type         = "SystemAssigned, UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.this.id]
  }

  registry {
    server   = var.acr_login_server
    identity = azurerm_user_assigned_identity.this.id
  }

  # One Container App secret per Key Vault secret, resolved via the container's
  # user-assigned identity (versionless id => always the latest version).
  dynamic "secret" {
    for_each = data.azurerm_key_vault_secret.genapp
    content {
      name                = secret.value.name
      key_vault_secret_id = secret.value.versionless_id
      identity            = azurerm_user_assigned_identity.this.id
    }
  }

  template {
    min_replicas = var.min_replicas
    max_replicas = var.max_replicas

    container {
      name   = var.app_name
      image  = var.image != "" ? var.image : "${var.acr_login_server}/${var.image_name}:${var.image_tag}"
      cpu    = var.cpu
      memory = var.memory

      # Plaintext (non-secret) environment variables.
      dynamic "env" {
        for_each = var.environment_variables
        content {
          name  = env.key
          value = env.value
        }
      }

      # Key Vault-backed environment variables. The exposed name comes from the
      # secret's `envName` tag; the value is referenced from the Container App
      # secret created above.
      dynamic "env" {
        for_each = data.azurerm_key_vault_secret.genapp
        content {
          name        = lookup(env.value.tags, "envName", env.value.name)
          secret_name = env.value.name
        }
      }
    }
  }

  ingress {
    external_enabled = true
    target_port      = var.target_port
    transport        = "auto"

    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  depends_on = [
    azurerm_role_assignment.acr_pull,
    azurerm_role_assignment.kv_secrets_user,
    time_sleep.wait_for_kv_rbac,
  ]
}
