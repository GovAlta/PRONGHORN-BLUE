<#
.SYNOPSIS
Creates app/backend/.env for local development and injects a random JWT secret.

.DESCRIPTION
Creates or overwrites the API environment file using the repository defaults
from LOCAL_DEVELOPMENT.md and replaces JWT_SECRET with a generated random
32-character token.

.PARAMETER ApiDir
Path to the API directory. Defaults to the repository app/backend folder.

.PARAMETER Force
When provided, overwrites an existing .env file.

.EXAMPLE
./New-ApiEnv.ps1

.EXAMPLE
./New-ApiEnv.ps1 -Force
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [ValidateNotNullOrEmpty()]
    [string]$ApiDir = (Join-Path $PSScriptRoot "..\..\..\..\app\backend"),

    [Parameter(Mandatory = $false)]
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -Path $ApiDir -PathType Container)) {
    throw "API directory not found: $ApiDir"
}

$envPath = Join-Path -Path $ApiDir -ChildPath ".env"

if ((Test-Path -Path $envPath -PathType Leaf) -and (-not $Force)) {
    throw "File already exists: $envPath. Use -Force to overwrite."
}

$jwtBase64 = [Convert]::ToBase64String(
    [System.Text.Encoding]::UTF8.GetBytes((New-Guid).ToString() + (New-Guid).ToString())
)
$jwt = -join ($jwtBase64.ToCharArray() | Select-Object -First 32)

$envContent = @"
# ──────────────────────────────────────────────
# Database
# ──────────────────────────────────────────────
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DATABASE=pronghorn
POSTGRES_USER=pronghorn_admin
POSTGRES_PASSWORD=localdev123
POSTGRES_SSL=false

# ──────────────────────────────────────────────
# Server
# ──────────────────────────────────────────────
PORT=3001
NODE_ENV=development
ALLOWED_ORIGINS=http://localhost:8080,http://localhost:8081

# ──────────────────────────────────────────────
# Authentication
# ──────────────────────────────────────────────
JWT_SECRET=$jwt

# ──────────────────────────────────────────────
# Azure AI Foundry (required — AI features)
# ──────────────────────────────────────────────
# AI agent/chat, code generation, reasoning, and
# presentation features require these credentials.
FOUNDRY_ENDPOINT=https://ai-pronghorn-xxx.services.ai.azure.com/
FOUNDRY_API_KEY=your-foundry-api-key
APIM_OPENAI_URL=https://apim-pronghorn-xxx.azure-api.net/openai

# ──────────────────────────────────────────────
# WebSocket (realtime features)
# ──────────────────────────────────────────────
# WebSocket is built into the API server on the /ws path.
# No additional configuration needed for local development.

# ──────────────────────────────────────────────
# Azure Blob Storage (optional — file uploads)
# ──────────────────────────────────────────────
# Leave empty to disable storage. Use az login with a dev storage account for local.
AZURE_STORAGE_ACCOUNT_NAME=
"@

[System.IO.File]::WriteAllText($envPath, $envContent, [System.Text.UTF8Encoding]::new($false))

Write-Host "Created: $envPath"
Write-Host "Generated JWT_SECRET (32 chars): $jwt"
