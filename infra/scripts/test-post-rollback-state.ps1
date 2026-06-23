param(
    [Parameter(Mandatory=$true)][string]$SnapshotPath,
    [Parameter(Mandatory=$true)][string]$ExecutionRecordPath,
    [string]$Scopes,
    [Parameter(Mandatory=$true)][string]$OutputPath
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\rollback-helpers.ps1"

$snapshot = Read-JsonArtifact -Path $SnapshotPath
$record = Read-JsonArtifact -Path $ExecutionRecordPath
$manifest = Get-RollbackComponentManifest -ManifestPath (Get-RollbackManifestPath -BaseDir $PSScriptRoot)
$scopeFilter = if ($Scopes) { Split-RollbackScopes -RollbackScopes $Scopes } else { @($record.selectedScopes) }

$results = foreach ($scope in $scopeFilter) {
    $matchingSteps = @($record.steps | Where-Object { $_.scope -eq $scope })
    $status = if ($matchingSteps.Count -eq 0) { "warning" } elseif (@($matchingSteps | Where-Object { $_.status -eq "failed" }).Count -gt 0) { "failed" } else { "passed" }
    $details = if ($matchingSteps.Count -eq 0) {
        "No rollback execution steps were recorded for scope '$scope'."
    } else {
        "Recorded $($matchingSteps.Count) step(s) for scope '$scope'."
    }

    [pscustomobject]@{
        scope   = $scope
        status  = $status
        details = $details
    }
}

$summary = [pscustomobject]@{
    snapshotId = $snapshot.snapshotId
    executionId = $record.executionId
    validations = @($results)
}

Write-JsonArtifact -Path $OutputPath -Data $summary
$summary | ConvertTo-Json -Depth 10

if (@($results | Where-Object { $_.status -eq "failed" }).Count -gt 0) {
    exit 1
}
