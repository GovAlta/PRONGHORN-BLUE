---
name: 21.test-all
description: Runs the full test suite for both frontend (Vitest) and API (Jest) layers and reports combined results with coverage.
argument-hint: Run all tests across both layers
compatibility:
  - linux
  - macos
  - windows
license: MIT
user-invokable: true
---

# Test All — Full Stack Test Suite

## Pre-requisites
- Node.js 18+ installed
- `npm install` completed in both `app/frontend/` and `app/backend/`
- For API tests: local PostgreSQL running (or mock configuration)

## Steps

1. **Run frontend tests** (`app/frontend/` — Vitest):
   ```bash
   cd app/frontend && npm test
   ```

2. **Run API tests** (`app/backend/` — Jest):
   ```bash
   cd app/backend && npm test
   ```

## Validation
- Both test suites must pass (exit code 0).
- Review coverage output for any significant drops.
- Failed tests must be investigated — do not suppress failures.

## Trigger
- Before creating a pull request.
- After modifying business logic in `app/frontend/src/` or `app/backend/src/`.
- As part of the testing agent workflow.

## Rollback
- N/A — this is a read-only validation skill.

## Ownership
- Development team — all contributors.
