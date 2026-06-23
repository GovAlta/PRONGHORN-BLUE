---
name: 05.setup-local-front-end
description: This skill will guide you through setting up the local frontend for Pronghorn development, including installing dependencies, configuring .env.local, and starting the Vite development server.
argument-hint: "Please follow the instructions to set up the local frontend for Pronghorn development."
compatibility:
  - linux
  - macos
  - windows
license: MIT
user-invokable: true
---

# Skill: Set Up the Frontend

This skill guides you through setting up the Pronghorn React frontend for local development using step 5 from `LOCAL_DEVELOPMENT.md`.

---

## Prerequisites

**Required:**
- Node.js 18+ installed
- npm 9+ installed
- API running locally at `http://localhost:3001` — see [Skill 04: Setup Local API](../04.setup-local-api/SKILL.md)

**Optional (for auth and realtime validation):**
- Azure AD app registration configured for local redirect URIs
- WebSocket-ready API at `ws://localhost:3001/ws`

---

## Step 5.1: Install Dependencies

From `app/frontend/`, install frontend dependencies:

```bash
cd app/frontend
npm install
```

If npm reports a Vite peer dependency resolution error (for example `vite-plugin-pwa` with newer Vite versions), use:

```bash
npm install --legacy-peer-deps
```

If you are currently in `app/backend/`, switch to the frontend directory:

```bash
cd ../frontend
npm install
```

---

## Step 5.2: Create `.env.local`

Create `.env.local` in `app/frontend/` using the values from `LOCAL_DEVELOPMENT.md` step 5.2.

### Automated Setup (Recommended)

Use wrapper scripts to auto-detect OS and create `.env.local`.

The scripts also handle Entra app registration setup for step 8:
- Prompt for `az login` if Azure authentication is missing.
- Check whether `pronghorn-app` already exists.
- Reuse existing app IDs when found; create it only when missing.
- Configure redirect URIs from section 8.2.
- Write actual values into `VITE_AZURE_CLIENT_ID` and `VITE_AZURE_TENANT_ID`.

Note for maintainers: `setup-frontend-env.ps1` and `setup-frontend-env.sh` are preferred user entrypoints. `New-FrontendEnv.ps1` and `new-frontend-env.sh` are internal implementation scripts called by wrappers.

#### PowerShell wrapper (recommended on Windows)

```powershell
Set-Location .github/skills/05.setup-local-front-end/scripts
.\setup-frontend-env.ps1
```

Overwrite existing `.env.local`:

```powershell
Set-Location .github/skills/05.setup-local-front-end/scripts
.\setup-frontend-env.ps1 -Force
```

#### bash wrapper (recommended on Linux/macOS)

```bash
cd .github/skills/05.setup-local-front-end/scripts
bash ./setup-frontend-env.sh
```

Overwrite existing `.env.local`:

```bash
cd .github/skills/05.setup-local-front-end/scripts
bash ./setup-frontend-env.sh --force
```

### Manual Fallback

Create `.env.local` in `app/frontend/`:

```env
# ──────────────────────────────────────────────
# API Backend
# ──────────────────────────────────────────────
VITE_API_BASE_URL=http://localhost:3001
VITE_USE_AZURE_API=true
VITE_APIM_SUBSCRIPTION_KEY=

# ──────────────────────────────────────────────
# Authentication Mode
# ──────────────────────────────────────────────
VITE_AUTH_MODE=msal

# ──────────────────────────────────────────────
# Azure AD / MSAL Authentication
# ──────────────────────────────────────────────
VITE_AZURE_CLIENT_ID=<pronghorn-app-client-id>
VITE_AZURE_TENANT_ID=<tenant-id>
VITE_AZURE_REDIRECT_URI=http://localhost:8080

# ──────────────────────────────────────────────
# WebSocket (realtime)
# ──────────────────────────────────────────────
VITE_WS_URL=ws://localhost:3001/ws
```

