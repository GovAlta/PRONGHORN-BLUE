locals {
  # Resource names are computed once by the Pronghorn API
  # (computeGenappResourceNames) and passed in via var.app_name /
  # var.resource_group so they match exactly what is persisted in the DB and
  # used by the deploy workflow. Do NOT recompose them here.
  rg_name = var.resource_group

  common_tags = merge({
    environment     = var.environment
    managed_by      = "pronghorn"
    app_id          = var.app_id
    app_name        = var.app_name
    deployment_type = "generated-app"
  }, var.compliance_tags)
}

module "resource_group" {
  source = "../modules/generated-app/resource-group"

  name     = local.rg_name
  location = var.location
  tags     = local.common_tags
}

module "container_app" {
  source = "../modules/generated-app/container-app"

  app_name                     = var.app_name
  resource_group_name          = module.resource_group.name
  location                     = module.resource_group.location
  container_app_environment_id = var.container_app_environment_id
  acr_id                       = var.acr_id
  acr_login_server             = var.acr_login_server
  image_name                   = var.image_name
  image_tag                    = var.image_tag

  # The build job (which runs before this apply) builds and pushes the real
  # image and passes it via var.image, so Terraform is the single authority for
  # the container image. Fall back to a public placeholder only when no image
  # was provided (so the container app can still be created).
  image = var.image != "" ? var.image : var.placeholder_image

  # Plaintext (non-secret) env vars. User-set env vars + secrets are sourced
  # from the per-deployment Key Vault below, not from this map.
  environment_variables = var.env_vars

  # The backend creates/owns the per-deployment Key Vault in the shared platform
  # resource group; Terraform consumes it to wire secretRef env vars.
  key_vault_name           = var.key_vault_name
  key_vault_resource_group = var.key_vault_resource_group

  target_port = var.target_port

  tags = local.common_tags
}
