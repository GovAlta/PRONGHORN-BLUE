# Architectural Decisions & Governance

> Part of the [Pronghorn Architecture Documentation](../README.md)

---

## Architectural Decision Records

### ADR-001: Direct SQL over ORM

- **Context:** Need for database access with full control over queries and performance
- **Decision:** Use `pg` driver with raw parameterized SQL; no ORM (Prisma, TypeORM, etc.)
- **Consequences:** Full SQL control, zero abstraction overhead; developers must write SQL manually and manage migrations by hand

### ADR-002: Action Registry Pattern for Services

- **Context:** Complex deployment lifecycle with many verbs (create, deploy, destroy, status, logs, env-vars)
- **Decision:** Use a Map-based action registry that dispatches to handler functions by verb string
- **Consequences:** Easy to add new actions; supports aliasing (delete→destroy); testable with registry reset; requires discipline to register all handlers

### ADR-003: Feature-Based Frontend Organization

- **Context:** Growing frontend with 15+ feature areas
- **Decision:** Organize components by feature domain, not by type (components/containers/etc.)
- **Consequences:** Feature code is co-located; shared primitives live in `components/ui/`; new features get their own directory

### ADR-004: Dual Auth Model (Authenticated + Anonymous Tokens)

- **Context:** Need for both authenticated user sessions and anonymous collaboration via shareable links
- **Decision:** Implement project tokens with role-based access embedded in URLs, alongside full Azure AD authentication
- **Consequences:** Broad accessibility; token management complexity; implicit auth checks in pages rather than router guards

### ADR-005: Two PostgreSQL Instances

- **Context:** Platform data (users, projects) must be isolated from generated application data
- **Decision:** Run separate PostgreSQL servers — one for platform (port 5432), one for generated apps (port 5433)
- **Consequences:** Strong data isolation; pool factory manages multi-target connections; additional infrastructure cost

### ADR-006: Native WebSocket over Socket.IO

- **Context:** Need for real-time updates (deployment status, collaboration)
- **Decision:** Use native `ws` library with custom channel pub/sub instead of Socket.IO
- **Consequences:** Smaller bundle, full control over protocol; manual implementation of heartbeat, reconnection, and channel management

### ADR-007: Monorepo with Independent Build/Deploy

- **Context:** Frontend, backend, and infrastructure are tightly related but independently deployable
- **Decision:** Single Git repository with independent `package.json` per layer; root `package.json` orchestrates via `concurrently`
- **Consequences:** Atomic commits across layers; independent CI/CD paths; shared tooling configuration

---

## Architecture Governance

### Automated Enforcement

| Mechanism | Scope | What It Checks |
|-----------|-------|----------------|
| ESLint | Frontend | Code quality, React hooks rules, refresh compliance |
| TypeScript strict mode | Frontend + Backend | Type safety |
| CI path filters | All | Only affected layers are built/tested on PR |
| Terraform plan | Infrastructure | Preview resource changes before apply |
| CodeQL | Backend + Frontend | SAST vulnerability scanning |
| Gitleaks | Repository | Secret detection in commits |

### Layer-Scoped Instructions

The repository uses `.github/instructions/` files that auto-attach based on file paths:

| Instruction File | Applies To | Enforces |
|-----------------|------------|----------|
| `frontend.instructions.md` | `app/frontend/src/**` | React/Tailwind patterns, UI/UX immutability |
| `api.instructions.md` | `app/backend/**` | Express/PostgreSQL/JWT patterns, versioned routes |
| `infra.instructions.md` | `infra/**` | Terraform/Azure module conventions |
| `cicd.instructions.md` | `.github/workflows/**` | GitHub Actions patterns |
