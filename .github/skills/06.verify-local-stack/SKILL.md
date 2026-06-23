---
name: 06.verify-local-stack
description: This skill verifies the local Pronghorn stack by checking frontend, API health endpoint, and local PostgreSQL readiness.
argument-hint: "Please verify my local stack and report what is passing or failing."
compatibility:
  - linux
  - macos
  - windows
license: MIT
user-invokable: true
---

# Skill: Verify the Local Stack

This skill implements step 6 from `LOCAL_DEVELOPMENT.md` and helps confirm your local stack is operational.

---

## Prerequisites

Before verification, ensure setup steps are completed:

1. PostgreSQL is running and schema is migrated (steps 2 and 3)
2. API is configured and started (step 4)
3. Frontend is configured and started (step 5)

Expected local endpoints:
- Frontend: `http://localhost:8080`
- API Health: `http://localhost:3001/health`
- PostgreSQL Docker container: `pronghorn-db`

---

## What This Skill Verifies

Automated checks:
- Frontend is reachable (`http://localhost:8080`)
- API health endpoint returns success (`http://localhost:3001/health`)
- PostgreSQL container readiness via `pg_isready` (if Docker is available)

Manual checks (from step 6):
- Open frontend in browser
- Sign in with Azure AD account
- Create a project and verify API logs

---

## Automated Verification (Recommended)

Use wrapper scripts to auto-detect OS and run the correct implementation.

Note for maintainers: `verify-stack.ps1` and `verify-stack.sh` are preferred user entrypoints. `Verify-LocalStack.ps1` and `verify-local-stack.sh` are internal implementation scripts called by wrappers.

### PowerShell wrapper (recommended on Windows)

```powershell
Set-Location .github/skills/06.verify-local-stack/scripts
.\verify-stack.ps1
```

### bash wrapper (recommended on Linux/macOS)

```bash
cd .github/skills/06.verify-local-stack/scripts
bash ./verify-stack.sh
```

---

## Manual Verification (Step 6)

If you want to verify exactly as described in `LOCAL_DEVELOPMENT.md`:

1. Ensure PostgreSQL, API, and frontend are all running.
2. Open `http://localhost:8080` in your browser.
3. Sign in with your Azure AD account.
4. Create a project.
5. Check API terminal logs for requests.

Expected state:

```text
✅ Frontend:   http://localhost:8080
✅ API:        http://localhost:3001
✅ Database:   localhost:5432
✅ Swagger:    http://localhost:3001/api-docs
```

---

## Validation

### Pass Criteria

- Frontend check passes with HTTP 2xx/3xx
- API health check passes with HTTP 2xx
- DB check passes if `pronghorn-db` exists and `pg_isready` returns ready

### Common Output

```text
✅ Frontend is reachable: http://localhost:8080
✅ API health is reachable: http://localhost:3001/health
✅ PostgreSQL container is accepting connections: pronghorn-db
✅ Stack verification passed.
```

---

## Troubleshooting

| Failure | Cause | Action |
|---------|-------|--------|
| Frontend unreachable | Vite not running or wrong port | Start frontend from repo root: `npm run dev`; if Vite auto-starts on `8081`, free `8080` and restart |
| API health unreachable | API not running or env/config issue | Start API from `app/backend/`: `npm run dev` (or `npm --prefix app/backend run dev`) |
| DB container not running | Docker container stopped | `docker start pronghorn-db` |
| DB readiness fails | DB up but not ready/migrated | Wait and retry; re-run schema migration (step 3) |
| CORS/login issues in browser | Auth/redirect mismatch | Confirm app registration and `VITE_AZURE_*` values |

---

## Next Steps

After successful stack verification:

1. Continue regular development with frontend and API running.
2. Optionally run Docker full-stack flow (section 7).
3. If AI features are required, complete section 9 model deployment.

---

## Related Resources

- [LOCAL_DEVELOPMENT.md § 6 — Verify the Stack](../../LOCAL_DEVELOPMENT.md#6-verify-the-stack)
- [Step 4 Skill](../04.setup-local-api/SKILL.md)
- [Step 5 Skill](../05.setup-local-front-end/SKILL.md)
- [Troubleshooting](../../LOCAL_DEVELOPMENT.md#troubleshooting)
