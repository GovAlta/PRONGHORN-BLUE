<#
.SYNOPSIS
    Removes Pronghorn Azure resources and marks local env values as reset.

.DESCRIPTION
    Executes one or more reset actions:
    - remove-app-registration: delete Microsoft Entra app registration by display name
    - remove-resource-group: delete Azure resource group
    - update-env-files: append "(reset/removed)" to relevant actual values in .env* files

.PARAMETER Action
    Action to execute: remove-app-registration, remove-resource-group, update-env-files, all.

.PARAMETER ResourceGroupName
    Resource group name to delete.

.PARAMETER AppDisplayName
    App registration display name to delete.

.PARAMETER RepoRoot
    Optional repo root path. If omitted, resolved from script location.

.EXAMPLE
    .\Manage-ResetAzureEnvironment.ps1 -Action all -ResourceGroupName "pronghorn-blue" -AppDisplayName "pronghorn-app"
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $false)]
    [ValidateSet('remove-app-registration', 'remove-resource-group', 'update-env-files', 'all')]
    [string]$Action = 'all',

    [Parameter(Mandatory = $false)]
    [ValidateNotNullOrEmpty()]
    [string]$ResourceGroupName = 'pronghorn-blue',

    [Parameter(Mandatory = $false)]
    [ValidateNotNullOrEmpty()]
    [string]$AppDisplayName = 'pronghorn-app',

    [Parameter(Mandatory = $false)]
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'

function Write-Info {
    <#
    .SYNOPSIS
        Writes informational output.
    .PARAMETER Message
        Message text.
    .EXAMPLE
        Write-Info -Message "Checking prerequisites"
    #>
    param(
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$Message
    )

    Write-Host "[INFO] $Message" -ForegroundColor Cyan
}

function Write-Success {
    <#
    .SYNOPSIS
        Writes success output.
    .PARAMETER Message
        Message text.
    .EXAMPLE
        Write-Success -Message "Done"
    #>
    param(
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$Message
    )

    Write-Host "[OK] $Message" -ForegroundColor Green
}

function Get-ResolvedRepoRoot {
    <#
    .SYNOPSIS
        Resolves repository root.
    .PARAMETER OptionalRepoRoot
        Optional explicit root path.
    .EXAMPLE
        Get-ResolvedRepoRoot -OptionalRepoRoot "."
    #>
    param(
        [Parameter(Mandatory = $false)]
        [string]$OptionalRepoRoot
    )

    if (-not [string]::IsNullOrWhiteSpace($OptionalRepoRoot)) {
        $explicitPath = Resolve-Path -Path $OptionalRepoRoot -ErrorAction Stop
        return $explicitPath.Path
    }

    $defaultRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..') -ErrorAction Stop
    return $defaultRoot.Path
}

function Test-AzureLoggedIn {
    <#
    .SYNOPSIS
        Checks whether Azure CLI is logged in.
    .EXAMPLE
        Test-AzureLoggedIn
    #>
    $accountId = az account show --query id -o tsv 2>$null
    if ($LASTEXITCODE -ne 0) {
        return $false
    }

    return -not [string]::IsNullOrWhiteSpace($accountId)
}

function Assert-AzureCliReady {
    <#
    .SYNOPSIS
        Validates Azure CLI installation and authentication.
    .EXAMPLE
        Assert-AzureCliReady
    #>
    $azCommand = Get-Command az -ErrorAction SilentlyContinue
    if (-not $azCommand) {
        throw 'Azure CLI not found. Install from https://learn.microsoft.com/cli/azure/install-azure-cli'
    }

    if (-not (Test-AzureLoggedIn)) {
        throw "Azure CLI is not authenticated. Run 'az login' and retry."
    }
}

function Remove-AppRegistrationByDisplayName {
    <#
    .SYNOPSIS
        Deletes app registrations matching a display name.
    .PARAMETER DisplayName
        Display name to search and delete.
    .EXAMPLE
        Remove-AppRegistrationByDisplayName -DisplayName "pronghorn-app"
    #>
    param(
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$DisplayName
    )

    Assert-AzureCliReady

    $applicationIds = az ad app list --display-name $DisplayName --query "[].appId" -o tsv
    if ([string]::IsNullOrWhiteSpace($applicationIds)) {
        Write-Info "No app registration found for display name '$DisplayName'."
        return
    }

    foreach ($applicationId in ($applicationIds -split "`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        if ($PSCmdlet.ShouldProcess("App registration $applicationId", 'Delete')) {
            az ad app delete --id $applicationId | Out-Null
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to delete app registration '$applicationId'."
            }

            Write-Success "Deleted app registration: $applicationId"
        }
    }
}

