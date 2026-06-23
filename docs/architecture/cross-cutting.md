# Cross-Cutting Concerns

> Part of the [Pronghorn Architecture Documentation](../README.md)

---

## Error Handling

**Backend** (`middleware/errorHandler.ts`):
- Centralized error handler formats all errors as JSON: `{ statusCode, code, message, details }`
- Stack traces included in non-production environments
- `express-async-errors` ensures async route errors propagate to error handler

**Frontend:**
- React Query `onError` callbacks for API errors
- Toast notifications via Sonner for user-facing errors
- `apiClient` throws on non-2xx responses

## Logging

**Backend** (Winston):
- Structured JSON logging via Winston
- Request/response logging middleware captures method, path, status, duration
- Log levels configurable via environment

**Frontend:**
- Browser console logging
- Application Insights integration for production telemetry

**Infrastructure:**
- Log Analytics Workspace aggregates all Azure resource logs
- Application Insights provides APM, dependency tracking, and custom metrics
- APIM diagnostic settings forward API gateway logs

## Security

| Layer | Mechanism |
|-------|-----------|
| **Transport** | HTTPS enforced, HSTS via Helmet |
| **Headers** | Helmet sets CSP, X-Frame-Options, X-Content-Type-Options |
| **CORS** | Configurable allowed origins (env-driven) |
| **Authentication** | Multi-provider JWT validation (Azure AD, local, Easy Auth) |
| **Authorization** | Role-based middleware (`requireRole`) + project token RBAC |
| **Secrets** | Azure Key Vault; plaintext secret columns removed (migration 011) |
| **Code scanning** | CodeQL SAST workflow for JavaScript/TypeScript |
| **Secret scanning** | Gitleaks configuration (`.gitleaks.toml`) |

> For detailed authentication architecture, see [Authentication & Authorization](auth.md).

## Configuration Management

| Layer | Mechanism | Sources |
|-------|-----------|---------|
| **Frontend** | `VITE_*` env vars, build-time injection | `.env`, `.env.local` |
| **Backend** | `dotenv` + `process.env` | `.env`, root `.env`, system env |
| **Infrastructure** | Terraform variables + tfvars | `params/dev.tfvars`, `params/pbmm.tfvars` |
| **AI Models** | `config/aiModels.ts` static catalog | Code + env (`APIM_OPENAI_URL`). See [AI Architecture](ai.md). |

## Validation

- **API requests:** Inline validation in route handlers (no shared validation library)
- **Frontend forms:** `react-hook-form` with component-level validation
- **Database:** PostgreSQL constraints, NOT NULL, UNIQUE, FK relationships, CHECK constraints via enums
- **Infrastructure:** Terraform variable validation blocks, `tfvars` type constraints
