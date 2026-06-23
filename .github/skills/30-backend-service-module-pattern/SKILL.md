---
name: 30-backend-service-module-pattern
description: Canonical pattern for new backend service modules in `app/backend/src/services/<domain>/<archetype>/` — action registry, status machine, pure naming helpers, external-API client, background poller, and mirrored Jest tests. Load this skill when introducing a new multi-verb domain service, replacing a legacy `switch (action)` block in `routes/`, or adding a sibling archetype to an existing service.
argument-hint: New backend service module — apply the docker-deployment pattern
compatibility:
  - linux
  - macos
  - windows
license: MIT
user-invokable: true
---

# Backend Service Module Pattern

Reference implementation: [app/backend/src/services/deployment/docker/](../../../app/backend/src/services/deployment/docker/)
Mirrored tests: [app/backend/src/__tests__/services/deployment/docker/](../../../app/backend/src/__tests__/services/deployment/docker/)

## When to apply this pattern

Use it when a route handler in `app/backend/src/routes/` dispatches on a `body.action` (or similar verb) field across more than ~3 branches, or when a single domain owns multiple verbs plus a background reconciliation loop. Do **not** apply it to simple CRUD endpoints — those stay inline in the route file.

## Pre-requisites

- A spec or design note (e.g., under `specs/<NNN>-<slug>/`) listing the action verbs, status enum, and external systems involved. Action handlers and tests reference its FR / US / AS identifiers inline (see existing JSDoc headers for shape).
- The legacy route handler exists and is currently in `routes/functions.ts` or a sibling file. The cutover is incremental — the registry's `fallback` keeps legacy verbs working until each verb is migrated.

## Directory layout

```
app/backend/src/services/<domain>/<archetype>/
├── types.ts                   # Status enum + predicates, action verb union, context interface, row shape, error taxonomy
├── <archetype>Service.ts      # Entry point: action registry + `handle(req,res,body,fallback)`
├── statusMachine.ts           # Pure guards + custom error classes (e.g., ConcurrentDeployError)
├── naming.ts                  # Pure, deterministic resource-name helpers
├── <external>Client.ts        # Thin wrapper over fetch/SDK (one per external system)
├── poller.ts                  # Optional: background reconciliation loop
├── _armContext.ts             # Optional: shared sub-context builder, underscore-prefixed
└── actions/
    ├── _failure.ts            # Shared internal helpers — underscore-prefixed, not exported from index
    ├── create.ts              # Exports `createAction(ctx): Promise<void>`
    ├── deploy.ts
    ├── destroy.ts
    ├── status.ts
    └── …                      # One file per verb (small verb families may share a file, e.g. start/stop/restart → lifecycleArm.ts)
```

Mirror exactly under `app/backend/src/__tests__/services/<domain>/<archetype>/`. Each source file has a matching `.test.ts`.

## Required conventions

1. **File header JSDoc** — every file opens with: purpose, the legacy block it replaces (if any), spec/FR/US references, and an `@example`. Match the style of [actions/create.ts](../../../app/backend/src/services/deployment/docker/actions/create.ts).
2. **Action registry entry point** — see [dockerDeploymentService.ts](../../../app/backend/src/services/deployment/docker/dockerDeploymentService.ts):
   - `actions: Partial<Record<ActionVerb, Handler>>` populated by imports at top of file.
   - `WIRE_ALIASES: Record<string, ActionVerb>` for legacy wire names (e.g., `delete` → `destroy`). Apply at the boundary so the frontend wire format is unchanged.
   - `handle(req, res, body, fallback)` resolves the verb, dispatches, or invokes `fallback()` for verbs not yet migrated.
   - Export `register…Action`, `_reset…ForTests`, `_getRegistered…` (underscore = test-only).
3. **Handler signature** — `export async function <verb>Action(ctx: <Archetype>Context): Promise<void>`. Handlers respond directly via `ctx.res` and return `void`; they never throw to the registry for expected error paths.
4. **Context shape** — defined once in `types.ts`:
   ```ts
   export interface <Archetype>Context {
     req: Request;
     res: Response;
     body: Record<string, unknown> & { action: <ActionVerb>; <primaryId>: string; … };
   }
   ```
