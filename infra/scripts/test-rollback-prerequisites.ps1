param(
    [ValidateSet("deploy", "rollback-plan", "rollback-execute")]
    [string]$Operation = "rollback-plan",
    [ValidateSet("dev", "test", "prod")]
    [string]$Environment = "dev",
    [string]$RollbackSnapshot,
    [string]$RollbackScopes,
    [switch]$RollbackAllowDestructive,
    [string]$RollbackAckToken,
    [string]$ManifestPath,
    [string]$OutputPath,
    [switch]$SkipAzureLoginCheck
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\rollback-helpers.ps1"

$manifest = Get-RollbackComponentManifest -ManifestPath $(if ($ManifestPath) { $ManifestPath } else { Get-RollbackManifestPath -BaseDir $PSScriptRoot })
$checks = New-Object System.Collections.Generic.List[object]

if ($Operation -eq "deploy") {
    $checks.Add((New-RollbackPreflightCheck -CheckType "operation" -Status "passed" -Details "Deployment mode selected; rollback prerequisites are not required."))
} else {
    try {
        $normalizedScopes = @(ConvertTo-NormalizedRollbackScopes -RollbackScopes $RollbackScopes -Manifest $manifest)
        if ($normalizedScopes.Count -eq 0) {
            $checks.Add((New-RollbackPreflightCheck -CheckType "scopes" -Status "blocked" -Details "At least one rollback scope must be selected."))
        } else {
            $checks.Add((New-RollbackPreflightCheck -CheckType "scopes" -Status "passed" -Details "Rollback scopes are valid: $($normalizedScopes -join ', ')"))
        }
    } catch {
        $checks.Add((New-RollbackPreflightCheck -CheckType "scopes" -Status "blocked" -Details $_.Exception.Message))
        $normalizedScopes = @()
    }

    if ([string]::IsNullOrWhiteSpace($RollbackSnapshot)) {
        $checks.Add((New-RollbackPreflightCheck -CheckType "snapshot" -Status "blocked" -Details "A rollback snapshot reference is required for rollback operations."))
    } else {
        $checks.Add((New-RollbackPreflightCheck -CheckType "snapshot" -Status "passed" -Details "Rollback snapshot reference was supplied."))
    }

    $requiredEnvVars = @("AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID", "TFSTATE_KEY", "TFSTATE_RESOURCE_GROUP", "TFSTATE_STORAGE_ACCOUNT", "TFSTATE_CONTAINER")
    $missingEnvVars = @($requiredEnvVars | Where-Object { [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_)) })
    if ($missingEnvVars.Count -gt 0) {
        $checks.Add((New-RollbackPreflightCheck -CheckType "environment" -Status "blocked" -Details "Missing required environment configuration: $($missingEnvVars -join ', ')"))
    } else {
        $checks.Add((New-RollbackPreflightCheck -CheckType "environment" -Status "passed" -Details "Required environment configuration is present."))
    }

    if (-not $SkipAzureLoginCheck) {
        az account show *> $null
        if ($LASTEXITCODE -ne 0) {
            $checks.Add((New-RollbackPreflightCheck -CheckType "auth" -Status "blocked" -Details "Azure CLI login is required before rollback planning or execution."))
        } else {
            $checks.Add((New-RollbackPreflightCheck -CheckType "auth" -Status "passed" -Details "Azure CLI login is active."))
        }
    } else {
        $checks.Add((New-RollbackPreflightCheck -CheckType "auth" -Status "warning" -Details "Azure login validation was skipped."))
    }

    if ($normalizedScopes.Count -gt 0) {
        $selectedComponents = @(Resolve-RollbackComponentSets -Manifest $manifest -SelectedScopes $normalizedScopes)
        if (Test-RollbackHasDestructiveScope -ComponentSets $selectedComponents) {
            if (-not $RollbackAllowDestructive) {
                $checks.Add((New-RollbackPreflightCheck -CheckType "destructive-ack" -Scope "global" -Status "blocked" -Details "Destructive rollback scopes require rollback_allow_destructive=true."))
            } elseif ([string]::IsNullOrWhiteSpace($RollbackAckToken)) {
                $checks.Add((New-RollbackPreflightCheck -CheckType "destructive-ack" -Scope "global" -Status "blocked" -Details "Destructive rollback scopes require an acknowledgement token."))
            } else {
                $checks.Add((New-RollbackPreflightCheck -CheckType "destructive-ack" -Scope "global" -Status "passed" -Details "Destructive rollback acknowledgement was provided."))
            }
        }
    }
}

$blockedChecks = @($checks | Where-Object { $_.status -eq "blocked" })
$resolvedScopes = @(Split-RollbackScopes -RollbackScopes $RollbackScopes)
$checkArray = [object[]]($checks | ForEach-Object { $_ })
$scopeArray = [object[]]($resolvedScopes | ForEach-Object { $_ })
$result = [ordered]@{}
$result["operation"] = $Operation
$result["environment"] = $Environment
$result["rollbackSnapshot"] = $RollbackSnapshot
$result["rollbackScopes"] = $scopeArray
$result["checks"] = $checkArray
$result["blockedCount"] = $blockedChecks.Count
$result["passed"] = ($blockedChecks.Count -eq 0)

if ($OutputPath) {
    Write-JsonArtifact -Path $OutputPath -Data $result
}

$result | ConvertTo-Json -Depth 20

if ($blockedChecks.Count -gt 0) {
    exit 1
}
