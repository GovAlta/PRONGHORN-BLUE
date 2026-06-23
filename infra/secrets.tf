# =============================================================================
# Generated Secrets — seeded into Key Vault, never stored in Terraform state
# =============================================================================
# Strategy (satisfies the hard constraint "generated at runtime, stable across
# deploys, NEVER in tfstate, only ever in Key Vault"):
#
#   1. SEED  — terraform_data.seed_generated_secrets runs Set-GeneratedSecret.ps1
#              (create-if-absent). The value is generated ONCE; every later apply
#              preserves the existing value, so it is stable.
#   2. READ  — ephemeral "azurerm_key_vault_secret" reads each value at apply
#              time. Ephemeral values are never persisted to state or plan files.
#   3. CONSUME — the value flows only into write-only arguments
#              (administrator_password_wo) and runtime Container App Key Vault
#              references (URI only) — never stored in state.
#
# The deploying identity needs "Key Vault Secrets Officer" (seed write) and
# "Key Vault Secrets User" (ephemeral read) on the platform vault, plus network
# reach (public access in dev, private endpoint in PBMM).
# =============================================================================

locals {
  # Generated platform secrets that must be stable and never appear in state.
  # These are intentionally NOT members of the keyvault module's `secrets` map
  # (which would persist their plaintext values in state via the secret
  # resource's `value` attribute).
  seeded_generated_secret_names = [
    "postgres-password",
    "postgres-genapps-password",
    "jwt-secret",
  ]
}

# -----------------------------------------------------------------------------
# Seed: create-if-absent in Key Vault (idempotent; value generated once)
# -----------------------------------------------------------------------------
# triggers_replace deliberately excludes the secret VALUE — the value is managed
# outside Terraform state and must not cause churn. The seed runs on every apply
# (see `always_run` below) but is idempotent: the value is generated once and
# preserved thereafter, so re-running never rotates an existing secret.
resource "terraform_data" "seed_generated_secrets" {
  for_each = toset(local.seeded_generated_secret_names)

  # `always_run` forces this idempotent create-if-absent seed to execute on every
  # apply. Without it, once the resource is recorded in state the triggers stay
  # stable, Terraform treats the resource as a no-op, the local-exec never re-runs,
  # and the downstream `ephemeral` read (which only `depends_on` this resource)
  # opens against a vault where the secret was never written -> SecretNotFound.
  # Set-GeneratedSecret.ps1 preserves any existing value, so running every apply
  # guarantees presence before the read without ever rotating the secret.
  triggers_replace = {
    vault_name  = module.keyvault.name
    secret_name = each.value
    always_run  = timestamp()
  }

  provisioner "local-exec" {
    interpreter = ["pwsh", "-NoProfile", "-Command"]
    command     = "& '${path.module}/scripts/Set-GeneratedSecret.ps1' -VaultName '${module.keyvault.name}' -SecretName '${each.value}'"
  }

  # Vault (incl. RBAC propagation + PBMM private-endpoint DNS wait) must exist
  # and be reachable before we can write secrets into it.
  depends_on = [module.keyvault]
}

# -----------------------------------------------------------------------------
# Ephemeral reads — values consumed by write-only / runtime references only
# -----------------------------------------------------------------------------
# depends_on the seed so first-apply reads are deferred until after the secret
# exists. On subsequent runs the secret is already present and reads succeed at
# plan time.
ephemeral "azurerm_key_vault_secret" "postgres_password" {
  name         = "postgres-password"
  key_vault_id = module.keyvault.id

  depends_on = [terraform_data.seed_generated_secrets]
}

ephemeral "azurerm_key_vault_secret" "postgres_genapps_password" {
  name         = "postgres-genapps-password"
  key_vault_id = module.keyvault.id

  depends_on = [terraform_data.seed_generated_secrets]
}

# -----------------------------------------------------------------------------
# GitHub App private key — dummy-seeded, real value set out-of-band in Key Vault
# -----------------------------------------------------------------------------
# The GitHub App private key (PEM) is the only GitHub App value that is secret;
# the App ID and Installation ID are non-secret but are managed alongside it in
# Key Vault (single source of GitHub App identity) — none of the three are kept
# in committed tfvars.
#
# Two-phase pattern: Terraform creates the secret once with a placeholder value,
# then `ignore_changes = [value]` ensures subsequent applies never overwrite the
# real PEM that an operator sets out-of-band:
#
#   az keyvault secret set --vault-name <platform-kv> \
#     --name github-app-private-key --file app.pem
#
# The real PEM is therefore NEVER passed through Terraform variables or state —
# only the harmless placeholder is ever stored as the resource's `value`.
resource "azurerm_key_vault_secret" "github_app_private_key" {
  name         = "github-app-private-key"
  value        = "REPLACE_VIA_KEY_VAULT" # placeholder only; real PEM set out-of-band
  key_vault_id = module.keyvault.id
  content_type = "application/x-pem-file"

  lifecycle {
    ignore_changes = [value]
  }

  # Vault (incl. RBAC propagation + PBMM private-endpoint DNS wait) must exist
  # before writing the placeholder secret.
  depends_on = [module.keyvault]
}

# -----------------------------------------------------------------------------
# GitHub App ID / Installation ID — dummy-seeded, real values set out-of-band
# -----------------------------------------------------------------------------
# Although not secret, the customer manages these in Key Vault alongside the
# private key (single source of GitHub App identity). Same two-phase pattern:
# Terraform creates each secret once with a placeholder, then ignore_changes
# preserves the real value an operator sets out-of-band:
#
#   az keyvault secret set --vault-name <platform-kv> --name github-app-id --value <id>
#   az keyvault secret set --vault-name <platform-kv> --name github-app-installation-id --value <id>
#
# The real values are therefore NEVER passed through Terraform variables/state.
resource "azurerm_key_vault_secret" "github_app_id" {
  name         = "github-app-id"
  value        = "REPLACE_VIA_KEY_VAULT" # placeholder only; real value set out-of-band
  key_vault_id = module.keyvault.id

  lifecycle {
    ignore_changes = [value]
  }

  depends_on = [module.keyvault]
}

resource "azurerm_key_vault_secret" "github_app_installation_id" {
  name         = "github-app-installation-id"
  value        = "REPLACE_VIA_KEY_VAULT" # placeholder only; real value set out-of-band
  key_vault_id = module.keyvault.id

  lifecycle {
    ignore_changes = [value]
  }

  depends_on = [module.keyvault]
}
