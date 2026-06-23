---
name: 04.setup-local-api
description: This skill will guide you through setting up the local API server for Pronghorn development, including installing dependencies, configuring environment variables, and starting the server.
argument-hint: "Please follow the instructions to set up the local API server for Pronghorn development."
compatibility:
  - linux
  - macos
  - windows
license: MIT
user-invokable: true
---


# Skill: Set Up the Local API

This skill guides you through setting up the Pronghorn Express API for local development. You'll install dependencies, configure environment variables using step 4 from LOCAL_DEVELOPMENT.md, and start the API server.

---

## Prerequisites

**Required:**
- Node.js 18+ installed
- npm 9+ installed  
- PostgreSQL running (local or Docker) — see [Skill 02: Setup PostgreSQL](../02.setup-local-postgresql/SKILL.md)
- Database schema migrated — see [Skill 03: Run Local Schema Migration](../03.run-local-schema-migration/SKILL.md)

**Optional (for AI features):**
- Azure AI Foundry credentials to enable chat, code generation, and reasoning

---

## Step 4.1: Install Dependencies

Navigate to the API directory and install npm packages:

```bash
cd app/backend
npm install
```

This installs all required packages:
- **Express** — Web framework
- **TypeScript** — Type-safe JavaScript
- **pg** — PostgreSQL client
- **ws** — WebSocket support
- **ts-node** + **nodemon** — Development hot-reload
- **swagger-ui-express** — Interactive API documentation

---

## Step 4.2: Create Environment File

Create `app/backend/.env` in the API directory with the configuration from LOCAL_DEVELOPMENT.md step 4.2:

### Automated Setup (Recommended)

Use the wrapper script to automatically detect the local OS, then run the correct implementation to create `app/backend/.env` and inject a random 32-character `JWT_SECRET`.

The setup scripts now always write `POSTGRES_PORT=5432` (default PostgreSQL port). Keep this default in `app/backend/.env`; the API runtime automatically falls back to `5433` when `5432` is unavailable or points to a non-target local instance.

Note for maintainers: `setup-api-env.ps1` and `setup-api-env.sh` are the preferred user entrypoints. `New-ApiEnv.ps1` and `new-api-env.sh` are internal implementation scripts called by the wrappers.

#### PowerShell wrapper (recommended on Windows)

```powershell
Set-Location .github/skills/04.setup-local-api/scripts
.\setup-api-env.ps1
```

Overwrite existing `app/backend/.env`:

```powershell
Set-Location .github/skills/04.setup-local-api/scripts
.\setup-api-env.ps1 -Force
```

#### bash wrapper (recommended on Linux/macOS)

```bash
cd .github/skills/04.setup-local-api/scripts
bash ./setup-api-env.sh
```

If `openssl` is not installed, the Linux/macOS script attempts to install it automatically using a supported package manager.

Overwrite existing `app/backend/.env`:

```bash
cd .github/skills/04.setup-local-api/scripts
bash ./setup-api-env.sh --force
```

### JWT Secret Generation Logic

The PowerShell script uses the requested random token generation approach and writes the value directly into `JWT_SECRET`:

```powershell
$jwt = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes((New-Guid).ToString() + (New-Guid).ToString()))
$jwt = -join ($jwt.ToCharArray() | Select-Object -First 32)
```

### Manual Fallback

If you prefer not to use scripts, create `app/backend/.env` manually with the values from LOCAL_DEVELOPMENT.md step 4.2 and set a 32-character `JWT_SECRET`.

### Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POSTGRES_HOST` | ✅ | — | Database hostname (`localhost` for native, `db` for Docker) |
| `POSTGRES_PORT` | — | `5432` | Database port (runtime fallback to `5433` is automatic when needed) |
| `POSTGRES_DATABASE` | — | `pronghorn` | Database name |
| `POSTGRES_USER` | ✅ | — | Database user (`pronghorn_admin` for Docker setup) |
| `POSTGRES_PASSWORD` | ✅ | — | Database password |
| `POSTGRES_SSL` | — | `false` | Disable SSL for local dev |
| `PORT` | — | `3001` | API listen port |
| `NODE_ENV` | — | `development` | Environment mode |
| `ALLOWED_ORIGINS` | — | `*` | CORS-allowed origins |
| `JWT_SECRET` | ✅ | — | JWT signing secret (min 32 chars in production) |
| `FOUNDRY_ENDPOINT` | — | — | Azure AI Foundry endpoint (optional) |
| `FOUNDRY_API_KEY` | — | — | Azure AI Foundry API key (optional) |
| `APIM_OPENAI_URL` | — | — | APIM gateway URL (optional) |
| `AZURE_STORAGE_ACCOUNT_NAME` | — | — | Azure Blob Storage account name (optional; authenticate locally with `az login`) |

