# Pronghorn Repository Instructions

## Mission and Architecture
- Pronghorn is an AI-assisted software platform with a React + Vite frontend and a TypeScript Express API backend.
- Architecture: Direct **Web App → API** communication. The frontend calls the API endpoints directly.
- API architecture:
	- Versioned API under `/api/v1/*`
	- OpenAPI at `/api/openapi.json`
	- Swagger UI at `/api-docs`
	- WebSocket endpoint at `/ws`

## UI/UX Layout Immutability (NON-NEGOTIABLE)
**The existing user interface layout MUST NOT be modified.** This is an explicit client requirement.
- DO NOT change page layouts, sidebar/header/footer structure, navigation flows, modal/dialog patterns, component positioning, or responsive breakpoints.
- DO NOT alter visual hierarchy or page structure.
- Styling changes (colors, fonts, spacing) within the existing layout ARE permitted when they don't alter structural layout.
- Any layout change requires explicit written approval from the client.
- This applies to all files under `app/frontend/src/`.

## Repository Layout (Authoritative)
- Frontend app: `app/frontend/src/`
- API service: `app/backend/src/`
- Infrastructure as Code (Terraform): `infra/`
- SQL migrations: `infra/migrations/`
- Static/public data and prompt templates: `public/data/`
- Docs and migration references: `docs/`, `README.md`, `docs/LOCAL_DEVELOPMENT.md`

## Layer-Scoped Development
This repository uses layer-scoped instruction files (`.github/instructions/`) that auto-attach based on which files you're editing:
- **`frontend.instructions.md`** → `app/frontend/src/**` — React/Vite/Tailwind, UI/UX immutability (mapped to `app/frontend/src/**` after restructure)
- **`api.instructions.md`** → `api/**` — Express/PostgreSQL/JWT, versioned routes (mapped to `app/backend/**` after restructure)
- **`infra.instructions.md`** → `infra/**` — Terraform/Azure modules
- **`cicd.instructions.md`** → `.github/workflows/**` — GitHub Actions

## MCP Servers Available
- **GitHub MCP** (remote): Issues, PRs, Actions workflows, code security, secret scanning
- **Azure MCP** (built-in): 40+ Azure services, Terraform best practices, deployment guidance
- **Azure Terraform MCP**: AzureRM/AzAPI provider docs, Azure Verified Modules, aztfexport, conftest
- **PostgreSQL MCP**: Read-only schema introspection against local dev database
- **Context7**: Documentation lookup for any library

## Agents Available
- **speckit.*** — Spec-driven development workflow (specify, plan, tasks, implement, analyze, clarify, constitution, checklist)
- **code-review** — Reviews changes against constitution, layer conventions, UI/UX immutability
- **testing** — Generates and runs tests (Vitest for frontend, Jest for API)
- **security** — Security review: dependency audit, secret scanning, auth patterns, Azure compliance
- **deployment** — Deployment orchestration: plan → deploy → verify → rollback

## Skills Available
- **20.build-and-lint** — Lint + build validation for both frontend and API
- **21.test-all** — Full test suite (Vitest + Jest)
- **22.terraform-plan** — Terraform plan with environment tfvars
- **23.deploy-via-workflow** — Triggers deploy-to-azure GitHub Actions workflow

## Frontend Quality Skills (`.agents/skills/`, installed via `npx skills`)
- **accessibility** — WCAG 2.2 compliance, ARIA patterns, keyboard navigation, screen reader support
- **performance** — Web performance optimization, lazy loading, code splitting, caching
- **core-web-vitals** — LCP, INP, CLS optimization
- **best-practices** — Web security, compatibility, modern code quality patterns
- **shadcn-ui** — Component patterns for shadcn/ui with Radix UI, Tailwind theming, Zod validation

## API Quality Skills (`.agents/skills/`, installed via `npx skills`)
- **express-typescript** — Express.js + TypeScript patterns, middleware design, error handling
- **jwt-security** — JWT auth best practices, token lifecycle, RBAC patterns
- **rest-api-design** — RESTful API design, resource naming, status codes, versioning
- **jest-testing** — Jest testing patterns, mocking, async testing, coverage

