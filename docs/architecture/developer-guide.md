# Developer Guide

> Part of the [Pronghorn Architecture Documentation](../README.md)

---

## Development Workflow

```
1. Branch from main
2. Identify affected layers (frontend / backend / infra)
3. Read corresponding .github/instructions/ file
4. Write failing tests first (TDD where practical)
5. Implement changes following established patterns
6. Run layer-specific lint + build + test
7. Verify cross-layer integration if applicable
8. Create PR — CI validates automatically
```

## Quick Reference: Where to Put Things

| You're Adding... | Put It Here |
|-------------------|------------|
| New API endpoint | `app/backend/src/routes/v1/{domain}.ts` |
| New service logic | `app/backend/src/services/{domain}/{archetype}/` |
| New middleware | `app/backend/src/middleware/{name}.ts` |
| New page/view | `app/frontend/src/pages/{Name}Page.tsx` |
| New feature component | `app/frontend/src/components/{feature}/` |
| New shared UI primitive | `app/frontend/src/components/ui/` (shadcn/ui pattern) |
| New React hook | `app/frontend/src/hooks/use{Name}.ts` |
| New API client method | `app/frontend/src/lib/apiClient.ts` |
| New utility function | `app/frontend/src/utils/` or `app/backend/src/utils/` |
| New database table | `infra/migrations/{NNN}_{name}.sql` |
| New Azure resource | `infra/modules/{service}/` + wire in `main.tf` |
| New environment config | `infra/params/{env}.tfvars` |
| New CI/CD workflow | `.github/workflows/{name}.yml` |
| New backend test | `app/backend/src/__tests__/` |
| New frontend test | Beside source in `__tests__/` directory |

## Validation Checklist

Before submitting changes:

- [ ] Frontend: `cd app/frontend && npm run lint && npm run build`
- [ ] Backend: `cd app/backend && npm run build`
- [ ] Tests: `npm run test` (from root)
- [ ] Database: Changes compatible with `infra/migrations/001_full_schema.sql`
- [ ] No hardcoded secrets, URLs, or credentials
- [ ] No UI layout modifications without client approval
- [ ] Swagger annotations on all new API routes
- [ ] Types updated for any new data structures

## Local Development Quick Start

```bash
# Prerequisites: Node ≥18, Docker, npm

# 1. Clone and install
git clone <repo-url> && cd pronghorn-organization
npm install
cd app/backend && npm install && cd ../..
cd app/frontend && npm install && cd ../..

# 2. Configure environment
cp .env.example .env
cp app/backend/.env.example app/backend/.env
cp app/frontend/.env.example app/frontend/.env

# 3. Start everything
npm run dev
# → Databases (Docker) + API (nodemon, :8080) + Frontend (Vite, :8080)

# 4. Access
# Frontend:  http://localhost:8080
# API:       http://localhost:8080/api/v1/health
# Swagger:   http://localhost:8080/api-docs
# WebSocket: ws://localhost:8080/ws
```

> For the full local development walkthrough, see [Local Development Guide](../LOCAL_DEVELOPMENT.md).

---

## Related Documentation

| Document | Purpose |
|----------|---------|
| [Architecture Overview](overview.md) | High-level architecture and repo layout |
| [Implementation Patterns](patterns.md) | Code patterns and extension guide |
| [Testing Architecture](testing.md) | Test strategy and commands |
| [Local Development Guide](../LOCAL_DEVELOPMENT.md) | Detailed local setup |

---

> **Maintenance:** This documentation should be updated when:
> - New architectural layers or patterns are introduced
> - Major dependency changes occur (framework upgrades, new external services)
> - Infrastructure topology changes materially
> - New service module archetypes are established
