param(
    [Parameter(Mandatory=$true)][string]$SnapshotReference,
    [Parameter(Mandatory=$true)][string]$OutputPath
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\rollback-helpers.ps1"

$candidatePaths = @(
    $SnapshotReference,
    (Join-Path (Get-Location).Path $SnapshotReference),
    (Join-Path (Split-Path -Parent $PSScriptRoot) $SnapshotReference)
) | Select-Object -Unique

$resolvedPath = $candidatePaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $resolvedPath) {
    throw "Unable to resolve rollback snapshot reference: $SnapshotReference"
}

$snapshot = Read-JsonArtifact -Path $resolvedPath
Write-JsonArtifact -Path $OutputPath -Data $snapshot
$snapshot | ConvertTo-Json -Depth 20