## External Skills (already loaded, invoke by name)
- `azure-deploy`, `azure-validate`, `azure-diagnostics` — deployment lifecycle
- `azure-compliance`, `azure-rbac` — security posture
- `azure-observability`, `appinsights-instrumentation` — monitoring
- `entra-app-registration` — auth configuration
- `azure-enterprise-infra-planner` — infrastructure design
- `find-skills` — discover additional capabilities

## Tech Stack and Tooling
- Frontend: React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui, React Query, React Router.
- Backend: Node 18+, Express, TypeScript, PostgreSQL (`pg`), `ws`, Swagger, JWT middleware.
- Infra: Terraform modules for Azure resources (APIM, Container Apps, PostgreSQL, Foundry, Key Vault, Storage, etc.).
- Package manager in repo scripts is `npm` (despite `bun.lockb` existing in root).

## Local Dev Commands

- **Full stack** (from repo root):
	- `npm install` (one-time — installs `concurrently`)
	- `npm run dev` (starts databases + API + frontend in one terminal)
	- `npm run dev:stop` (stops database containers)
	- `npm run dev:reset` (wipes database volumes and recreates)
	- `npm run build` (builds backend then frontend)
	- `npm run test` (runs Jest + Vitest)
- Frontend (`app/frontend/`):
	- `npm install`
	- `npm run dev` (Vite on port 8080)
	- `npm run build`
	- `npm run lint`
- API (`app/backend/`):
	- `npm install`
	- `npm run dev` (ts-node + nodemon)
	- `npm run build`
	- `npm run start`
- Databases: `docker-compose.yml` runs `db` (port 5432) and `db-generated-apps` (port 5433) only. API and frontend run natively via npm.

## Coding Rules
- Keep changes minimal and task-focused; avoid broad refactors unless requested.
- Prefer existing project patterns over introducing new abstractions.
- Preserve API versioning and route organization under `app/backend/src/routes/`.
- Use the existing `@` alias (`@/* -> src/*`) in frontend imports where appropriate.
- Follow existing Tailwind token/theme usage; do not hard-code new design tokens when existing variables/utilities cover the need.
- Do not add new dependencies unless necessary and justified by the task.
- Commit regularly with clear messages; avoid large, monolithic commits.
- use TDD where practical. Write tests for new features and bug fixes, and ensure existing tests pass.

## PowerShell Script Conventions (Enforced)
For any new or modified PowerShell scripts (`*.ps1`, `*.psm1`) in this repository, follow these authoritative sources:

- PowerShell Script Analyzer (official rules and style enforcement):
	- https://learn.microsoft.com/powershell/utility-modules/psscriptanalyzer/overview
	- https://github.com/PowerShell/PSScriptAnalyzer/tree/master/RuleDocumentation
- Microsoft Learn language references:
	- Comment-based help (headers/help/commenting): https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_comment_based_help
	- Functions and parameter conventions: https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_functions_advanced_parameters
	- Approved verbs: https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_verbs

Required conventions for this repo:
- Include a script/function help header using comment-based help (`.SYNOPSIS`, `.DESCRIPTION`, `.PARAMETER`, `.EXAMPLE`) for scripts/functions that are intended for reuse.
- Use `param(...)` with explicit parameter names/types, validation attributes where appropriate, and meaningful defaults.
- Prefer approved verb-noun naming for functions.
- Use 4-space indentation, consistent brace style, and no trailing whitespace.
- Keep comments focused on intent/usage (not obvious line-by-line narration).
- Favor early validation and fail-fast error handling (`$ErrorActionPreference = 'Stop'` where appropriate).

When practical, validate PowerShell changes with PSScriptAnalyzer before considering the task complete.

## Function Authoring Requirements
When writing or modifying functions (frontend or backend):
- Add descriptive JSDoc comments.
- Include input validation.
- Use early returns for error/guard conditions.
- Use meaningful, non-trivial variable names.
- Include at least one example usage in comments where practical.

