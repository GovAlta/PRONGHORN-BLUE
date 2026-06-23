<#
.SYNOPSIS
Creates .env.local for frontend local development.

.DESCRIPTION
Creates or overwrites the repository root .env.local file using the
recommended values from LOCAL_DEVELOPMENT.md step 5.2.

.PARAMETER RepoRoot
Path to repository root. Defaults to the detected path relative to script location.

.PARAMETER Force
When provided, overwrites an existing .env.local file.

.EXAMPLE
./New-FrontendEnv.ps1

.EXAMPLE
./New-FrontendEnv.ps1 -Force
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [ValidateNotNullOrEmpty()]
    [string]$RepoRoot = (Join-Path $PSScriptRoot "..\..\..\.."),

    [Parameter(Mandatory = $false)]
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "Azure CLI not found. Install Azure CLI and run 'az login'."
}

$tenantId = (az account show --query tenantId -o tsv 2>$null)
if (-not $tenantId) {
    Write-Host "Azure authentication required. Run 'az login' and rerun this script." -ForegroundColor Yellow
    throw "Not authenticated to Azure."
}

$appDisplayName = 'pronghorn-app'
$redirectUris = @(
    'http://localhost:8080',
    'http://localhost:8080/auth-redirect.html',
    'http://localhost:8081',
    'http://localhost:8081/auth-redirect.html'
)

$appRaw = az ad app list --display-name $appDisplayName --query "[0]" -o json
$app = if ($appRaw -and $appRaw -ne 'null') { $appRaw | ConvertFrom-Json } else { $null }

if (-not $app) {
    $app = az ad app create --display-name $appDisplayName --sign-in-audience AzureADMyOrg -o json | ConvertFrom-Json
}

$appObjectId = $app.id
$clientId = $app.appId

$spaPatchPath = Join-Path $env:TEMP 'pronghorn-spa-config.json'
$spaPatchBody = @{
    spa = @{
        redirectUris = $redirectUris
    }
} | ConvertTo-Json -Depth 6

[System.IO.File]::WriteAllText($spaPatchPath, $spaPatchBody, [System.Text.UTF8Encoding]::new($false))
az rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications/$appObjectId" --headers Content-Type=application/json --body "@$spaPatchPath" | Out-Null

if (-not (Test-Path -Path $RepoRoot -PathType Container)) {
    throw "Repository root not found: $RepoRoot"
}

$envPath = Join-Path $RepoRoot ".env.local"

if ((Test-Path -Path $envPath -PathType Leaf) -and (-not $Force)) {
    throw "File already exists: $envPath. Use -Force to overwrite."
}

$envContent = @"
# ──────────────────────────────────────────────
# API Backend
# ──────────────────────────────────────────────
VITE_API_BASE_URL=http://localhost:3001
VITE_USE_AZURE_API=true
VITE_APIM_SUBSCRIPTION_KEY=

# ──────────────────────────────────────────────
# Authentication Mode
# ──────────────────────────────────────────────
VITE_AUTH_MODE=msal

# ──────────────────────────────────────────────
# Azure AD / MSAL Authentication
# ──────────────────────────────────────────────
VITE_AZURE_CLIENT_ID=$clientId
VITE_AZURE_TENANT_ID=$tenantId
VITE_AZURE_REDIRECT_URI=http://localhost:8080

# ──────────────────────────────────────────────
# WebSocket (realtime)
# ──────────────────────────────────────────────
VITE_WS_URL=ws://localhost:3001/ws
"@

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($envPath, $envContent, $utf8NoBom)

Write-Host "Created: $envPath"
Write-Host "Configured app registration: $appDisplayName"
Write-Host "VITE_AZURE_CLIENT_ID=$clientId"
Write-Host "VITE_AZURE_TENANT_ID=$tenantId"
