<#
.SYNOPSIS
Wrapper entrypoint for local Docker Compose automation.

.DESCRIPTION
Routes execution to platform-appropriate implementation.

.PARAMETER Action
Action to run: start, verify, logs, status, stop, reset.

.PARAMETER SkipBuild
Skips build prerequisite steps where supported.

.EXAMPLE
./docker-compose-local.ps1 -Action start
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

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$psScript = Join-Path $scriptDir 'Manage-DockerComposeLocal.ps1'
$bashScript = Join-Path $scriptDir 'manage-docker-compose-local.sh'

if ($IsWindows -or $env:OS -eq 'Windows_NT') {
    if ($SkipBuild) {
        & $psScript -Action $Action -SkipBuild
    }
    else {
        & $psScript -Action $Action
    }
    exit $LASTEXITCODE
}

if (Test-Path -Path $bashScript -PathType Leaf) {
    if ($SkipBuild) {
        $env:SKIP_BUILD = 'true'
    }

    try {
        bash $bashScript $Action
        exit $LASTEXITCODE
    }
    finally {
        if ($SkipBuild) {
            Remove-Item Env:SKIP_BUILD -ErrorAction SilentlyContinue
        }
    }
}

throw 'No supported implementation found for this OS.'
