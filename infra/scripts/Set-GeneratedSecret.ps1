<#
.SYNOPSIS
    Idempotently seeds a generated secret into Azure Key Vault (create-if-absent).

.DESCRIPTION
    Generates a cryptographically secure random value and stores it in the named
    Key Vault secret ONLY when the secret does not already exist. When the secret
    is already present its value is preserved untouched, so generated secrets stay
    stable across deployments.

    The value is never returned, logged, or written to Terraform state — it lives
    only in Key Vault. Terraform consumes it at apply time via an
    `ephemeral "azurerm_key_vault_secret"` read fed into write-only arguments.

    Requires the caller to be authenticated to Azure (az CLI) with
    "Key Vault Secrets Officer" on the target vault and network reachability
    (public access in dev, private endpoint in PBMM landing zones).

.PARAMETER VaultName
    Name of the target Azure Key Vault.

.PARAMETER SecretName
    Name of the secret to create when absent.

.PARAMETER LengthBytes
    Number of random bytes to generate before base64 encoding. Default: 32.

.EXAMPLE
    .\Set-GeneratedSecret.ps1 -VaultName "kv-pronghorn-dev" -SecretName "postgres-password"
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$VaultName,

  [Parameter(Mandatory)]
  [string]$SecretName,

  [ValidateRange(16, 128)]
  [int]$LengthBytes = 32
)

$ErrorActionPreference = 'Stop'

# Fast path: preserve an existing value so generated secrets remain stable.
$existing = az keyvault secret show --vault-name $VaultName --name $SecretName --query 'value' --output tsv 2>$null
if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($existing)) {
  Write-Host "[seed] Secret '$SecretName' already present in '$VaultName' — preserving existing value."
  exit 0
}

# Generate a cryptographically secure random value (no openssl dependency).
$bytes = [System.Byte[]]::new($LengthBytes)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$value = [System.Convert]::ToBase64String($bytes)

az keyvault secret set --vault-name $VaultName --name $SecretName --value $value --output none
if ($LASTEXITCODE -ne 0) {
  throw "Failed to set secret '$SecretName' in vault '$VaultName'."
}

# Avoid leaving the secret material in the local variable longer than necessary.
$value = $null
Write-Host "[seed] Created secret '$SecretName' in '$VaultName'."
