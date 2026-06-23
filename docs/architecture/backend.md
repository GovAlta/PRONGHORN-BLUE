# Backend Architecture

> Part of the [Pronghorn Architecture Documentation](../README.md)

---

## Technology Stack

| Technology | Version | Purpose |
|------------|---------|---------|
| Node.js | ≥18 | Runtime |
| Express.js | 4.18 | HTTP framework |
| TypeScript | 5.3 | Type safety |
| PostgreSQL | 16 | Primary database (via `pg` driver) |
| `ws` | 8.19 | WebSocket server |
| Winston | 3.11 | Structured logging |
| JWT | 9.0 | Token generation/validation |
| `jwks-rsa` | 3.2 | Azure AD JWKS key resolution |
| Swagger | 6.2 | OpenAPI spec generation |
| `@azure/storage-blob` | 12.31 | Blob storage SDK |
| `@azure/identity` | 4.7 | Managed identity auth |
| Helmet | 7.1 | Security headers |

## Server Boot Sequence

```
1. dotenv.config()                    ← Load environment
2. Configure undici DNS (prod)        ← Azure private endpoint resolution
3. Register middleware stack:
   a. helmet()                        ← Security headers
   b. cors()                          ← CORS with ALLOWED_ORIGINS
   c. express.json({limit:"50mb"})    ← Body parsing
   d. Request logger                  ← Winston request logging
4. Mount Swagger UI (/api-docs)
5. Mount OpenAPI JSON (/api/openapi.json)
6. Mount routes:
   a. /health                         ← Top-level health
   b. /api/v1/*                       ← Versioned API routes
   c. /api/health                     ← API health
   d. /api/migrate                    ← Migration endpoint
7. Mount 404 catch-all + error handler
8. startServer():
   a. initRepoBlobStore()             ← Initialize blob storage
   b. Run migrations (if enabled)     ← Apply SQL schema
   c. app.listen(PORT)                ← Start HTTP server (default 8080)
   d. Attach WebSocket server (/ws)
   e. Start deployment poller         ← Background reconciliation
9. Register graceful shutdown (SIGTERM, SIGINT, SIGUSR2)
```

## Middleware Stack

Middleware executes in strict order:

| Order | Middleware | File | Purpose |
|-------|-----------|------|---------|
| 1 | `helmet()` | `index.ts` | Security headers (CSP, HSTS, etc.) |
| 2 | `cors()` | `index.ts` | CORS with configurable allowed origins |
| 3 | `express.json()` | `index.ts` | JSON body parsing (50MB limit) |
| 4 | Request logger | `index.ts` | Winston-based request/response logging |
| 5 | `authMiddleware` | `middleware/auth.ts` | JWT/Azure AD/APIM token validation |
| 6 | `optionalAuthMiddleware` | `middleware/auth.ts` | Auth without rejection (for public + token routes) |
| 7 | `requireRole(role)` | `middleware/auth.ts` | RBAC enforcement |
| 8 | `errorHandler` | `middleware/errorHandler.ts` | Centralized error response formatting |

## Route Organization

All routes are versioned under `/api/v1/` via `routes/v1/index.ts`:

```
/api/v1/
├── /health          (public)        Health checks
├── /auth            (public)        Signup, login, refresh, logout, OAuth
├── /chat            (protected)     AI chat streaming, summarization
├── /projects        (protected)     Project CRUD + clone
├── /artifacts       (protected)     Artifact CRUD per project
├── /canvas          (protected)     Canvas nodes/edges CRUD
├── /database        (protected)     Database management + query exec
├── /audit           (protected)     Audit trail start/view/update
├── /collaboration   (protected)     Session management, participants
├── /github          (optional auth) GitHub OAuth + integration
├── /db              (protected)     Generic CRUD (select/insert/update/delete/upsert)
├── /rpc             (optional auth) RPC-style function calls (:functionName)
├── /functions       (optional auth) Serverless-style function invocation
├── /storage         (optional auth) Blob storage operations
└── /migrate         (admin)         Migration execution
```

## Service Architecture

Services follow the **action registry pattern** — a dispatcher maps verb strings to handler functions:

```
services/
└── deployment/
    └── docker/
        ├── dockerDeploymentService.ts   # Action registry dispatcher
        ├── statusMachine.ts             # State transition validation
        ├── poller.ts                    # Background reconciliation loop
        ├── naming.ts                    # Deterministic resource naming
        ├── types.ts                     # Domain type definitions
        ├── genappWorkflowClient.ts      # GitHub workflow dispatch client
        ├── genappKeyVault.ts            # Azure Key Vault integration
        ├── genappInfraSnapshot.ts       # Infrastructure state capture
        ├── _armContext.ts               # Azure Resource Manager context
        └── actions/
            ├── create.ts               # Create deployment resources
            ├── deploy.ts               # Trigger deployment workflow
            ├── destroy.ts              # Tear down deployment
            ├── status.ts               # Query deployment status
            ├── updateServiceConfig.ts  # Update service configuration
            ├── lifecycleArm.ts         # ARM lifecycle operations
            ├── logs.ts                 # Retrieve deployment logs
            ├── envVars.ts              # Environment variable management
            ├── _dispatchUpdate.ts      # Internal update broadcaster
            └── _failure.ts             # Failure handling utility
```

**Key patterns:**
- **Action registry:** Handlers register by verb; dispatcher resolves and invokes (`dockerDeploymentService.ts`)
- **Status machine:** Finite state transitions for deployment lifecycle — validates legal state changes, prevents concurrent deploy conflicts (`statusMachine.ts`)
- **Background poller:** Advisory-lock-guarded reconciliation loop polls GitHub workflow status, detects stalled deployments, broadcasts WebSocket updates (`poller.ts`)
- **External API clients:** Dedicated modules for GitHub API, Key Vault, and ARM interactions

## Database Access

PostgreSQL access is through **direct `pg` driver** (no ORM):

```typescript
// utils/database.ts — connection pool with retry/fallback
const pool = new Pool({
  host: POSTGRES_HOST,
  port: POSTGRES_PORT,      // Tries 5432, then configured port, then 5433
  database: POSTGRES_DATABASE,
  user: POSTGRES_USER,
  password: POSTGRES_PASSWORD,
  ssl: POSTGRES_SSL,
  max: 20,                   // Max connections
  connectionTimeoutMillis: 10000
});

// Query helpers
await query('SELECT * FROM projects WHERE id = $1', [projectId]);
await transaction(async (client) => { /* atomic operations */ });
const health = await healthCheck();
```

**Multi-database support:** A pool factory (`getPoolForTarget()`) manages connections to both the application database (`db`, port 5432) and generated-apps database (`db-generated-apps`, port 5433).

## API Documentation

OpenAPI 3.0.3 specification is auto-generated via `swagger-jsdoc`:

| Endpoint | Content |
|----------|---------|
| `/api-docs` | Interactive Swagger UI |
| `/api/openapi.json` | Raw OpenAPI JSON specification |

Security schemes defined: Bearer JWT, APIM subscription key.

Core schemas: `Project`, `Artifact`, `CanvasNode`, `ChatMessage`, `AuthCredentials`, `AuthResponse`, `HealthCheck`.
