param(
    [Parameter(Mandatory=$true)][string]$RecordPath,
    [string]$SchemaPath,
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\rollback-helpers.ps1"

$record = Read-JsonArtifact -Path $RecordPath
$errors = New-Object System.Collections.Generic.List[string]

$requiredTopLevel = @("executionId", "planId", "environment", "selectedScopes", "overallStatus", "steps", "startedAt")
foreach ($property in $requiredTopLevel) {
    if (-not ($record.PSObject.Properties.Name -contains $property) -or $null -eq $record.$property) {
        $errors.Add("Missing required property '$property'.")
    }
}

$allowedStatuses = @("completed", "partially-completed", "blocked", "failed")
if ($record.PSObject.Properties.Name -contains "overallStatus" -and $record.overallStatus -notin $allowedStatuses) {
    $errors.Add("Invalid overallStatus '$($record.overallStatus)'.")
}

foreach ($step in @($record.steps)) {
    foreach ($property in @("stepId", "scope", "actionType", "status", "message")) {
        if (-not ($step.PSObject.Properties.Name -contains $property) -or $null -eq $step.$property -or [string]::IsNullOrWhiteSpace([string]$step.$property)) {
            $errors.Add("Rollback step is missing required property '$property'.")
        }
    }
}

$result = [pscustomobject]@{
    recordPath = $RecordPath
    valid      = ($errors.Count -eq 0)
    errorCount = $errors.Count
    errors     = @($errors)
}

if ($OutputPath) {
    Write-JsonArtifact -Path $OutputPath -Data $result
}

$result | ConvertTo-Json -Depth 10

if ($errors.Count -gt 0) {
    exit 1
}
