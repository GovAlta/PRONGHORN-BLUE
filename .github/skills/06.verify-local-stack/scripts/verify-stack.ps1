<#
.SYNOPSIS
Wrapper script to verify local stack with OS-aware routing.

.DESCRIPTION
Runs PowerShell verification on Windows and falls back to bash verification
when invoked from pwsh on Linux/macOS.

.EXAMPLE
./verify-stack.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$psScript = Join-Path $scriptDir 'Verify-LocalStack.ps1'
$bashScript = Join-Path $scriptDir 'verify-local-stack.sh'

if ($IsWindows -or $env:OS -eq 'Windows_NT') {
    & $psScript
    exit $LASTEXITCODE
}

if (Test-Path -Path $bashScript -PathType Leaf) {
    bash $bashScript
    exit $LASTEXITCODE
}

throw 'No supported implementation found for this OS.'
