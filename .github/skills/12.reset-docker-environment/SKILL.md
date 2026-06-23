---
name: 12.reset-docker-environment
description: Stops and removes local Pronghorn nginx/frontend, api, and postgresql/db containers, then lists containers to verify cleanup.
argument-hint: "Use this skill to reset Docker containers for frontend(nginx), api, and db(postgresql)."
compatibility:
  - linux
  - macos
  - windows
license: MIT
user-invokable: true
---

# Skill: Reset Docker Environment

This skill follows the same wrapper-first automation pattern used in previous local setup skills.

Scope:
- Stop Docker containers for `frontend` (nginx), `api`, and `db` (postgresql)
- Remove those containers
- List containers to verify cleanup

---

## Prerequisites

- Docker Desktop (or Docker Engine) running.
- Access to run Docker commands locally.

---

## Automated Setup (Recommended)

Use wrapper entrypoints. These wrappers call internal scripts and keep usage consistent.

- Windows/PowerShell wrapper: `setup-reset-docker-environment.ps1`
- Linux/macOS bash wrapper: `setup-reset-docker-environment.sh`

Maintainer note:
- Entry points are wrapper scripts.
- Internal implementation scripts are:
	- `Manage-ResetDockerEnvironment.ps1`
	- `manage-reset-docker-environment.sh`

### PowerShell wrapper

```powershell
Set-Location .github/skills/12.reset-docker-environment/scripts
.\setup-reset-docker-environment.ps1 -Action all
```

### bash wrapper

```bash
cd .github/skills/12.reset-docker-environment/scripts
bash ./setup-reset-docker-environment.sh all
```

---

## Actions

### 1) Stop and Remove Containers

Targets Compose services: `frontend`, `api`, and `db`.

```powershell
Set-Location .github/skills/12.reset-docker-environment/scripts
.\setup-reset-docker-environment.ps1 -Action reset-containers
```

```bash
cd .github/skills/12.reset-docker-environment/scripts
bash ./setup-reset-docker-environment.sh reset-containers
```

### 2) Verify with Container Listing

Runs container list operation to confirm cleanup.

```powershell
Set-Location .github/skills/12.reset-docker-environment/scripts
.\setup-reset-docker-environment.ps1 -Action list-containers
```

```bash
cd .github/skills/12.reset-docker-environment/scripts
bash ./setup-reset-docker-environment.sh list-containers
```

---

## One-Command Flow

Runs reset and verification in order:
1) stop/remove containers
2) list containers for verification

```powershell
Set-Location .github/skills/12.reset-docker-environment/scripts
.\setup-reset-docker-environment.ps1 -Action all
```

```bash
cd .github/skills/12.reset-docker-environment/scripts
bash ./setup-reset-docker-environment.sh all
```

---

## Validation

- Docker list no longer includes the targeted containers:

```bash
docker container ls -a --format "table {{.Names}}\t{{.Status}}"
```

Expected: no `frontend`, `api`, or `db` containers from the Pronghorn compose stack.

