---
name: 07.docker-compose-local
description: Automates Docker Compose full-stack workflows for local Pronghorn development, including build prerequisites, startup, verification, logs, stop, and reset operations.
argument-hint: "Use this skill to run the full local stack with Docker Compose and verify its health."
compatibility:
  - linux
  - macos
  - windows
license: MIT
user-invokable: true
---

# Skill: Docker Compose (Full Stack)

This skill implements step 7 from `LOCAL_DEVELOPMENT.md` and automates the full-stack Docker Compose flow.

---

## Prerequisites

- Docker Desktop is installed and running.
- Repository dependencies can be installed (`npm install` in `app/frontend/` and `app/backend/`).
- Frontend/API source builds are valid.

---

## What This Skill Automates

From section 7, this skill automates:
- Build prerequisites:
  - Frontend build with `npx vite build --mode development`
  - API build with `npm run build` in `app/backend/`
- Stack start: `docker compose up --build -d`
- Verification checks:
  - `docker compose ps`
  - API health check (`http://localhost:3001/health`)
  - DB table count query in `db` container
- Logs streaming
- Graceful stop (`docker compose down`)
- Fresh reset (`docker compose down -v` then recreate)

---

## Automated Setup (Recommended)

Use wrapper entrypoints so the script picks the correct implementation for your OS.

Note for maintainers: `docker-compose-local.ps1` and `docker-compose-local.sh` are preferred user entrypoints. `Manage-DockerComposeLocal.ps1` and `manage-docker-compose-local.sh` are internal implementation scripts called by wrappers.

### PowerShell wrapper (recommended on Windows)

```powershell
Set-Location .github/skills/07.docker-compose-local/scripts
.\docker-compose-local.ps1 -Action start
```

### bash wrapper (recommended on Linux/macOS)

```bash
cd .github/skills/07.docker-compose-local/scripts
bash ./docker-compose-local.sh start
```

---

## Actions

### Start full stack (with build prerequisites)

```powershell
Set-Location .github/skills/07.docker-compose-local/scripts
.\docker-compose-local.ps1 -Action start
```

```bash
cd .github/skills/07.docker-compose-local/scripts
bash ./docker-compose-local.sh start
```

### Start without rebuilding

```powershell
Set-Location .github/skills/07.docker-compose-local/scripts
.\docker-compose-local.ps1 -Action start -SkipBuild
```

```bash
cd .github/skills/07.docker-compose-local/scripts
bash ./docker-compose-local.sh start --skip-build
```

### Verify stack

```powershell
Set-Location .github/skills/07.docker-compose-local/scripts
.\docker-compose-local.ps1 -Action verify
```

```bash
cd .github/skills/07.docker-compose-local/scripts
bash ./docker-compose-local.sh verify
```

### Stream logs

```powershell
Set-Location .github/skills/07.docker-compose-local/scripts
.\docker-compose-local.ps1 -Action logs
```

```bash
cd .github/skills/07.docker-compose-local/scripts
bash ./docker-compose-local.sh logs
```

### Show status only

```powershell
Set-Location .github/skills/07.docker-compose-local/scripts
.\docker-compose-local.ps1 -Action status
```

```bash
cd .github/skills/07.docker-compose-local/scripts
bash ./docker-compose-local.sh status
```

### Stop stack (preserve data)

```powershell
Set-Location .github/skills/07.docker-compose-local/scripts
.\docker-compose-local.ps1 -Action stop
```

```bash
cd .github/skills/07.docker-compose-local/scripts
bash ./docker-compose-local.sh stop
```

### Fresh reset (remove volumes and recreate)

```powershell
Set-Location .github/skills/07.docker-compose-local/scripts
.\docker-compose-local.ps1 -Action reset
```

```bash
cd .github/skills/07.docker-compose-local/scripts
bash ./docker-compose-local.sh reset
```

---

## Validation

A healthy stack should provide:

- Frontend accessible at `http://localhost:8081` (Docker nginx)
- API health endpoint reachable at `http://localhost:3001/health`
- DB container running and queryable

Quick manual checks:

```bash
docker compose ps
curl http://localhost:3001/health
docker compose exec db psql -U pronghorn_admin -d pronghorn -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';"
```

---

## Troubleshooting

| Problem | Cause | Solution |
|---------|-------|----------|
| `docker compose` command fails | Docker Desktop not running | Start Docker Desktop and retry |
| Frontend blank page | Frontend build missing/invalid | Re-run `start` without `--skip-build` |
| API health fails | API container not healthy | Check logs: `logs` action |
| DB query fails | DB container not ready | Wait and retry, then use `reset` if needed |
| Wrong API URL in frontend | Build used production mode | Ensure build uses `--mode development` (automated scripts already do this) |

---

## Related Resources

- [LOCAL_DEVELOPMENT.md § 7 — Docker Compose (Full Stack)](../../LOCAL_DEVELOPMENT.md#7-docker-compose-full-stack)
- [Step 6 Skill](../06.verify-local-stack/SKILL.md)
- [LOCAL_DEVELOPMENT.md Troubleshooting](../../LOCAL_DEVELOPMENT.md#troubleshooting)
