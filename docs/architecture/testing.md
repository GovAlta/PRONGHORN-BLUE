# Testing Architecture

> Part of the [Pronghorn Architecture Documentation](../README.md)

---

## Test Strategy

| Layer | Framework | Runner | Pattern |
|-------|-----------|--------|---------|
| **Frontend** | Vitest + Testing Library | jsdom | Component, hook, and utility unit tests |
| **Backend** | Jest + Supertest | Node | Route integration tests, service unit tests |

## Frontend Testing

- **Config:** `vitest.config.ts` — jsdom environment, `@/` path alias, v8 coverage
- **Setup:** `src/test/setup.ts` — loads `@testing-library/jest-dom`, mocks `matchMedia`
- **Location:** Tests live beside source in `__tests__/` directories
- **Patterns:** Component rendering, hook testing, utility pure-function tests, `vi.mock()` for module mocking

## Backend Testing

- **Config:** `jest.config.ts` — ts-jest transformer
- **Patterns:**
  - Heavy mocking of external dependencies (database, logger, JWT, JWKS)
  - Route tests mount individual routers on minimal Express apps with `supertest`
  - Service tests validate action registry dispatch and state machine transitions
- **Notable tests:**
  - `index.startup.test.ts` — verifies boot order (blob store init before migrations/listen)
  - `routes/auth.test.ts` — full auth flow coverage (signup, login, refresh, logout)
  - `websocket.test.ts` — WebSocket exports, broadcast behavior, stats shape

> For per-test-case documentation, see [Unit Tests](../UNIT_TESTS.md).

## Test Commands

```bash
# Full suite (from repo root)
npm run test                        # Jest + Vitest

# Layer-specific
cd app/backend  && npm test         # Jest
cd app/frontend && npm test         # Vitest
cd app/backend  && npm run test:coverage
cd app/frontend && npm run test:coverage
```
