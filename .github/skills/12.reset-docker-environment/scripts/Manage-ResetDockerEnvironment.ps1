<#
.SYNOPSIS
    Resets local Docker environment containers for Pronghorn.

.DESCRIPTION
    Stops and removes frontend/nginx, api, and db/postgresql containers from the
    local Pronghorn stack, then optionally lists containers to verify cleanup.

.PARAMETER Action
    Action to execute: reset-containers, list-containers, all.

.PARAMETER RepoRoot
    Optional repository root. Auto-resolved if omitted.

.EXAMPLE
    .\Manage-ResetDockerEnvironment.ps1 -Action all
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $false)]
    [ValidateSet('reset-containers', 'list-containers', 'all')]
    [string]$Action = 'all',

    [Parameter(Mandatory = $false)]
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'

function Write-Info {
    <#
    .SYNOPSIS
        Writes informational output.
    .PARAMETER Message
        Message text.
    .EXAMPLE
        Write-Info -Message "Starting"
    #>
    param(
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$Message
    )

    Write-Host "[INFO] $Message" -ForegroundColor Cyan
}

function Write-Success {
    <#
    .SYNOPSIS
        Writes success output.
    .PARAMETER Message
        Message text.
    .EXAMPLE
        Write-Success -Message "Done"
    #>
    param(
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$Message
    )

    Write-Host "[OK] $Message" -ForegroundColor Green
}

function Assert-DockerAvailable {
    <#
    .SYNOPSIS
        Validates that Docker CLI is available.
    .EXAMPLE
        Assert-DockerAvailable
    #>
    $dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $dockerCommand) {
        throw 'Docker CLI not found. Install Docker Desktop/Engine and retry.'
    }
}

function Get-ResolvedRepoRoot {
    <#
    .SYNOPSIS
        Resolves repository root path.
    .PARAMETER OptionalRepoRoot
        Optional explicit root path.
    .EXAMPLE
        Get-ResolvedRepoRoot -OptionalRepoRoot "."
    #>
    param(
        [Parameter(Mandatory = $false)]
        [string]$OptionalRepoRoot
    )

    if (-not [string]::IsNullOrWhiteSpace($OptionalRepoRoot)) {
        return (Resolve-Path -Path $OptionalRepoRoot -ErrorAction Stop).Path
    }

    return (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..') -ErrorAction Stop).Path
}

function Invoke-DockerComposeDown {
    <#
    .SYNOPSIS
        Stops and removes compose services for frontend, api, and db.
    .PARAMETER RootPath
        Repository root path containing docker-compose.yml.
    .EXAMPLE
        Invoke-DockerComposeDown -RootPath "."
    #>
    param(
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$RootPath
    )

    $composeFile = Join-Path $RootPath 'docker-compose.yml'
    if (-not (Test-Path $composeFile)) {
        throw "docker-compose.yml not found at: $composeFile"
    }

    if ($PSCmdlet.ShouldProcess('Compose services frontend/api/db', 'Stop and remove containers')) {
        Push-Location $RootPath
        try {
            & docker compose stop frontend api db
            if ($LASTEXITCODE -ne 0) {
                Write-Info 'docker compose stop returned non-zero. Continuing with removal attempts.'
            }

            & docker compose rm -f -s -v frontend api db
            if ($LASTEXITCODE -ne 0) {
                Write-Info 'docker compose rm returned non-zero. Continuing with direct removal fallback.'
            }
        }
        finally {
            Pop-Location
        }
    }
}

function Remove-DirectContainerFallback {
    <#
    .SYNOPSIS
        Removes direct container matches for nginx/frontend, api, and postgres/db.
    .EXAMPLE
        Remove-DirectContainerFallback
    #>
    $nameTokens = @('frontend', 'nginx', 'api', 'db', 'postgres', 'postgresql')

    foreach ($token in $nameTokens) {
        $containerIds = (& docker ps -a --filter "name=$token" --format '{{.ID}}')
        if ($LASTEXITCODE -ne 0) {
            continue
        }

        foreach ($containerId in ($containerIds | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)) {
            if ($PSCmdlet.ShouldProcess("Container $containerId", 'Force remove')) {
                & docker rm -f $containerId | Out-Null
                if ($LASTEXITCODE -eq 0) {
                    Write-Success "Removed container: $containerId"
                }
            }
        }
    }
}

function Show-ContainerList {
    <#
    .SYNOPSIS
        Lists all local Docker containers for verification.
    .EXAMPLE
        Show-ContainerList
    #>
    Write-Info 'Container list (docker container ls -a):'
    & docker container ls -a --format 'table {{.Names}}`t{{.Image}}`t{{.Status}}'
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to list Docker containers.'
    }
}

Assert-DockerAvailable
$resolvedRoot = Get-ResolvedRepoRoot -OptionalRepoRoot $RepoRoot

switch ($Action) {
    'reset-containers' {
        Write-Info 'Stopping/removing frontend(nginx), api, and db(postgresql) containers...'
        Invoke-DockerComposeDown -RootPath $resolvedRoot
        Remove-DirectContainerFallback
    }
    'list-containers' {
        Show-ContainerList
    }
    'all' {
        Write-Info 'Stopping/removing frontend(nginx), api, and db(postgresql) containers...'
        Invoke-DockerComposeDown -RootPath $resolvedRoot
        Remove-DirectContainerFallback

        Show-ContainerList
    }
    default {
        throw "Unsupported action: $Action"
    }
}

Write-Success 'Docker environment reset workflow completed.'
