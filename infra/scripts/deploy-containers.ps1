# =============================================================================
# Pronghorn Container Deployment Script
# =============================================================================
# Builds, pushes, and deploys container images to Azure Container Apps.
# Handles PBMM Private Link ACR by temporarily enabling public access for push.
#
# Usage:
#   .\deploy-containers.ps1                        # Deploy both
#   .\deploy-containers.ps1 -Frontend              # Deploy frontend only
#   .\deploy-containers.ps1 -Api                   # Deploy API only
#   .\deploy-containers.ps1 -SkipBuild             # Push existing images only
#   .\deploy-containers.ps1 -Tag "v1.2.3"          # Use a custom tag
#
# Prerequisites:
#   - Azure CLI installed and logged in
#   - Docker Desktop running
#   - Node.js installed
# =============================================================================

[CmdletBinding()]
param(
    [switch]$Frontend,
    [switch]$Api,
    [switch]$SkipBuild,
    [switch]$SyncSecrets,
    [string]$Tag,

    [string]$AcrName = "PronghornContainerRegistry",
    [string]$AcrLoginServer = "pronghorncontainerregistry.azurecr.io",
    [string]$ResourceGroup = "Pronghorn-App",
    [string]$FrontendApp = "ca-pronghorn-frontend",
    [string]$ApiApp = "ca-pronghorn-api",
    [string]$KeyVaultName = "kv-pronghorn-ptle86"
)

$ErrorActionPreference = "Stop"

# If neither -Frontend nor -Api specified, deploy both
if (-not $Frontend -and -not $Api) {
    $Frontend = $true
    $Api = $true
}

# Generate a timestamp tag if none provided
if (-not $Tag) {
    $Tag = "v$(Get-Date -Format 'yyyyMMdd-HHmmss')"
}

# Resolve project root (script is in infra/scripts/)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent (Split-Path -Parent $ScriptDir)

# ── Helpers ──────────────────────────────────────────────────────────────────
function Write-Step  { param($msg) Write-Host "`n══════════════════════════════════════════════════" -ForegroundColor Cyan; Write-Host "  $msg" -ForegroundColor Cyan; Write-Host "══════════════════════════════════════════════════" -ForegroundColor Cyan }
function Write-Ok    { param($msg) Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Info  { param($msg) Write-Host "  → $msg" -ForegroundColor Yellow }
function Write-Err   { param($msg) Write-Host "  ✗ $msg" -ForegroundColor Red }

function Invoke-Checked {
    param([string]$Label, [scriptblock]$Command)
    Write-Info $Label
    & $Command
    if ($LASTEXITCODE -ne 0) {
        Write-Err "$Label — failed (exit code $LASTEXITCODE)"
        throw "$Label failed"
    }
    Write-Ok $Label
}

# ── Track what we deployed for the summary ───────────────────────────────────
$deployed = @()

# =============================================================================
# 1. Validate Prerequisites
# =============================================================================
Write-Step "Validating Prerequisites"

foreach ($tool in @("az", "docker", "node", "npm")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Err "$tool is not installed or not in PATH."
        exit 1
    }
    Write-Ok "$tool found"
}

$account = az account show 2>$null | ConvertFrom-Json
if (-not $account) {
    Write-Err "Not logged into Azure. Run 'az login' first."
    exit 1
}
Write-Ok "Azure: $($account.user.name) ($($account.subscription.name))"

# Verify Docker daemon is running
docker info >$null 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Err "Docker daemon is not running. Start Docker Desktop first."
    exit 1
}
Write-Ok "Docker daemon running"

Write-Info "Image tag: $Tag"
Write-Info "Deploying: $(if($Frontend){'frontend '})$(if($Api){'api'})"

# =============================================================================
# 2. Open ACR Public Access (PBMM Private Link workaround)
# =============================================================================
Write-Step "Opening ACR Public Access for Push"

$acrWasOpened = $false

