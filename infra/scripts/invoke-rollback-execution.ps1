param(
    [Parameter(Mandatory=$true)][string]$PlanPath,
    [switch]$RollbackAllowDestructive,
    [string]$RollbackAckToken,
    [switch]$DryRun,
    [Parameter(Mandatory=$true)][string]$OutputPath
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\rollback-helpers.ps1"

$plan = Read-JsonArtifact -Path $PlanPath
$snapshot = Read-JsonArtifact -Path $plan.snapshotPath

$executionSteps = New-Object System.Collections.Generic.List[object]
$stopAfterFailure = $false

foreach ($check in @($plan.preflightChecks | Where-Object { $_.status -eq "blocked" })) {
    $executionSteps.Add([pscustomobject]@{
        stepId      = [guid]::NewGuid().ToString()
        scope       = $check.scope
        actionType  = "preflight"
        status      = "blocked"
        message     = $check.details
        startedAt   = (Get-Date).ToString("o")
        completedAt = (Get-Date).ToString("o")
    })
}

if (@($executionSteps).Count -gt 0) {
    $blockedRecord = [pscustomobject]@{
        executionId    = [guid]::NewGuid().ToString()
        planId         = $plan.planId
        environment    = $plan.environment
        selectedScopes = @($plan.resolvedScopes)
        overallStatus  = "blocked"
        startedAt      = (Get-Date).ToString("o")
        completedAt    = (Get-Date).ToString("o")
        steps          = @($executionSteps)
    }

    Write-JsonArtifact -Path $OutputPath -Data $blockedRecord
    $blockedRecord | ConvertTo-Json -Depth 20
    exit 1
}

$resourceGroup = $snapshot.outputs.resource_group_name
$aiAccountName = $snapshot.outputs.ai_foundry_account_name
if ([string]::IsNullOrWhiteSpace($aiAccountName) -and -not [string]::IsNullOrWhiteSpace($resourceGroup)) {
    $aiAccountName = az cognitiveservices account list --resource-group $resourceGroup --query "[0].name" -o tsv 2>$null
}

foreach ($step in $plan.orderedSteps) {
    $startedAt = (Get-Date).ToString("o")
    if ($stopAfterFailure) {
        $executionSteps.Add([pscustomobject]@{
            stepId      = $step.stepId
            scope       = $step.scope
            actionType  = $step.actionType
            status      = "blocked"
            message     = "Skipped because a previous rollback step failed."
            startedAt   = $startedAt
            completedAt = (Get-Date).ToString("o")
        })
        continue
    }

    try {
        switch ($step.scope) {
            "application-runtime" {
                & "$PSScriptRoot\deploy-containers.ps1" -Rollback -RollbackSnapshotPath $plan.snapshotPath -DryRun:$DryRun
            }
            "ai-models" {
                & "$PSScriptRoot\deploy-models.ps1" -ResourceGroup $resourceGroup -AccountName $aiAccountName -Environment $plan.environment -Rollback -RollbackSnapshotPath $plan.snapshotPath -DryRun:$DryRun
            }
            "database" {
                & "$PSScriptRoot\deploy.ps1" -Environment $plan.environment -Rollback -RollbackPlanPath $PlanPath -RollbackScope database -RollbackSnapshotPath $plan.snapshotPath -RollbackAllowDestructive:$RollbackAllowDestructive -RollbackAckToken $RollbackAckToken -DryRun:$DryRun
            }
            "infrastructure" {
                & "$PSScriptRoot\deploy.ps1" -Environment $plan.environment -Rollback -RollbackPlanPath $PlanPath -RollbackScope infrastructure -RollbackSnapshotPath $plan.snapshotPath -RollbackAllowDestructive:$RollbackAllowDestructive -RollbackAckToken $RollbackAckToken -DryRun:$DryRun
            }
            default {
                throw "Unsupported rollback scope '$($step.scope)'."
            }
        }

        if ($LASTEXITCODE -ne 0) {
            throw "Rollback command failed for scope '$($step.scope)'."
        }

        $executionSteps.Add([pscustomobject]@{
            stepId      = $step.stepId
            scope       = $step.scope
            actionType  = $step.actionType
            status      = "completed"
            message     = if ($DryRun) { "Rollback preview completed for scope '$($step.scope)'." } else { "Rollback completed for scope '$($step.scope)'." }
            startedAt   = $startedAt
            completedAt = (Get-Date).ToString("o")
        })
    } catch {
        $stopAfterFailure = $true
        $executionSteps.Add([pscustomobject]@{
            stepId      = $step.stepId
            scope       = $step.scope
            actionType  = $step.actionType
            status      = "failed"
            message     = $_.Exception.Message
            startedAt   = $startedAt
            completedAt = (Get-Date).ToString("o")
        })
    }
}

$stepStatuses = @($executionSteps | ForEach-Object { $_.status })
$overallStatus = if ($stepStatuses -contains "failed") {
    if ($stepStatuses -contains "completed") { "partially-completed" } else { "failed" }
} elseif ($stepStatuses -contains "blocked") {
    if ($stepStatuses -contains "completed") { "partially-completed" } else { "blocked" }
} else {
    "completed"
}

$record = [pscustomobject]@{
    executionId    = [guid]::NewGuid().ToString()
    planId         = $plan.planId
    environment    = $plan.environment
    selectedScopes = @($plan.resolvedScopes)
    overallStatus  = $overallStatus
    startedAt      = (Get-Date).ToString("o")
    completedAt    = (Get-Date).ToString("o")
    steps          = @($executionSteps)
}

Write-JsonArtifact -Path $OutputPath -Data $record
$record | ConvertTo-Json -Depth 20

if ($overallStatus -in @("failed", "blocked", "partially-completed")) {
    exit 1
}