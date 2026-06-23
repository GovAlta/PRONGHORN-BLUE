<#
.SYNOPSIS
Wrapper script to create .env.local with OS auto-detection.

.DESCRIPTION
Runs the PowerShell implementation on Windows and falls back to bash
implementation on Linux/macOS when invoked from pwsh.

.PARAMETER Force
Overwrite existing .env.local when provided.

.EXAMPLE
./setup-frontend-env.ps1

.EXAMPLE
./setup-frontend-env.ps1 -Force
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$psScript = Join-Path $scriptDir 'New-FrontendEnv.ps1'
$bashScript = Join-Path $scriptDir 'new-frontend-env.sh'

if ($IsWindows -or $env:OS -eq 'Windows_NT') {
    if ($Force) {
        & $psScript -Force
    }
    else {
        & $psScript
    }
    return
}

if (Test-Path -Path $bashScript -PathType Leaf) {
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
