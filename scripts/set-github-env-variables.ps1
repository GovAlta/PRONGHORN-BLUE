<#
.SYNOPSIS
    Populates a GitHub Environment with the Pronghorn deployment Variables that
    Terraform consumes as TF_VAR_* at deploy time.

.DESCRIPTION
    The platform-deploy workflow reads environment-specific configuration
    (subscription, subnet / DNS IDs, URL overrides) from GitHub Environment
    Variables instead of from params/<environment>.tfvars. This script ensures
    the target environment exists, then sets each non-empty value from the
    $Variables table below as a GitHub Environment Variable.

    HOW TO USE (reference template):
      1. Fill in the $Variables table for the environment you are configuring.
      2. Run the script, e.g.:
           ./set-github-env-variables.ps1 -Org <org> -Repo pronghorn -Environment dev
      3. Re-run any time to update values (idempotent).

    Empty ('') values are skipped so the Terraform default applies. Each name
    maps 1:1 to TF_VAR_<lowercase-name> (e.g. SUBSCRIPTION_ID ->
    TF_VAR_subscription_id). See docs/PBMM_DEPLOYMENT.md section 6.0 for the
    authoritative variable list and which values each archetype requires.

.PARAMETER Org
    GitHub organization (or user) that owns the repository, e.g. "phb-msft-dev".

.PARAMETER Repo
    Repository name, e.g. "pronghorn".

.PARAMETER Environment
    GitHub Environment name. Must match the deploy branch name (dev / uat / prod)
    because the workflow sets environment: ${{ github.ref_name }} and the OIDC
    subject is repo:<org>/<repo>:environment:<branch>.

.EXAMPLE
    ./set-github-env-variables.ps1 -Org phb-msft-dev -Repo pronghorn -Environment dev

.EXAMPLE
    # Preview only — show what would change without calling GitHub:
    ./set-github-env-variables.ps1 -Org phb-msft-dev -Repo pronghorn -Environment dev -WhatIf

.NOTES
    Prerequisites:
      - GitHub CLI (gh) installed:  https://cli.github.com
      - Authenticated with repo admin scope:  gh auth login

    These are NON-SECRET deployment Variables. Do NOT put secrets (database
    passwords, JWT secret, GitHub App private key) here — those live in Azure
    Key Vault and are seeded by Terraform.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)]
  [string]$Org,

  [Parameter(Mandatory)]
  [string]$Repo,

  [Parameter(Mandatory)]
  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$Environment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# =============================================================================
# Fill in the values for THIS environment, then run the script.
#   - Leave a value as '' (empty) to skip it and let the Terraform default apply.
#   - Subnet IDs are full resource IDs:
#       /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Network/virtualNetworks/<vnet>/subnets/<subnet>
# =============================================================================
$Variables = [ordered]@{
  # ── Always required (every environment) ──────────────────────────────────
  SUBSCRIPTION_ID                            = ''   # Workload subscription GUID (also the azure/login subscription)
  AZURE_CLIENT_ID                            = ''   # OIDC + Entra sign-in app (client) ID
  AZURE_TENANT_ID                            = ''   # Entra tenant ID

  # ── Terraform state backend (every environment) ──────────────────────────
  # Non-secret identifiers for the remote tfstate storage. (use_azuread_auth is
  # always true and is hardcoded in the workflow, so it is not a variable.)
  TFSTATE_RESOURCE_GROUP                     = ''   # Resource group holding the tfstate storage account
  TFSTATE_STORAGE_ACCOUNT                    = ''   # tfstate storage account name
  TFSTATE_CONTAINER                          = ''   # Blob container (typically "tfstate")
  TFSTATE_KEY                                = ''   # State blob key (e.g. pronghorn-<env>.tfstate)

  # ── Required for the corp / PBMM archetype (private networking) ───────────
  DELEGATED_SUBNET_ID                        = ''  # PostgreSQL VNet-injection subnet
  KEYVAULT_PRIVATE_ENDPOINT_SUBNET_ID        = ''  # Key Vault private endpoint
  STORAGE_PRIVATE_ENDPOINT_SUBNET_ID         = ''  # Storage private endpoint
  CONTAINER_APPS_SUBNET_ID                   = ''  # Platform Container Apps environment injection
  ACA_ENVIRONMENT_PRIVATE_ENDPOINT_SUBNET_ID = ''  # Platform ACA private endpoint
  WORKLOAD_ACA_SUBNET_ID                     = ''  # Workload Container Apps environment injection
  WORKLOAD_ACA_PRIVATE_ENDPOINT_SUBNET_ID    = ''  # Workload ACA private endpoint
  APIM_SUBNET_ID                             = ''  # APIM VNet integration subnet
  ACR_PRIVATE_ENDPOINT_SUBNET_ID             = ''  # ACR private endpoint
  AI_FOUNDRY_PRIVATE_ENDPOINT_SUBNET_ID      = ''  # AI Foundry private endpoint

  # ── Conditional / optional ───────────────────────────────────────────────
  CENTRAL_DNS_SUBSCRIPTION_ID                = ''  # Only when delegate_private_dns_to_policy = false
  CENTRAL_DNS_RESOURCE_GROUP_NAME            = ''  # Only when delegate_private_dns_to_policy = false
  FRONTEND_APP_URL_OVERRIDE                  = ''  # Optional public frontend URL (MSAL redirect / CORS)
  API_BASE_URL_OVERRIDE                      = ''  # Optional public API URL (VITE_API_BASE_URL + derived VITE_WS_URL)
}

