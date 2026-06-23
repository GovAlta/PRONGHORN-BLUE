---
name: 02.setup-local-postgresql
description: This skill will guide you through the process of setting up PostgreSQL on your local machine.
argument-hint: "Please follow the instructions to set up PostgreSQL on your local machine."
compatibility:
  - linux
  - macos
  - windows
license: MIT
user-invokable: true
---

# Setup PostgreSQL local instance with Docker

This skill will guide you through the process of setting up a PostgreSQL database on your local machine using Docker. This setup will allow you to have a local instance of PostgreSQL running, which can be used for development and testing purposes.

## When to use this skill
- When you need a local PostgreSQL database for development or testing.
- When you want to quickly set up a PostgreSQL instance without installing it directly on your machine.
- When you want to ensure a consistent environment for your database across different machines.

## Pre-requisites
- Ensure you have Docker installed on your machine. You can download it from [Docker's official website](https://www.docker.com/get-started).
- On Windows, use an elevated PowerShell session when automatic stop/disable of conflicting PostgreSQL Windows services is required.

## Setting Up PostgreSQL with Docker

Run the PowerShell script in your terminal to set up a PostgreSQL Docker container for Pronghorn development:

```powershell
& ".\.github\skills\02.setup-local-postgresql\scripts\Setup-LocalPostgreSql.ps1"
```

This script:
- Validates Docker CLI availability
- Checks if a PostgreSQL container already exists
- Creates a new PostgreSQL 16-Alpine container if needed (or starts it with `-StartIfExists`)
- Uses the local development default password configured by the script (`localdev123`)
- On Windows, detects PostgreSQL services conflicting with the requested host port, then attempts to stop/disable them so Docker can bind the port
- Verifies readiness with `pg_isready` after creation/start

> Keep Docker PostgreSQL on `5432` for local defaults. The API runtime dynamically retries common fallback port `5433` only when `5432` is unavailable or mismatched.

## Usage Examples

### Quick Start (Default Configuration)

```powershell
& ".\.github\skills\02.setup-local-postgresql\scripts\Setup-LocalPostgreSql.ps1"
# Creates container: pronghorn-db
# User: pronghorn_admin
# Database: pronghorn
# Port: 5432
```

### Start Existing Container

If a container already exists and is stopped, start it with:

```powershell
& ".\.github\skills\02.setup-local-postgresql\scripts\Setup-LocalPostgreSql.ps1" -StartIfExists
```

### Custom Configuration

```powershell
& ".\.github\skills\02.setup-local-postgresql\scripts\Setup-LocalPostgreSql.ps1" `
  -ContainerName my-postgres `
  -PostgresUser myuser `
  -DatabaseName mydb `
  -HostPort 5433
```

### With Pre-Supplied Password

This script currently uses a local-dev default password and does not expose a `-PostgresPassword` parameter.

## Verification

Once the script completes successfully, you will see PostgreSQL readiness output:

```
Verifying PostgreSQL readiness for container 'pronghorn-db'...
/var/run/postgresql:5432 - accepting connections
Expected output: /var/run/postgresql:5432 - accepting connections
```

This confirms your PostgreSQL instance is running and ready for connections.

## Troubleshooting

### "Access is denied" while stopping/disabling PostgreSQL service

If the setup script detects a conflicting Windows PostgreSQL service on the requested host port (for example `5432`) but cannot stop/disable it, run PowerShell as Administrator and execute:

```powershell
Stop-Service -Name postgresql-x64-17 -Force
Set-Service -Name postgresql-x64-17 -StartupType Disabled
```

Then rerun the setup script.