---
applyTo: "app/backend/**"
---

# API Layer — Pronghorn Backend

## Stack
- Node 18+, Express, TypeScript, PostgreSQL (`pg`), `ws`, Swagger, JWT middleware

## Architecture
- Direct frontend → API endpoints. Versioned under `app/backend/src/routes/v1/`.
- OpenAPI at `/api/openapi.json`, Swagger UI at `/api-docs`.
- WebSocket endpoint at `/ws`.
- Auth: JWT middleware, Azure AD OAuth, headers (`Authorization`, `apikey`, `ocp-apim-subscription-key`).

## Middleware Order (preserve)
Helmet (security) → CORS → body parsing → logging → routes → error handler

## Database
- Migrations in `infra/migrations/`, baseline: `001_full_schema.sql`
- For DB changes, update SQL migrations — never ad-hoc runtime schema changes.
- PostgreSQL MCP is available for live schema introspection during development.

## Testing
- Framework: Jest
- Test files: `app/backend/src/__tests__/`
- Config: `app/backend/jest.config.ts`
- Docs: `docs/UNIT_TESTS.md`
- Run: `cd app/backend && npm test`

## Build
- `cd app/backend && npm run build`

## Route Patterns (use as templates)
- Simple endpoint: `app/backend/src/routes/health.ts`
- Streaming/AI: `app/backend/src/routes/chat.ts`
- CRUD: `app/backend/src/routes/canvas.ts`
- For new endpoints, prefer versioned routes in `app/backend/src/routes/v1/`.

## Service Module Pattern (multi-verb domains)
When a route handler dispatches on a `body.action` verb across more than ~3 branches, or when a domain owns a status machine + background reconciliation, extract it into `app/backend/src/services/<domain>/<archetype>/` using the **action-registry** pattern. Canonical reference: `app/backend/src/services/deployment/docker/` (mirrored tests under `__tests__/services/deployment/docker/`). Load skill **`30.backend-service-module-pattern`** before scaffolding or extending such a module — it documents file layout, handler signature, status-machine guards, external-client wrapping, poller conventions, and the incremental cutover procedure that keeps the legacy `switch` working until every verb is migrated.

## MCP Tools Available
- **PostgreSQL MCP**: Live schema introspection — query table structures, relationships
- **GitHub MCP**: PR context, code review
- **Azure MCP**: Azure service operations, deployment best practices

## Production Quality Skills (installed via `npx skills`)
The following skills are installed in `.agents/skills/` and provide detailed guidance for production-quality API development. Reference them when working on API features:

- **`express-typescript`** — Express.js with TypeScript patterns: middleware design, error handling, route organization, async/await, dependency injection.
- **`jwt-security`** — JWT authentication and authorization best practices: token lifecycle, refresh tokens, claims validation, secure storage, RBAC patterns.
- **`rest-api-design`** — RESTful API design principles: resource naming, HTTP methods, status codes, pagination, filtering, versioning, HATEOAS.
- **`jest-testing`** — Jest testing patterns for Node.js: unit tests, integration tests, mocking strategies, async testing, coverage configuration.
