<#
.SYNOPSIS
Wrapper script to generate app/backend/.env with auto OS handling.

.DESCRIPTION
Runs the local PowerShell implementation on Windows. On Linux/macOS via pwsh,
falls back to the bash implementation if available.

.PARAMETER Force
Overwrite existing app/backend/.env when provided.

.EXAMPLE
./setup-api-env.ps1

.EXAMPLE
./setup-api-env.ps1 -Force
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$psScript = Join-Path $scriptDir 'New-ApiEnv.ps1'
$bashScript = Join-Path $scriptDir 'new-api-env.sh'

if ($IsWindows -or $env:OS -eq 'Windows_NT') {
    if ($Force) {
        & $psScript -Force
    }
    else {
        & $psScript
    }
    return
}

if ((Test-Path -Path $bashScript -PathType Leaf)) {
    if ($Force) {
        $env:FORCE = 'true'
        try {
            bash $bashScript
        }
        finally {
            Remove-Item Env:FORCE -ErrorAction SilentlyContinue
        }
    }
    else {
        bash $bashScript
    }
    return
}

throw 'No supported implementation found for this OS.'
