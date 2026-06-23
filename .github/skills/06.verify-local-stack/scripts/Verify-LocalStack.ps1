<#
.SYNOPSIS
Verifies local Pronghorn stack health (frontend, API, DB).

.DESCRIPTION
Performs automated checks for:
- Frontend availability on port 8080
- API health endpoint on port 3001
- PostgreSQL container readiness (if Docker container exists)

.PARAMETER FrontendUrl
Frontend URL to verify.

.PARAMETER ApiHealthUrl
API health endpoint URL to verify.

.PARAMETER DbContainerName
Docker PostgreSQL container name to verify.

.EXAMPLE
./Verify-LocalStack.ps1

.EXAMPLE
./Verify-LocalStack.ps1 -FrontendUrl "http://localhost:8081"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [ValidateNotNullOrEmpty()]
    [string]$FrontendUrl = "http://localhost:8080",

    [Parameter(Mandatory = $false)]
    [ValidateNotNullOrEmpty()]
    [string]$ApiHealthUrl = "http://localhost:3001/health",

    [Parameter(Mandatory = $false)]
    [ValidateNotNullOrEmpty()]
    [string]$DbContainerName = "pronghorn-db"
)

$ErrorActionPreference = 'Stop'

function Test-HttpEndpoint {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    try {
        $response = Invoke-WebRequest -Uri $Url -Method Get -TimeoutSec 10 -UseBasicParsing
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
            Write-Host "✅ $Name is reachable: $Url (HTTP $($response.StatusCode))"
            return $true
        }

        Write-Host "❌ $Name returned unexpected status: HTTP $($response.StatusCode)"
        return $false
    }
    catch {
        Write-Host "❌ $Name is not reachable: $Url"
        Write-Host "   Error: $($_.Exception.Message)"
        return $false
    }
}

function Test-DockerDbContainer {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$ContainerName
    )

    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Host "⚠️ Docker CLI not found; skipping DB container check."
        return $true
    }

    try {
        $containerId = docker ps -aq -f "name=^${ContainerName}$" 2>$null
        if (-not $containerId) {
            Write-Host "⚠️ Docker container '$ContainerName' not found; skipping DB readiness check."
            return $true
        }

        $isRunning = docker inspect -f "{{.State.Running}}" $ContainerName 2>$null
        if ($isRunning -ne "true") {
            Write-Host "❌ DB container '$ContainerName' exists but is not running."
            return $false
        }

        docker exec $ContainerName pg_isready -U pronghorn_admin -d pronghorn 1>$null 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "✅ PostgreSQL container is accepting connections: $ContainerName"
            return $true
        }

        Write-Host "❌ PostgreSQL container is running but not ready: $ContainerName"
        return $false
    }
    catch {
        Write-Host "❌ Failed to verify DB container '$ContainerName': $($_.Exception.Message)"
        return $false
    }
}

Write-Host "Verifying local Pronghorn stack..."

$frontendOk = Test-HttpEndpoint -Url $FrontendUrl -Name "Frontend"
$apiOk = Test-HttpEndpoint -Url $ApiHealthUrl -Name "API health"
$dbOk = Test-DockerDbContainer -ContainerName $DbContainerName

if (-not $frontendOk -and $FrontendUrl -eq 'http://localhost:8080') {
    try {
        $altResponse = Invoke-WebRequest -Uri 'http://localhost:8081' -Method Get -TimeoutSec 5 -UseBasicParsing
        if ($altResponse.StatusCode -ge 200 -and $altResponse.StatusCode -lt 400) {
            Write-Host "⚠️ Frontend appears reachable on http://localhost:8081. Port 8080 is likely occupied; free 8080 and restart frontend for redirect URI consistency."
        }
    }
    catch {
        # no-op: alternate frontend endpoint is not reachable
    }
}

if ($frontendOk -and $apiOk -and $dbOk) {
    Write-Host "\n✅ Stack verification passed."
    Write-Host "Frontend: $FrontendUrl"
    Write-Host "API:      $ApiHealthUrl"
    Write-Host "DB:       $DbContainerName"
    exit 0
}

Write-Host "\n❌ Stack verification failed."
Write-Host "Next checks:"
Write-Host "- Start frontend: npm run dev (repo root)"
Write-Host "- Start API: cd app/backend; npm run dev (or: npm --prefix app/backend run dev)"
Write-Host "- Start DB container: docker start pronghorn-db"
exit 1
