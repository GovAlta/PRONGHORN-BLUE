<#
.SYNOPSIS
Sets up a local PostgreSQL Docker container for Pronghorn development.

.DESCRIPTION
Checks Docker availability and existing container state, then creates a new PostgreSQL container
if one with the target name does not already exist. On Windows, when the requested host port is
already owned by a PostgreSQL Windows service, the script attempts to stop and disable that service.

.PARAMETER ContainerName
The Docker container name to create or check.

.PARAMETER PostgresUser
The PostgreSQL username to configure.

.PARAMETER DatabaseName
The PostgreSQL database name to create.

.PARAMETER HostPort
The local host port to map to PostgreSQL container port 5432.

.PARAMETER Image
The Docker image to use for PostgreSQL.

.PARAMETER StartIfExists
When specified, starts the existing container if it already exists and is stopped.

.EXAMPLE
.\setup-postgresql.ps1

.EXAMPLE
.\setup-postgresql.ps1 -ContainerName pronghorn-db -PostgresUser pronghorn_admin -DatabaseName pronghorn -HostPort 5432

.EXAMPLE
.\setup-postgresql.ps1 -StartIfExists
#>
[CmdletBinding()]
param(
  [Parameter()]
  [ValidateNotNullOrEmpty()]
  [string]$ContainerName = 'pronghorn-db',

  [Parameter()]
  [ValidateNotNullOrEmpty()]
  [string]$PostgresUser = 'pronghorn_admin',

  [Parameter()]
  [ValidateNotNullOrEmpty()]
  [string]$DatabaseName = 'pronghorn',

  [Parameter()]
  [ValidateRange(1, 65535)]
  [int]$HostPort = 5432,

  [Parameter()]
  [ValidateNotNullOrEmpty()]
  [string]$Image = 'postgres:16-alpine',

  [Parameter()]
  [switch]$StartIfExists
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Default password for local development (hardcoded for convenience, override as needed)
$plainPassword = 'localdev123'

function Test-PostgresContainerReadiness {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$Name,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$User,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$Database
  )

  Write-Host "Verifying PostgreSQL readiness for container '$Name'..."
  $readinessOutput = docker exec $Name pg_isready -U $User -d $Database
  Write-Host $readinessOutput
  Write-Host 'Expected output: /var/run/postgresql:5432 - accepting connections'
}

function Resolve-ConflictingWindowsPostgresService {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]
    [ValidateRange(1, 65535)]
    [int]$Port
  )

  if (-not $IsWindows -and $env:OS -ne 'Windows_NT') {
    return
  }

  if (-not (Get-Command -Name Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
    return
  }

  $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (-not $listeners) {
    return
  }

  $listenerProcessIds = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
  $nonDockerPids = @()

  foreach ($listenerProcessId in $listenerProcessIds) {
    $process = Get-Process -Id $listenerProcessId -ErrorAction SilentlyContinue
    if (-not $process) {
      continue
    }

    if ($process.ProcessName -in @('com.docker.backend', 'wslrelay')) {
      continue
    }

    $nonDockerPids += $listenerProcessId
  }

  if (-not $nonDockerPids) {
    return
  }

  $serviceCandidates = Get-CimInstance Win32_Service |
    Where-Object {
      $_.ProcessId -in $nonDockerPids -and (
        $_.Name -match 'postgres|pgsql' -or
        $_.DisplayName -match 'postgres|pgsql'
      )
    }

  if (-not $serviceCandidates) {
    throw "Host port $Port is in use by a non-Docker process. Free this port or change -HostPort."
  }

  foreach ($service in $serviceCandidates) {
    try {
      Write-Host "Stopping conflicting service '$($service.Name)' on port $Port..."
      Stop-Service -Name $service.Name -Force -ErrorAction Stop
      Write-Host "Disabling service '$($service.Name)' startup type..."
      Set-Service -Name $service.Name -StartupType Disabled -ErrorAction Stop
    } catch {
      throw "Unable to stop/disable service '$($service.Name)' on port $Port. Run PowerShell as Administrator or execute: Stop-Service -Name $($service.Name) -Force; Set-Service -Name $($service.Name) -StartupType Disabled"
    }
  }

  Start-Sleep -Seconds 1

  $remainingListeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($remainingListeners) {
    $remainingPids = $remainingListeners | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($remainingPid in $remainingPids) {
      $remainingProcess = Get-Process -Id $remainingPid -ErrorAction SilentlyContinue
      if ($remainingProcess -and $remainingProcess.ProcessName -notin @('com.docker.backend', 'wslrelay')) {
        throw "Host port $Port remains in use by process '$($remainingProcess.ProcessName)' (PID $remainingPid)."
      }
    }
  }
}

if (-not (Get-Command -Name docker -ErrorAction SilentlyContinue)) {
  throw 'Docker CLI is not installed or not available in PATH.'
}

docker --version

Resolve-ConflictingWindowsPostgresService -Port $HostPort

$existingContainer = docker ps -a --filter "name=^$ContainerName$" --format "{{.Names}}`t{{.Status}}"
if ($existingContainer) {
  Write-Host "Container already exists: $existingContainer"

  if ($StartIfExists) {
    $isRunning = docker inspect --format '{{.State.Running}}' $ContainerName

    if ($isRunning -eq 'true') {
      Write-Host "Container '$ContainerName' is already running."
      Test-PostgresContainerReadiness -Name $ContainerName -User $PostgresUser -Database $DatabaseName
      return
    }

    Write-Host "Starting existing container '$ContainerName'..."
    docker start $ContainerName | Out-Null
    Write-Host "Container '$ContainerName' started."
    Test-PostgresContainerReadiness -Name $ContainerName -User $PostgresUser -Database $DatabaseName
    return
  }

  Write-Host 'Skipping container creation.'
  return
}


  $dockerArgs = @(
    'run', '-d',
    '--name', $ContainerName,
    '-e', "POSTGRES_USER=$PostgresUser",
    '-e', "POSTGRES_PASSWORD=$plainPassword",
    '-e', "POSTGRES_DB=$DatabaseName",
    '-p', "$($HostPort):5432",
    $Image
  )

  docker @dockerArgs
  Test-PostgresContainerReadiness -Name $ContainerName -User $PostgresUser -Database $DatabaseName