### Frontend Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_API_BASE_URL` | ✅ | API base URL, use `http://localhost:3001` |
| `VITE_USE_AZURE_API` | ✅ | Keep `true` for this project’s API path |
| `VITE_APIM_SUBSCRIPTION_KEY` | ❌ | APIM key for gateway scenarios (optional locally) |
| `VITE_AUTH_MODE` | ✅ | Use `msal` |
| `VITE_AZURE_CLIENT_ID` | ✅ | Azure AD App Registration client ID |
| `VITE_AZURE_TENANT_ID` | ✅ | Azure AD tenant ID |
| `VITE_AZURE_REDIRECT_URI` | ✅ | Redirect URI, use `http://localhost:8080` |
| `VITE_WS_URL` | ❌ | Realtime WebSocket endpoint |

---

## Step 5.3: Start the Frontend

From `app/frontend/`, run:

```bash
npm run dev
```

Expected frontend URL:

```
http://localhost:8080
```

> **Note:** `vite.config.ts` configures Vite for `8080`. If `8080` is already in use, Vite may auto-switch to another port (for example `8081`). For local auth consistency, free `8080` and restart frontend so it runs on `http://localhost:8080`.

---

## Validation

Verify frontend setup is complete:

- [ ] `.env.local` exists in `app/frontend/`
- [ ] `VITE_API_BASE_URL=http://localhost:3001`
- [ ] Frontend starts with `npm run dev`
- [ ] Browser opens `http://localhost:8080`
- [ ] API calls resolve without CORS errors

Quick checks:

```bash
# from app/frontend
ls -la .env.local
npm run dev
```

---

## Troubleshooting

| Problem | Cause | Solution |
|---------|-------|----------|
| `Port 8080 already in use` | Another process is using port 8080 | Stop conflicting process or adjust Vite port config |
| `npm install` fails with `ERESOLVE` (Vite/PWA peer deps) | Peer dependency mismatch in local npm resolution | Run `npm install --legacy-peer-deps` from `app/frontend/` |
| `CORS errors in browser` | API origin not allowed | Ensure API `.env` has `ALLOWED_ORIGINS=http://localhost:8080,http://localhost:8081` |
| Frontend calls wrong backend | `VITE_API_BASE_URL` incorrect | Set `VITE_API_BASE_URL=http://localhost:3001` in `.env.local` |
| MSAL login redirect fails | Redirect URI mismatch | Add `http://localhost:8080` and `/auth-redirect.html` in Azure AD App Registration |
| Realtime features not working | WebSocket URL/API not running | Set `VITE_WS_URL=ws://localhost:3001/ws` and verify API is running |
| `.env.local` overwritten unexpectedly | Forced wrapper run | Re-run wrapper without force or restore from source control |

Windows quick fix for `8080` conflict:

```powershell
$pid = (Get-NetTCPConnection -LocalPort 8080 -State Listen).OwningProcess
Stop-Process -Id $pid -Force
```

---

## Next Steps

After frontend setup:

1. [Verify the Full Stack](../../../LOCAL_DEVELOPMENT.md#6-verify-the-stack)
2. [Docker Compose Full Stack](../../../LOCAL_DEVELOPMENT.md#7-docker-compose-full-stack)
3. [Azure AD / MSAL Authentication](../../../LOCAL_DEVELOPMENT.md#8-azure-ad--msal-authentication)

---

## Related Resources

- [LOCAL_DEVELOPMENT.md § 5 — Set Up the Frontend](../../../LOCAL_DEVELOPMENT.md#5-set-up-the-frontend)
- [Environment Variables Reference](../../../LOCAL_DEVELOPMENT.md#environment-variables-reference)
- [Common Commands](../../../LOCAL_DEVELOPMENT.md#common-commands)
- [Troubleshooting](../../../LOCAL_DEVELOPMENT.md#troubleshooting)
