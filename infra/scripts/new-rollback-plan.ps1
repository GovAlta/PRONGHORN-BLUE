param(
    [Parameter(Mandatory=$true)][string]$SnapshotPath,
    [Parameter(Mandatory=$true)][string]$RollbackScopes,
    [ValidateSet("rollback-plan", "rollback-execute")]
    [string]$Operation = "rollback-plan",
    [string]$Environment,
    [string]$ManifestPath,
    [string]$PreflightResultPath,
    [Parameter(Mandatory=$true)][string]$OutputPath
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\rollback-helpers.ps1"

$manifest = Get-RollbackComponentManifest -ManifestPath $(if ($ManifestPath) { $ManifestPath } else { Get-RollbackManifestPath -BaseDir $PSScriptRoot })
$snapshot = Read-JsonArtifact -Path $SnapshotPath
$preflight = if ($PreflightResultPath -and (Test-Path -LiteralPath $PreflightResultPath)) { Read-JsonArtifact -Path $PreflightResultPath } else { $null }

$normalizedScopes = @(ConvertTo-NormalizedRollbackScopes -RollbackScopes $RollbackScopes -Manifest $manifest)
$selectedComponents = @(Resolve-RollbackComponentSets -Manifest $manifest -SelectedScopes $normalizedScopes)
$orderedComponents = @(Get-RollbackDependencyOrder -ComponentSets $selectedComponents)
$excludedScopes = @($manifest.componentSets | Where-Object { $_.id -notin $normalizedScopes } | ForEach-Object { $_.id })
$preflightChecks = @()

if ($preflight) {
    foreach ($check in $preflight.checks) {
        $preflightChecks += $check
    }
}

$snapshotScopeIds = @($snapshot.componentSets | ForEach-Object { $_.componentSetId })
foreach ($scope in $normalizedScopes) {
    if ($scope -notin $snapshotScopeIds) {
        $preflightChecks += (New-RollbackPreflightCheck -CheckType "snapshot-membership" -Scope $scope -Status "blocked" -Details "Selected rollback scope '$scope' is not present in the source snapshot.")
    }
}

$orderedSteps = @()
foreach ($component in $orderedComponents) {
    $actionType = switch ($component.id) {
        "application-runtime" { if ($Operation -eq "rollback-plan") { "plan-runtime-rollback" } else { "rollback-runtime" } }
        "ai-models" { if ($Operation -eq "rollback-plan") { "plan-ai-rollback" } else { "rollback-ai-deployments" } }
        "database" { if ($Operation -eq "rollback-plan") { "plan-database-rollback" } else { "rollback-database" } }
        "infrastructure" { if ($Operation -eq "rollback-plan") { "plan-infrastructure-rollback" } else { "rollback-infrastructure" } }
        default { "inspect" }
    }

    $resourceRefs = @($component.resources.terraformTargets + $component.resources.scripts)
    $orderedSteps += [pscustomobject]@{
        stepId       = [guid]::NewGuid().ToString()
        scope        = $component.id
        actionType   = $actionType
        status       = "pending"
        resourceRefs = $resourceRefs
        message      = "Prepared rollback step for scope '$($component.id)'."
    }
}

$requiresDestructiveAck = Test-RollbackHasDestructiveScope -ComponentSets $selectedComponents
$blockedCount = @($preflightChecks | Where-Object { $_.status -eq "blocked" }).Count
$resolvedEnvironment = if ($Environment) { $Environment } else { $snapshot.environment }
$resolvedScopes = @($normalizedScopes)
$resolvedOrderedSteps = @($orderedSteps)
$resolvedPreflightChecks = @($preflightChecks)
$resolvedScopesArray = [object[]]($resolvedScopes | ForEach-Object { $_ })
$excludedScopesArray = [object[]]($excludedScopes | ForEach-Object { $_ })
$orderedStepsArray = [object[]]($resolvedOrderedSteps | ForEach-Object { $_ })
$preflightChecksArray = [object[]]($resolvedPreflightChecks | ForEach-Object { $_ })

$plan = [ordered]@{}
$plan["planId"] = [guid]::NewGuid().ToString()
$plan["requestId"] = [guid]::NewGuid().ToString()
$plan["operation"] = $Operation
$plan["environment"] = $resolvedEnvironment
$plan["snapshotPath"] = $SnapshotPath
$plan["snapshotId"] = $snapshot.snapshotId
$plan["resolvedScopes"] = $resolvedScopesArray
$plan["excludedScopes"] = $excludedScopesArray
$plan["orderedSteps"] = $orderedStepsArray
$plan["preflightChecks"] = $preflightChecksArray
$plan["requiresDestructiveAck"] = $requiresDestructiveAck
$plan["safeStopStrategy"] = "Stop remaining destructive scopes, preserve completed stateless actions, and publish follow-up steps for operator reconciliation."

Write-JsonArtifact -Path $OutputPath -Data $plan
$plan | ConvertTo-Json -Depth 20

if ($blockedCount -gt 0) {
    exit 1
}