## Backend-Specific Guidance
- Keep middleware ordering intact (security, CORS, body parsing, logging, routes, error handler).
- Maintain compatibility with current auth/JWT approach and existing headers (`Authorization`, `apikey`, `ocp-apim-subscription-key`, etc.).
- For DB changes, update SQL migrations in `infra/migrations/` rather than ad-hoc runtime schema changes.
- For API additions, prefer versioned endpoints in `app/backend/src/routes/v1` and keep OpenAPI/Swagger alignment.

## Frontend-Specific Guidance
- Reuse existing components and utilities from `app/frontend/src/components`, `app/frontend/src/lib`, `app/frontend/src/hooks`, and `app/frontend/src/utils` before creating new primitives.
- Keep state/data-fetching patterns consistent with existing React Query and context usage.
- Respect MSAL/Azure auth integration and existing environment-variable driven configuration.

## Infrastructure and Azure Guidance
- Prefer modifying existing Terraform modules and variables under `infra/` instead of creating parallel infra definitions.
- Keep APIM/Container Apps/PostgreSQL/Foundry integration assumptions consistent with current architecture.
- Never commit secrets, keys, tokens, or real credentials; use env vars and examples.

## Validation Expectations for Changes
- For frontend-only changes: run `npm run lint` in `app/frontend/`, then `npm run build` when feasible.
- For API-only changes: run `npm run build` in `app/backend/`.
- For cross-cutting changes: validate both `app/frontend/` and `app/backend/` builds.
- If behavior depends on database objects, verify against `infra/migrations/001_full_schema.sql` expectations.

## Documentation and Consistency
- Update relevant docs (`README.md`, `LOCAL_DEVELOPMENT.md`, or `docs/*`) when behavior, commands, or architecture change.

## Example SKILL.md Structure
Use this structure as a template when creating new skill documentation files:

### Front matter:

```yaml
---
name: <name-of-skill>
description: <brief description of the skill and its purpose>
argument-hint: <optional hint for user input when invoking the skill>
compatibility:
  - linux
  - macos
  - windows
license: MIT
user-invokable: true
---
```

### Review SKILL.md instructions
- Follow the structure and sections as outlined in existing `SKILL.md` files under `.github/skills/<skill-name>`.
- Ensure all required sections (e.g., Pre-requisites, Steps, Validation) are included and clearly written.

### Read template
- Review existing template in `templates/*.md` if applicable to the type of document or artifact you are creating.

### Execute scripts
- If the task involves running scripts, ensure you understand the commands and their effects before execution.
- Follow any pre-requisites or setup steps outlined in the documentation before running scripts.
- For inline scripts use script blocks in documentation for clarity and reproducibility.
- Run file based scripts in `scripts/<script-name.ext>` and verify their successful execution.

### Produce document
- Create document in `docs/<topic>/<document-name>.md` if applicable, following the structure and style of existing documentation in the repository.

### Produce artifact
- Create artifact based on the template format and structure and place it in `artifacts/<artifact-name>.md` if applicable.

### Validate artifact
- Run validation: `python scripts/check_runbook.py docs/<topic>/<document-name>.md`

### Must Include (functional requirements)
- **Pre-requisites**: Required conditions, permissions, or resources needed before execution.
- **Trigger**: Conditions or events that activate the runbook, script, tool, process or operation.
- **Impact**: Business and system impact if the issue is not resolved
- **Mitigation**: Step-by-step actions to address the issue
- **Rollback**: Procedures to revert changes if needed
- **Ownership**: Team or individual responsible for managing the task or process
- **Validation**: How to confirm the task was successful and the issue is resolved

## What to Avoid (examples of anti-patterns)
- Do not bypass existing auth/authorization checks in API handlers.
- Do not hardcode environment-specific URLs in source unless already patterned that way for local dev defaults.
- Do not modify UI/UX layout without explicit written client approval.

### Related Resources
- Refer to this URL for more details for instructions and guidance using and creating skills: [VS Code Copilot Skills Documentation](https://code.visualstudio.com/docs/copilot/customization/agent-skills)