5. **Status machine** — `types.ts` exports the status string-literal union plus `TRANSITIONAL` / `TERMINAL` `ReadonlySet`s and `isTransitional` / `isTerminal` predicates. `statusMachine.ts` exports `assertCanAccept<Action>(currentStatus)` returning hints (e.g., `{ clearFailureAttrs: boolean }`) and a custom `Error` subclass carrying the offending status. See [statusMachine.ts](../../../app/backend/src/services/deployment/docker/statusMachine.ts).
6. **Pure helpers** — `naming.ts` and similar pure modules take a plain options object, return a plain result object, and contain zero I/O. They are pinned by exhaustive `it.each([...])` tables in `naming.test.ts`.
7. **External client** — one `<external>Client.ts` per external system (e.g., `genappWorkflowClient.ts`). Takes the auth token as a parameter; never reads credentials itself. Exports narrow `…Params` interfaces alongside each function. Module-level `const` reads env vars with sensible defaults documented in a comment.
8. **Shared failure helpers** — extract repeated `UPDATE … status='failed' … + broadcast` blocks into `actions/_failure.ts`. See [actions/_failure.ts](../../../app/backend/src/services/deployment/docker/actions/_failure.ts) for `recordFailure` and `formatDispatchHttpCause`.
9. **Logging** — every module declares `const LOG_PREFIX = "[<domain>-<archetype>:<verb>]"` and logs through `utils/logger`, never `console`.
10. **Broadcasts** — DB status changes are followed by `broadcast(\`<channel>-${projectId}\`, "<event>", payload)` from `utils/websocket` so the frontend receives push updates.
11. **Poller (when applicable)** — selects transitional rows, processes each in a per-row transaction wrapped in `pg_try_advisory_xact_lock(hashtextextended(id, 0))` for multi-replica safety. Exports `tick…Poller()` for deterministic test ticks plus `start…Poller()` / `stop…Poller()` for `index.ts`. See [poller.ts](../../../app/backend/src/services/deployment/docker/poller.ts).
12. **No coupling to the legacy file** — the new module **MUST NOT** import from `routes/functions.ts`. The only bridge is the runtime `fallback` closure passed to `handle()`.

## Test conventions (Jest)

Each handler test in `__tests__/services/<domain>/<archetype>/actions/<verb>.test.ts` follows the [create.test.ts](../../../app/backend/src/__tests__/services/deployment/docker/actions/create.test.ts) shape:

- `jest.mock()` every I/O dependency at the top: `utils/database`, `utils/logger`, `utils/rpcHelpers`, `utils/githubAuth`, `websocket`, the external client.
- A `makeCtx(overrides?)` factory that returns `{ ctx, res }` where `res.status` and `res.json` are chainable `jest.fn().mockReturnThis()`.
- One `describe` per handler; `it` titles reference the spec/FR/US (e.g., `"persists resource names before dispatch (FR-002)"`).
- For state-machine and naming modules, use parametric `it.each([...])` tables to cover every enum × action pair.
- Reset registries between tests with `_reset…ForTests()` to avoid cross-test bleed.

## Incremental cutover procedure

1. Scaffold `types.ts`, `<archetype>Service.ts` with an empty `actions` map, and the test directory mirror.
2. Wire `handle(req, res, body, fallback)` into the legacy route, passing the existing `switch` body as `fallback`. Land + ship — behavior is unchanged.
3. For each verb, in its own commit: add `actions/<verb>.ts`, register it in the entry point, mirror the test, delete the legacy `case`.
4. When the legacy `switch` is empty, delete the fallback closure and drop the redundant route plumbing.

## Validation

Run skill [20.build-and-lint](../20.build-and-lint/SKILL.md) and [21.test-all](../21.test-all/SKILL.md) after every cutover commit. New action files must ship with their mirrored test file in the same commit.

## Rollback

Each verb cutover is reversible by reverting the single commit that registered it — the legacy `fallback` closure remains intact during the migration, so the verb falls back to the legacy branch on revert.

## Ownership

Backend team. Updates to this pattern require updating both this skill and the reference implementation in lockstep.

## Anti-patterns to avoid

- Putting business logic in `<archetype>Service.ts` — it is dispatch-only.
- Adding a verb to the action registry without a mirrored test file in the same commit.
- Importing `routes/functions.ts` from any file under `services/<domain>/`.
- Inlining external-API `fetch` calls inside an action handler — go through `<external>Client.ts`.
- Mutating status in an action handler without first calling `assertCanAccept<Action>(currentStatus)`.
- Reading credentials inside `<external>Client.ts` — the token is always a parameter.
- Using `console.*` instead of `utils/logger`.
- Forgetting to `broadcast()` after a status change — the frontend depends on it.
