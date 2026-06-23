---
name: 20.build-and-lint
description: Runs lint and build validation for both the frontend (app/frontend/) and API (app/backend/) layers. Use this skill to validate that code compiles and passes lint rules before committing.
argument-hint: Run build and lint for all layers
compatibility:
  - linux
  - macos
  - windows
license: MIT
user-invokable: true
---

# Build and Lint — Full Stack Validation

## Pre-requisites
- Node.js 18+ installed
- `npm install` completed in both `app/frontend/` and `app/backend/`

## Steps

1. **Lint frontend** (`app/frontend/`):
   ```bash
   cd app/frontend && npm run lint
   ```

2. **Build frontend** (`app/frontend/`):
   ```bash
   cd app/frontend && npm run build
   ```

3. **Build API** (`app/backend/`):
   ```bash
   cd app/backend && npm run build
   ```

## Validation
- All three commands must exit with code 0.
- Lint errors must be resolved before proceeding.
- Build output should show no TypeScript compilation errors.

## Trigger
- Before committing changes that touch `app/frontend/src/` or `app/backend/` files.
- As part of the code-review agent workflow.
- Before creating a pull request.

## Rollback
- N/A — this is a read-only validation skill.

## Ownership
- Development team — all contributors.