---

## Step 4.3: Build and Start the API

### Development Mode (Hot-Reload)

Start the API with automatic reload on file changes:

```bash
npm run dev
```

If your terminal is not currently in `app/backend/`, use this explicit command:

```bash
npm --prefix app/backend run dev
```

Expected output:
```
[nodemon] watching path(s): src/**
[API] Listening on port 3001
[API] PostgreSQL connected to pronghorn
[API] Swagger docs available at http://localhost:3001/api-docs
```

### Production Build

Compile TypeScript and run the compiled output:

```bash
npm run build
node dist/index.js
```

---

## Step 4.4: Verify the API

### Health Check

Verify the API is running and responding:

```bash
curl http://localhost:3001/health
```

Expected response: `200 OK` or `{"status":"ok"}`

### Swagger API Documentation

Open in your browser to see all available endpoints:

```
http://localhost:3001/api-docs
```

### Check Logs

The API logs should show:
- ✅ `PostgreSQL connected to pronghorn` — database connection successful
- ✅ `Swagger docs available at http://localhost:3001/api-docs` — API documentation ready
- ❌ `ECONNREFUSED` — database not running (check PostgreSQL)
- ❌ `Cannot find module` — dependencies not installed (run `npm install`)

---

## Verification Checklist

Before proceeding to the next step:

- [ ] Dependencies installed: `ls -la node_modules/ | wc -l` shows 300+ packages
- [ ] `.env` file exists and is readable: `ls -la app/backend/.env`
- [ ] Database credentials are correct in `.env`
- [ ] API starts without errors: `npm run dev` shows listening on port 3001
- [ ] Health check passes: `curl http://localhost:3001/health` returns 200
- [ ] Swagger docs load: `http://localhost:3001/api-docs` shows endpoints

---

## Troubleshooting

| Problem | Cause | Solution |
|---------|-------|----------|
| **Port 3001 in use** | Another process is listening | `lsof -i :3001` and kill the process, or change PORT in `.env` |
| **Database connection refused** | PostgreSQL not running | Check `docker ps` or `pg_isready -h localhost` |
| **`Cannot find module`** | Dependencies not installed | Run `npm install` from `app/backend/` directory |
| **TypeScript errors** | Invalid configuration | Run `npm run build` to see detailed errors |
| **CORS errors in browser** | Frontend URL not in `ALLOWED_ORIGINS` | Add frontend URL to ALLOWED_ORIGINS in `.env`, restart API |
| **`NODE_ENV not set`** | Environment not configured | Verify `NODE_ENV=development` in `.env` |
| **Hot-reload not working** | Nodemon not watching files | Stop and restart `npm run dev` |
| **`npm run dev` starts Vite instead of API** | Command was run from repo root | Use `cd app/backend && npm run dev` or `npm --prefix app/backend run dev` |

---

## Next Steps

After verifying the API:

1. **[Setup the Frontend](../05.setup-local-front-end/SKILL.md)** — Configure and start React frontend (recommended wrapper commands: PowerShell `Set-Location .github/skills/05.setup-local-front-end/scripts; .\setup-frontend-env.ps1` or bash `cd .github/skills/05.setup-local-front-end/scripts && bash ./setup-frontend-env.sh`)
2. **[Verify the Full Stack](../../LOCAL_DEVELOPMENT.md#6-verify-the-stack)** — Test frontend + API integration
3. **Optional: [Deploy AI Models](../../LOCAL_DEVELOPMENT.md#9-azure-ai-foundry--model-deployment)** — Enable AI features

---

## Related Resources

- **[LOCAL_DEVELOPMENT.md § 4 — Set Up the API](../../LOCAL_DEVELOPMENT.md#4-set-up-the-api)** — Full setup instructions from LOCAL_DEVELOPMENT.md
- **[Environment Variables Reference](../../LOCAL_DEVELOPMENT.md#environment-variables-reference)** — All configurable variables explained
- **[Common Commands](../../LOCAL_DEVELOPMENT.md#common-commands)** — Frequently used CLI commands
- **[Troubleshooting Guide](../../LOCAL_DEVELOPMENT.md#troubleshooting)** — Solutions to common problems