function Test-GhCli {
  <#
    .SYNOPSIS
        Fails fast unless the GitHub CLI is installed and authenticated.
    #>
  [CmdletBinding()]
  param()

  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "GitHub CLI (gh) is not installed or not on PATH. Install from https://cli.github.com then run 'gh auth login'."
  }

  gh auth status 1>$null 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw "GitHub CLI is not authenticated. Run 'gh auth login' (needs repo admin scope) and retry."
  }
}

function New-GitHubEnvironment {
  <#
    .SYNOPSIS
        Ensures the target GitHub Environment exists (creates it with no
        protection rules if missing). Safe to call repeatedly.
    #>
  [CmdletBinding(SupportsShouldProcess)]
  param(
    [Parameter(Mandatory)][string]$Owner,
    [Parameter(Mandatory)][string]$Repository,
    [Parameter(Mandatory)][string]$Name
  )

  if ($PSCmdlet.ShouldProcess("$Owner/$Repository", "Ensure environment '$Name' exists")) {
    gh api --method PUT "repos/$Owner/$Repository/environments/$Name" 1>$null
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to create or verify environment '$Name' in $Owner/$Repository."
    }
    Write-Host "Environment '$Name' is present."
  }
}

function Set-GitHubEnvironmentVariable {
  <#
    .SYNOPSIS
        Sets a single GitHub Environment Variable, skipping empty values.
    #>
  [CmdletBinding(SupportsShouldProcess)]
  param(
    [Parameter(Mandatory)][string]$Owner,
    [Parameter(Mandatory)][string]$Repository,
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$VariableName,
    [Parameter(Mandatory)][AllowEmptyString()][string]$Value
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    Write-Host "  skip  $VariableName (empty — Terraform default applies)"
    return
  }

  if ($PSCmdlet.ShouldProcess($VariableName, "Set in $Owner/$Repository environment '$Name'")) {
    gh variable set $VariableName --env $Name --repo "$Owner/$Repository" --body $Value 1>$null
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to set variable '$VariableName'."
    }
    Write-Host "  set   $VariableName"
  }
}

# ── Main ─────────────────────────────────────────────────────────────────────
Test-GhCli
New-GitHubEnvironment -Owner $Org -Repository $Repo -Name $Environment

Write-Host "Setting $($Variables.Count) variables on $Org/$Repo environment '$Environment':"
foreach ($entry in $Variables.GetEnumerator()) {
  Set-GitHubEnvironmentVariable -Owner $Org -Repository $Repo -Name $Environment `
    -VariableName $entry.Key -Value $entry.Value
}

Write-Host "Done."
