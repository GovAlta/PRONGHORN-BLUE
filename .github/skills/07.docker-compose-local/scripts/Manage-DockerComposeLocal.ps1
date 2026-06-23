<#
.SYNOPSIS
Automates Docker Compose full-stack workflows for local Pronghorn development.

.DESCRIPTION
Implements section 7 workflows from LOCAL_DEVELOPMENT.md including:
- Build prerequisites (frontend + API)
- docker compose up/down
- status, logs, verify, and reset operations

.PARAMETER Action
Operation to run: start, verify, logs, status, stop, reset.

.PARAMETER SkipBuild
Skips frontend/API pre-build steps for the start action.

.EXAMPLE
./Manage-DockerComposeLocal.ps1 -Action start

.EXAMPLE
./Manage-DockerComposeLocal.ps1 -Action verify

.EXAMPLE
./Manage-DockerComposeLocal.ps1 -Action logs
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [ValidateSet('start', 'verify', 'logs', 'status', 'stop', 'reset')]
    [string]$Action = 'start',

    [Parameter(Mandatory = $false)]
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

function Invoke-Step {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message,
        [Parameter(Mandatory = $true)]
        [scriptblock]$Script
    )

    Write-Host "`n==> $Message"
    & $Script
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker CLI not found. Install/start Docker Desktop first."
}

$repoRoot = Join-Path $PSScriptRoot "..\..\..\.."
if (-not (Test-Path -Path $repoRoot -PathType Container)) {
    throw "Repository root not found: $repoRoot"
}

Push-Location $repoRoot
try {
    switch ($Action) {
        'start' {
            if (-not $SkipBuild) {
                Invoke-Step -Message "Build frontend (development mode)" -Script {
                    npx vite build --mode development
                }

                Invoke-Step -Message "Build API" -Script {
                    Push-Location "api"
                    try {
                        npm run build
                    }
                    finally {
                        Pop-Location
                    }
                }
            }

            Invoke-Step -Message "Start Docker Compose stack" -Script {
                docker compose up --build -d
            }

            Invoke-Step -Message "Show stack status" -Script {
                docker compose ps
            }
        }

        'verify' {
            Invoke-Step -Message "Container status" -Script {
                docker compose ps
            }

            Invoke-Step -Message "API health check" -Script {
                try {
                    $response = Invoke-WebRequest -Uri "http://localhost:3001/health" -Method Get -TimeoutSec 10 -UseBasicParsing
                    Write-Host "API health OK (HTTP $($response.StatusCode))"
                }
                catch {
                    throw "API health check failed: $($_.Exception.Message)"
                }
            }

            Invoke-Step -Message "Database table check" -Script {
                docker compose exec db psql -U pronghorn_admin -d pronghorn -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';"
            }
        }

        'logs' {
            Invoke-Step -Message "Streaming compose logs" -Script {
                docker compose logs -f
            }
        }

        'status' {
            Invoke-Step -Message "Container status" -Script {
                docker compose ps
            }
        }

        'stop' {
            Invoke-Step -Message "Stop containers (preserve data)" -Script {
                docker compose down
            }
        }

        'reset' {
            Invoke-Step -Message "Stop and remove volumes" -Script {
                docker compose down -v
            }

            if (-not $SkipBuild) {
                Invoke-Step -Message "Build frontend (development mode)" -Script {
                    npx vite build --mode development
                }

                Invoke-Step -Message "Build API" -Script {
                    Push-Location "api"
                    try {
                        npm run build
                    }
                    finally {
                        Pop-Location
                    }
                }
            }

            Invoke-Step -Message "Recreate stack" -Script {
                docker compose up --build -d
            }

            Invoke-Step -Message "Show stack status" -Script {
                docker compose ps
            }
        }
    }
}
finally {
    Pop-Location
}