function Remove-ResourceGroupByName {
    <#
    .SYNOPSIS
        Deletes an Azure resource group.
    .PARAMETER Name
        Resource group name.
    .EXAMPLE
        Remove-ResourceGroupByName -Name "pronghorn-blue"
    #>
    param(
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$Name
    )

    Assert-AzureCliReady

    $exists = az group exists --name $Name
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to verify existence of resource group '$Name'."
    }

    if ($exists -ne 'true') {
        Write-Info "Resource group '$Name' was not found."
        return
    }

    if ($PSCmdlet.ShouldProcess("Resource group $Name", 'Delete')) {
        az group delete --name $Name --yes --no-wait | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to request deletion for resource group '$Name'."
        }

        Write-Success "Deletion requested for resource group: $Name"
    }
}

function Test-IsActualValue {
    <#
    .SYNOPSIS
        Determines if an env value should be marked as reset/removed.
    .PARAMETER Value
        Environment variable value.
    .EXAMPLE
        Test-IsActualValue -Value "https://example.com"
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $trimmedValue = $Value.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmedValue)) {
        return $false
    }

    if ($trimmedValue -match '\(reset/removed\)$') {
        return $false
    }

    if ($trimmedValue -match '^(your-|<|\$\{|\{\{|REPLACE_ME)') {
        return $false
    }

    return $true
}

function Update-EnvFilesWithResetMarker {
    <#
    .SYNOPSIS
        Appends (reset/removed) to relevant actual values in .env* files.
    .PARAMETER RootPath
        Repository root path.
    .EXAMPLE
        Update-EnvFilesWithResetMarker -RootPath "."
    #>
    param(
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$RootPath
    )

    $targetKeys = @(
        'FOUNDRY_ENDPOINT',
        'FOUNDRY_API_KEY',
        'APIM_OPENAI_URL',
        'AZURE_TENANT_ID',
        'AZURE_CLIENT_ID',
        'AZURE_OAUTH_CLIENT_ID',
        'VITE_AZURE_CLIENT_ID',
        'VITE_AZURE_TENANT_ID',
        'VITE_AZURE_REDIRECT_URI',
        'VITE_API_BASE_URL',
        'API_BASE_URL',
        'FRONTEND_URL'
    )

    $envFiles = @(
        (Join-Path $RootPath '.env'),
        (Join-Path $RootPath '.env.local'),
        (Join-Path $RootPath '.env.development'),
        (Join-Path $RootPath '.env.production'),
        (Join-Path $RootPath '.env.test'),
        (Join-Path $RootPath 'app/backend/.env'),
        (Join-Path $RootPath 'app/backend/.env.local'),
        (Join-Path $RootPath 'app/backend/.env.development'),
        (Join-Path $RootPath 'app/backend/.env.production'),
        (Join-Path $RootPath 'app/backend/.env.test')
    ) | Where-Object { Test-Path -Path $_ }

    if ($envFiles.Count -eq 0) {
        Write-Info 'No .env* files found to update.'
        return
    }

    foreach ($envFile in $envFiles) {
        $lines = Get-Content -Path $envFile
        $hasFileChanges = $false

        $updatedLines = foreach ($line in $lines) {
            if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith('#') -or -not $line.Contains('=')) {
                $line
                continue
            }

            $separatorIndex = $line.IndexOf('=')
            $key = $line.Substring(0, $separatorIndex).Trim()
            $value = $line.Substring($separatorIndex + 1)

            if ($key -notin $targetKeys) {
                $line
                continue
            }

            if (-not (Test-IsActualValue -Value $value)) {
                $line
                continue
            }

            $hasFileChanges = $true
            "$key=$value(reset/removed)"
        }

        if (-not $hasFileChanges) {
            continue
        }

        if ($PSCmdlet.ShouldProcess($envFile, 'Append reset marker to relevant values')) {
            $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
            [System.IO.File]::WriteAllLines($envFile, $updatedLines, $utf8NoBom)
            Write-Success "Updated env values in: $envFile"
        }
    }
}

$resolvedRoot = Get-ResolvedRepoRoot -OptionalRepoRoot $RepoRoot

switch ($Action) {
    'remove-app-registration' {
        Write-Info "Removing app registration '$AppDisplayName'..."
        Remove-AppRegistrationByDisplayName -DisplayName $AppDisplayName
    }
    'remove-resource-group' {
        Write-Info "Removing resource group '$ResourceGroupName'..."
        Remove-ResourceGroupByName -Name $ResourceGroupName
    }
    'update-env-files' {
        Write-Info 'Updating relevant .env* files with reset marker...'
        Update-EnvFilesWithResetMarker -RootPath $resolvedRoot
    }
    'all' {
        Write-Info "Removing app registration '$AppDisplayName'..."
        Remove-AppRegistrationByDisplayName -DisplayName $AppDisplayName

        Write-Info "Removing resource group '$ResourceGroupName'..."
        Remove-ResourceGroupByName -Name $ResourceGroupName

        Write-Info 'Updating relevant .env* files with reset marker...'
        Update-EnvFilesWithResetMarker -RootPath $resolvedRoot
    }
    default {
        throw "Unsupported action: $Action"
    }
}

Write-Success 'Azure environment reset workflow completed.'