try {
    Invoke-Checked "Enable ACR public network + Allow default action" {
        az acr update --name $AcrName --public-network-enabled true --default-action Allow -o none 2>$null
    }
    $acrWasOpened = $true

    Write-Info "Waiting 15s for ACR network rules to propagate..."
    Start-Sleep -Seconds 15

    Invoke-Checked "Login to ACR" {
        az acr login --name $AcrName.ToLower()
    }

    # =============================================================================
    # 3. Build Applications
    # =============================================================================
    if (-not $SkipBuild) {
        if ($Frontend) {
            Write-Step "Building Frontend Application"
            Push-Location $RootDir

            Invoke-Checked "npm install (frontend)" { npm ci --prefer-offline }
            Invoke-Checked "npm run build (frontend)" { npm run build }

            Pop-Location
        }

        if ($Api) {
            Write-Step "Building API Application"
            Push-Location "$RootDir\api"

            Invoke-Checked "npm install (api)" { npm ci --prefer-offline }
            Invoke-Checked "npm run build (api)" { npm run build }

            Pop-Location
        }
    }
    else {
        Write-Info "Skipping application builds (-SkipBuild)"
    }

    # =============================================================================
    # 4. Build Docker Images
    # =============================================================================
    if ($Frontend) {
        Write-Step "Building & Pushing Frontend Container"
        $frontendImage = "$AcrLoginServer/pronghorn-frontend:$Tag"

        Invoke-Checked "Docker build frontend → $frontendImage" {
            docker build -t $frontendImage -f "$RootDir\Dockerfile" $RootDir
        }

        Invoke-Checked "Docker push frontend" {
            docker push $frontendImage
        }

        # Also tag as latest for local reference
        docker tag $frontendImage "$AcrLoginServer/pronghorn-frontend:latest" 2>$null
    }

    if ($Api) {
        Write-Step "Building & Pushing API Container"
        $apiImage = "$AcrLoginServer/pronghorn-api:$Tag"

        Invoke-Checked "Docker build api → $apiImage" {
            docker build -t $apiImage -f "$RootDir\api\Dockerfile" "$RootDir\api"
        }

        Invoke-Checked "Docker push api" {
            docker push $apiImage
        }

        docker tag $apiImage "$AcrLoginServer/pronghorn-api:latest" 2>$null
    }

    # =============================================================================
    # 5. Update Container Apps (new revision with new tag)
    # =============================================================================
    Write-Step "Updating Container Apps"

    if ($Frontend) {
        $frontendImage = "$AcrLoginServer/pronghorn-frontend:$Tag"

        Invoke-Checked "Set frontend registry (managed identity)" {
            az containerapp registry set `
                --name $FrontendApp `
                --resource-group $ResourceGroup `
                --server $AcrLoginServer `
                --identity system -o none
        }

        Invoke-Checked "Update frontend → $frontendImage" {
            az containerapp update `
                --name $FrontendApp `
                --resource-group $ResourceGroup `
                --image $frontendImage -o none
        }

        $deployed += @{ App = $FrontendApp; Image = $frontendImage }
    }

    if ($Api) {
        $apiImage = "$AcrLoginServer/pronghorn-api:$Tag"

        Invoke-Checked "Set api registry (managed identity)" {
            az containerapp registry set `
                --name $ApiApp `
                --resource-group $ResourceGroup `
                --server $AcrLoginServer `
                --identity system -o none
        }

        Invoke-Checked "Update api → $apiImage" {
            az containerapp update `
                --name $ApiApp `
                --resource-group $ResourceGroup `
                --image $apiImage -o none
        }

        $deployed += @{ App = $ApiApp; Image = $apiImage }
    }

    # =============================================================================
    # 5b. Sync Key Vault Secrets to API Container App
    # =============================================================================
    # Sets secrets as Key Vault references (managed identity) and wires env vars.
    # Only runs when -SyncSecrets is specified, or on first deploy.
    # Usage: .\deploy-containers.ps1 -Api -SyncSecrets
    # =============================================================================
    if ($Api -and $SyncSecrets) {
        Write-Step "Syncing Key Vault Secrets → API Container App"

        $kvUri = "https://${KeyVaultName}.vault.azure.net"
        $kvWasOpened = $false

        # Container Apps validates KV references at provision time — KV must be reachable
        try {
            Write-Info "Opening Key Vault public access for secret validation..."
            az keyvault update --name $KeyVaultName --resource-group $ResourceGroup --public-network-access Enabled -o none 2>$null
            $kvWasOpened = $true
            Start-Sleep -Seconds 5  # Allow network rules to propagate

            # Map of container app secret name → Key Vault secret name
            $kvSecrets = @{
                "gemini-api-key"   = "gemini-api-key"
                "anthropic-api-key" = "anthropic-api-key"
                "github-pat"       = "github-pat"
            }

            # Map of env var name → container app secret name
            $envVarMap = @{
                "GEMINI_API_KEY"   = "gemini-api-key"
                "ANTHROPIC_API_KEY" = "anthropic-api-key"
                "GITHUB_PAT"       = "github-pat"
            }

            # Build the --secrets argument: name=keyvaultref:uri,identityref:system
            $secretArgs = @()
            foreach ($entry in $kvSecrets.GetEnumerator()) {
                $secretArgs += "$($entry.Key)=keyvaultref:${kvUri}/secrets/$($entry.Value),identityref:system"
            }

            Invoke-Checked "Set KV-referenced secrets on $ApiApp" {
                az containerapp secret set `
                    --name $ApiApp `
                    --resource-group $ResourceGroup `
                    --secrets @secretArgs -o none
            }

            # Build the --set-env-vars argument: NAME=secretref:secret-name
            $envArgs = @()
            foreach ($entry in $envVarMap.GetEnumerator()) {
                $envArgs += "$($entry.Key)=secretref:$($entry.Value)"
            }

            Invoke-Checked "Set env vars referencing secrets on $ApiApp" {
                az containerapp update `
                    --name $ApiApp `
                    --resource-group $ResourceGroup `
                    --set-env-vars @envArgs -o none
            }

            Write-Ok "Key Vault secrets synced to $ApiApp"
        }
        finally {
            # Always lock KV back down
            if ($kvWasOpened) {
                Write-Info "Restoring Key Vault private access..."
                az keyvault update --name $KeyVaultName --resource-group $ResourceGroup --public-network-access Disabled -o none 2>$null
                if ($LASTEXITCODE -eq 0) {
                    Write-Ok "Key Vault public access disabled"
                }
                else {
                    Write-Err "Failed to disable KV public access — do this manually!"
                    Write-Err "  az keyvault update --name $KeyVaultName --resource-group $ResourceGroup --public-network-access Disabled"
                }
            }
        }
    }

    # =============================================================================
    # 6. Verify Revisions
    # =============================================================================
    Write-Step "Verifying Deployments"

    foreach ($app in $deployed) {
        $rev = az containerapp revision list `
            --name $app.App `
            --resource-group $ResourceGroup `
            --query "[?properties.active].{name:name, created:properties.createdTime, health:properties.healthState, running:properties.runningState}" `
            -o json 2>$null | ConvertFrom-Json

        $latest = $rev | Sort-Object -Property created -Descending | Select-Object -First 1

        if ($latest.health -eq "Healthy") {
            Write-Ok "$($app.App): revision $($latest.name) is $($latest.health)"
        }
        else {
            Write-Err "$($app.App): revision $($latest.name) is $($latest.health) / $($latest.running)"
            Write-Info "Check logs: az containerapp logs show --name $($app.App) --resource-group $ResourceGroup --type system"
        }
    }
}
finally {
    # =============================================================================
    # 7. ALWAYS Lock Down ACR (even on failure)
    # =============================================================================
    if ($acrWasOpened) {
        Write-Step "Restoring ACR Private Link Security"

        az acr update --name $AcrName --default-action Deny --public-network-enabled false -o none 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "ACR public access disabled"
        }
        else {
            Write-Err "Failed to disable ACR public access — do this manually!"
            Write-Err "  az acr update --name $AcrName --default-action Deny --public-network-enabled false"
        }
    }
}

# =============================================================================
# Summary
# =============================================================================
Write-Host ""
Write-Step "Deployment Complete"
Write-Host ""
Write-Info "Tag: $Tag"
Write-Host ""

foreach ($app in $deployed) {
    $fqdn = az containerapp show --name $app.App --resource-group $ResourceGroup --query "properties.configuration.ingress.fqdn" -o tsv 2>$null
    Write-Ok "$($app.App)"
    Write-Host "     Image: $($app.Image)" -ForegroundColor Gray
    Write-Host "     URL:   https://$fqdn" -ForegroundColor Gray
}

Write-Host ""
Write-Host "  To roll back, re-run with a previous tag:" -ForegroundColor DarkGray
Write-Host "    .\deploy-containers.ps1 -Tag <previous-tag> -SkipBuild" -ForegroundColor DarkGray
Write-Host ""
