# `functions.ts` Refactor Plan

> **Scope**: Structural refactor of `app/backend/src/routes/functions.ts` (6,453 lines) using SOLID principles.  
> **Constraint**: MUST NOT change runtime behavior. All existing endpoints, request/response contracts, and side effects remain identical.  
> **Goal**: Enhance maintainability, readability, testability, and extensibility.

### Revision History

| Date       | Change Summary                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-04 | Initial analysis and plan created                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-05-11 | Updated after database-per-project isolation work (`feature/user-project-database-isolation`). Key impacts: (1) encryption duplication 3→4; (2) `handleDatabaseProvisioning` grew ~60 lines; (3) legacy `userDataQuery`/`getUserDataPool`/`initUserDataDatabase`/`getUserDataClient` removed from `database.ts`; (4) `queryWithPoolTarget()` dynamic imports added; (5) `database.handlers.ts` must account for per-database pool factory pattern |
| 2026-05-11 | Restructured from horizontal phases (all TDD → all utilities → all handlers) to vertical domain slices. Each phase is a self-contained increment: TDD → utility extraction (if needed) → handler extraction → registry integration → validation. Codebase is always shippable between phases.                                                                                                                                                     |

---

## 1. Current State Analysis

### 1.1 File Profile

| Metric                     | Value                                |
| -------------------------- | ------------------------------------ |
| Lines of code              | 6,453                                |
| Handler functions          | 40+                                  |
| Business domains           | 14                                   |
| Duplicated code blocks     | 4 (encryption helpers)               |
| God functions (>200 lines) | 5                                    |
| Nested switch statements   | 4                                    |
| Dynamic imports (inline)   | 20+ (`import('../config/aiModels')`) |

### 1.2 SOLID Violations

#### Single Responsibility Principle (SRP)

The file acts as a monolithic router, dispatcher, and implementation layer for **14 distinct domains**:

| #   | Domain                | Handlers                                                                                                                                                                                                        | Approx. Lines |
| --- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1   | Auth                  | `handleValidateSignupCode`, `handleSendAuthEmail`, `handleUpdateSignupValidated`                                                                                                                                | ~40           |
| 2   | Projects              | `handleProjectActivity`, `handleCreateProject`, `handleDeleteProject`, `handleCloneProject`                                                                                                                     | ~290          |
| 3   | Database Management   | `handleManageDatabase`                                                                                                                                                                                          | ~400          |
| 4   | Database Provisioning | `handleDatabaseProvisioning`                                                                                                                                                                                    | ~310          |
| 5   | Deployments           | `handleDeploymentService`, `handleDeploymentPreviewToken`, `handleGenerateLocalPackage`                                                                                                                         | ~950          |
| 6   | AI / Requirements     | `handleExpandRequirement`, `handleExpandStandards`, `handleDecomposeRequirements`, `handleAiPlaceholder`                                                                                                        | ~400          |
| 7   | AI / Architecture     | `handleAiArchitect` (generate + critic), `handleOrchestrateAgents`                                                                                                                                              | ~850          |
| 8   | AI / Streaming        | `handleChatStream`, `handleCollaborationOrchestrator`, `handleGenerateSpecification`                                                                                                                            | ~350          |
| 9   | Coding Agent          | `handleCodingAgentOrchestrator`                                                                                                                                                                                 | ~600          |
| 10  | Image & Vision        | `handleGenerateImage`, `handleEnhanceImage`, `handleVisualRecognition`, `handleUploadArtifactImage`                                                                                                             | ~350          |
| 11  | Repos & Staging       | `handleRepoOperations`, `handleRepoSync`, `handleStagingOperations`, `pullRepoFilesToDatabase`                                                                                                                  | ~700          |
| 12  | Secrets               | `handleSecretsManagement`                                                                                                                                                                                       | ~130          |
| 13  | Admin                 | `handleAdminManagement`, `handleSuperadminManagement`                                                                                                                                                           | ~120          |
| 14  | Audit Pipeline        | `handleAuditExtractConcepts`, `handleAuditMergeConceptsV2`, `handleAuditBuildTesseract`, `handleAuditGenerateVenn`, `handleAuditEnhancedSort`                                                                   | ~500          |
| 15  | Misc                  | `handleSummarize`, `handleRecastSlideLayout`, `handlePresentationAgent`, `handleIngestArtifacts`, `handleDatabaseAgentImport`, `handleDatabaseAgentOrchestrator`, `handleLogActivity`, `handleReportLocalIssue` | ~350          |

#### Open/Closed Principle (OCP)

Adding a new function requires modifying the central `switch` statement in the router (lines 34–175) **and** appending a handler to the same file. The file is not open for extension and closed for modification.

#### Interface Segregation Principle (ISP)

All handlers share the same `(req, res, body)` or `(req, res, body, functionName)` signature, but each uses a different subset of the `body` payload. There is no typed contract per handler — everything is `any`.

#### Dependency Inversion Principle (DIP)

Handlers directly instantiate/import infrastructure concerns inline:
- `await import('../config/aiModels')` — 20+ dynamic imports scattered across handlers
- `await import('@azure/identity')` — inline in multiple handlers
- `await import('fs')` / `await import('path')` — inline in coding agent, image upload, local package
- Direct `db.query()` calls mixed with `rpc.*` helper calls
- `queryWithPoolTarget()` dynamic imports inside `handleDatabaseProvisioning` (lines 1009, 1162)
- Direct `fetch()` calls to GitHub API and Azure ARM API

#### Liskov Substitution Principle (LSP)

Not directly violated but the lack of handler interfaces means handlers cannot be substituted or mocked for testing without importing the entire file.

### 1.3 Cross-Cutting Code Duplication

**AES-256-GCM encryption helpers** are copy-pasted in four locations:

| Handler                                   | Functions Duplicated                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `handleManageDatabase` (~line 588)        | `hexToBytes`, `isEncrypted`, `decryptValue`                                  |
| `handleDatabaseProvisioning` (~line 1082) | Inline `createCipheriv` + AES-256-GCM encrypt (no helper function extracted) |
| `handleGenerateLocalPackage` (~line 3610) | `hexToBytes`, `decryptValue`                                                 |
| `handleSecretsManagement` (~line 3734)    | `hexToBytes`, `bytesToHex`, `isEncrypted`, `encrypt`, `decrypt`              |

> **Note (post database-per-project work)**: The 4th duplication was introduced by the connection string encryption fix in `handleDatabaseProvisioning`. The inline encrypt block at ~line 1082 should be replaced with `encrypt()` from the shared `encryption.ts` utility during Phase 1 extraction.

**SSE streaming setup** is duplicated in 6+ handlers with identical header configuration:
- `handleCodingAgentOrchestrator`
- `handleAiArchitect` (critic mode)
- `handleOrchestrateAgents`
- `handleChatStream`
- `handleCollaborationOrchestrator`
- `handleGenerateSpecification`
- `handleAuditMergeConceptsV2`
- `handleAuditGenerateVenn`

**AI model initialization** pattern (`await import('../config/aiModels')` + `getDefaultModel()` + `buildEndpointUrl()`) is repeated 15+ times.

**JSON parsing with fallback** logic (try JSON.parse, fallback to regex extraction) is duplicated in 4+ handlers.

---

## 2. Target Architecture

### 2.1 Directory Structure

```
app/backend/src/routes/
├── functions.ts                  # Slim router: switch → handler map dispatch only
├── functions/
│   ├── index.ts                  # Re-exports handler registry
│   ├── types.ts                  # Shared handler type definitions
│   ├── auth.handlers.ts          # Auth domain handlers
│   ├── projects.handlers.ts      # Project CRUD handlers
│   ├── database.handlers.ts      # Database management + provisioning handlers
│   ├── deployments.handlers.ts   # Deployment service + preview token + local package
│   ├── ai-requirements.handlers.ts  # Expand/decompose requirements, expand standards
│   ├── ai-architect.handlers.ts  # AI architect generate + critic
│   ├── ai-streaming.handlers.ts  # Chat stream, collaboration, specification generation
│   ├── coding-agent.handlers.ts  # Coding agent orchestrator
│   ├── image.handlers.ts         # Generate/enhance image, visual recognition, upload
│   ├── repos.handlers.ts         # Repo CRUD, staging operations, repo sync (via GitProvider)
│   ├── secrets.handlers.ts       # Secrets management (database + deployment)
│   ├── admin.handlers.ts         # Admin + superadmin management
│   ├── audit.handlers.ts         # Audit pipeline (extract, merge, tesseract, venn, sort)
│   ├── misc.handlers.ts          # Summarize, presentation, ingest, log, report
│   └── orchestrate-agents.handlers.ts  # Multi-agent orchestration
│
app/backend/src/utils/
├── encryption.ts                 # Consolidated AES-256-GCM helpers (NEW)
├── sse.ts                        # SSE setup + send helpers (NEW)
├── ai-client.ts                  # AI model client wrapper (NEW)
├── json-parser.ts                # Wrapper around `jsonrepair` lib for LLM output (NEW)
├── git-provider.ts               # GitProvider interface — provider-agnostic Git operations (NEW)
├── github-provider.ts            # GitHubProvider — Octokit-based implementation of GitProvider (NEW)
```

### 2.2 Design Principles Applied

| Principle | Implementation                                                                                                                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SRP**   | Each handler file owns one domain. The router file owns only dispatch. Utility modules own cross-cutting concerns.                                                                                                                                         |
| **OCP**   | Handler registry pattern: adding a function means creating/editing a handler file and adding one entry to the registry map — no switch statement modification needed.                                                                                      |
| **ISP**   | Typed request body interfaces per handler (e.g., `DeploymentActionBody`, `SecretsActionBody`). Each handler depends only on the types it needs.                                                                                                            |
| **DIP**   | Handlers receive shared utilities via module imports rather than inline dynamic imports. AI client, encryption, SSE, and Git operations are injected as utility modules. `repos.handlers.ts` depends on a `GitProvider` interface, not on GitHub directly. |

---

## 3. Standards & Patterns

This section defines the conventions applied in **every phase**. Each phase references these standards rather than repeating them.

### 3.1 TDD Workflow (Per Domain)

For each domain extraction, follow this cycle:

```
1. WRITE tests against the current monolithic functions.ts
2. RUN tests → verify ALL GREEN
3. EXTRACT utility/handler(s) to new file(s)
4. RUN tests → verify ALL GREEN (same tests, same results)
5. REGISTER handlers in handlerRegistry, remove switch cases
6. RUN tests → verify ALL GREEN
7. COMMIT
```

If any test goes red after extraction, the extraction introduced a bug — fix before proceeding.

### 3.2 Test Pattern (Matches Existing Codebase Conventions)

Follow the established pattern from `projects.test.ts`, `deployment.test.ts`, etc.:

```typescript
// app/backend/src/__tests__/routes/functions/<domain>.handlers.test.ts
import express from 'express';
import 'express-async-errors';
import request from 'supertest';
import functionsRouter from '../../../routes/functions';  // Test against monolith first
import { errorHandler } from '../../../middleware/errorHandler';

jest.mock('../../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../../utils/database', () => {
  const queryFn = jest.fn();
  const queryWithPoolTargetFn = jest.fn();
  return {
    __esModule: true,
    default: { query: queryFn, queryWithPoolTarget: queryWithPoolTargetFn },
    queryWithPoolTarget: queryWithPoolTargetFn,
  };
});

jest.mock('../../../websocket', () => ({ broadcast: jest.fn() }));

import db from '../../../utils/database';
const mockDbQuery = db.query as jest.Mock;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'user-1', email: 'test@test.com' }; next(); });
  app.use('/functions', functionsRouter);
  app.use(errorHandler);
  return app;
}
```

### 3.3 SSE/Streaming Test Pattern

SSE-based handlers (`handleChatStream`, `handleAiArchitect` critic, `handleOrchestrateAgents`, etc.) require special test patterns since they write to the response stream instead of calling `res.json()`:

```typescript
it('streams SSE events for ai-architect-critic', async () => {
  jest.spyOn(global, 'fetch').mockResolvedValueOnce(/* mock SSE stream */);
  mockDbQuery.mockResolvedValueOnce({ rows: [{ /* project model settings */ }] });

  const res = await request(createApp())
    .post('/functions/ai-architect-critic')
    .send({ projectId: 'p1', /* ... */ })
    .buffer(true)
    .parse((res, callback) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => callback(null, data));
    });

  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toContain('text/event-stream');
  const events = res.body.split('\n\n').filter(Boolean);
  expect(events.length).toBeGreaterThan(0);
});
```

### 3.4 Coverage Targets

| Scope                                                              | Minimum Coverage           | Rationale                                                                |
| ------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------ |
| Shared utilities (`encryption`, `sse`, `ai-client`, `json-parser`) | 90%+ line coverage         | Small, critical modules — high coverage is cheap                         |
| Handler happy paths                                                | 100% of function names hit | Every `case` in the switch must have at least one test that exercises it |
| Handler error paths                                                | Key error branches         | Missing required fields, invalid actions, unknown sub-actions            |
| God function sub-actions                                           | 80%+ branch coverage       | Each nested switch case must be tested before decomposition              |

```bash
cd app/backend && npm run test:coverage -- --collectCoverageFrom='src/routes/functions.ts'
```

### 3.5 Handler Extraction Template

Each handler file follows this structure:

```typescript
// app/backend/src/routes/functions/<domain>.handlers.ts
import { Request, Response } from 'express';
import db from '../../utils/database';
import { logger } from '../../utils/logger';
import * as rpc from '../../utils/rpcHelpers';
import { broadcast } from '../../websocket';
import type { FunctionHandler } from './types';
// + domain-specific imports

/**
 * <Handler description>
 */
export const handle<Name>: FunctionHandler = async (req, res, body) => {
  // Exact same implementation as current monolith
};
```

### 3.6 Per-Phase Validation Checklist

After each phase, **all** of the following must pass before proceeding:

| Check                  | Command                                                             | Passes When                          |
| ---------------------- | ------------------------------------------------------------------- | ------------------------------------ |
| TypeScript compilation | `cd app/backend && npm run build`                                           | Zero errors                          |
| Lint                   | `cd app/backend && npx eslint src/`                                         | Zero errors                          |
| All tests              | `cd app/backend && npm test`                                                | All existing + new tests pass        |
| Endpoint smoke test    | Manual `POST /api/v1/functions/:functionName` for migrated handlers | Same response shape and status codes |

---

## 4. Incremental Refactor Phases

Each phase is a self-contained vertical slice that delivers a fully tested, working domain extraction. The codebase is always shippable between phases. Phases can be done across separate PRs.

> **Key mechanism**: The router uses a **hybrid dispatch** — checks the handler registry first, falls back to the existing switch statement for not-yet-migrated handlers. Each phase migrates handlers into the registry and removes corresponding switch cases. Phase 8 removes the empty switch.

### Phase 0: Foundation (Scaffolding)

**Goal**: Create the plumbing that enables incremental migration without changing any behavior.

**Deliverables**:
| File                                | Purpose                                          |
| ----------------------------------- | ------------------------------------------------ |
| `app/backend/src/routes/functions/types.ts` | `FunctionHandler` type + `HandlerRegistry` type  |
| `app/backend/src/routes/functions/index.ts` | Empty handler registry (grows with each phase)   |
| `app/backend/src/routes/functions.ts`       | Hybrid router: registry lookup → switch fallback |

**`types.ts`**:

```typescript
import { Request, Response } from 'express';

export type FunctionHandler = (
  req: Request,
  res: Response,
  body: any,
  functionName?: string
) => Promise<void> | void;

export type HandlerRegistry = Record<string, FunctionHandler>;
```

**`index.ts`** (initial — grows with each phase):

```typescript
import type { HandlerRegistry } from './types';

export const handlerRegistry: HandlerRegistry = {};
```

**Hybrid router** (replaces existing switch preamble):

```typescript
import { handlerRegistry } from './functions/index';

router.post('/:functionName', async (req: Request, res: Response) => {
  const { functionName } = req.params;
  const body = req.body || {};
  logger.info(`Function invoke: ${functionName}`);

  // Registry-dispatched handlers (migrated)
  const handler = handlerRegistry[functionName];
  if (handler) {
    return handler(req, res, body, functionName);
  }

  // Legacy switch fallback (removed incrementally per phase)
  switch (functionName) {
    // ... existing cases remain until migrated
  }
});
```

**Validation**: Build → existing tests pass → commit  
**Risk**: Very Low — no logic changes, just wiring  
**Effort**: Trivial (~1 hour)

---

### Phase 1: Database Domain

**Priority**: Highest — directly impacted by recent database-per-project isolation work. Most complex handler pair.

**Scope**:

| Deliverable                                                    | Type                              |
| -------------------------------------------------------------- | --------------------------------- |
| `app/backend/src/utils/encryption.ts`                                  | Shared utility (first extraction) |
| `app/backend/src/__tests__/utils/encryption.test.ts`                   | Utility tests                     |
| `app/backend/src/routes/functions/database.handlers.ts`                | Handler module                    |
| `app/backend/src/__tests__/routes/functions/database.handlers.test.ts` | Handler tests                     |

**Registered function names**: `manage-database`, `render-database`, `cloud-database`

**Steps**:

1. **TDD — encryption utility**: Write `encryption.test.ts`
   - Roundtrip encrypt/decrypt, `isEncrypted` detection, invalid key handling, hex conversion edge cases

2. **Extract `encryption.ts`** from `handleSecretsManagement` (most complete copy):
   ```typescript
   // app/backend/src/utils/encryption.ts
   import crypto from 'crypto';
   const ENCRYPTION_KEY = process.env.SECRETS_ENCRYPTION_KEY;

   export function hexToBytes(hex: string): Buffer { /* ... */ }
   export function bytesToHex(buf: Buffer): string { /* ... */ }
   export function isEncrypted(value: string): boolean { /* ... */ }
   export async function encrypt(plaintext: string): Promise<string> { /* ... */ }
   export async function decrypt(ciphertext: string): Promise<string> { /* ... */ }
   ```
   Replace inline encryption in `handleManageDatabase` (~line 588), `handleDatabaseProvisioning` (~line 1082), `handleGenerateLocalPackage` (~line 3610), and `handleSecretsManagement` (~line 3734) with imports.

3. **TDD — database handlers**: Write `database.handlers.test.ts`
   - `manage-database`: all 9 sub-actions (`get_schema`, `execute_sql`, `execute_sql_batch`, `getTableData`, `getTableColumns`, `exportTable`, `getTableDefinition`, `getViewDefinition`, `getFunctionDefinition`)
   - `render-database`/`cloud-database`: create (with encryption + `escapeLiteral`), delete, status (via `pg_database` + `queryWithPoolTarget`), connectionInfo (per-DB model), suspend, resume, restart

4. **Extract `database.handlers.ts`**: Cut `handleManageDatabase` + `handleDatabaseProvisioning` into handler module

5. **Register & remove switch cases**: Add entries to `handlerRegistry`, delete corresponding `case` blocks

6. **Validate**: Build → all tests green → commit

**Key considerations**:
- `handleDatabaseProvisioning` uses `queryWithPoolTarget()` via dynamic import (lines 1009, 1162) — convert to static import in handler file
- `handleDatabaseProvisioning` uses `escapeLiteral()` for SQL injection prevention in CREATE ROLE — preserve
- Inline AES-256-GCM encrypt block (~line 1082) replaced with `encrypt()` from `encryption.ts`
- `handleManageDatabase` uses decryption for connection string retrieval — replaced with `decrypt()` from `encryption.ts`

**Risk**: Medium  
**Effort**: Medium

---

### Phase 2: Auth, Admin & Misc

**Priority**: High — simplest handlers, builds confidence in the extraction pattern.

**Scope**:

| Deliverable                                           | Type           |
| ----------------------------------------------------- | -------------- |
| `app/backend/src/routes/functions/auth.handlers.ts`           | Handler module |
| `app/backend/src/routes/functions/admin.handlers.ts`          | Handler module |
| `app/backend/src/routes/functions/misc.handlers.ts`           | Handler module |
| `app/backend/src/routes/functions/ingest.handlers.ts`         | Handler module |
| 4 test files in `app/backend/src/__tests__/routes/functions/` | Handler tests  |

**Registered function names**: `validate-signup-code`, `send-auth-email`, `update-signup-validated`, `admin-management`, `superadmin-github-management`, `superadmin-cloud-management`, `log-activity`, `report-local-issue`, `database-agent-orchestrator`, `ingest-artifacts`

**Steps**:

1. **TDD**: Write test files for all 4 handler modules against monolith → green
   - Auth: valid/invalid signup codes, missing fields
   - Admin: user management CRUD, superadmin operations
   - Misc: log-activity, report-local-issue, stubs
   - Ingest: artifact ingestion flow

2. **Extract** 4 handler files (no new utilities needed)

3. **Register & remove switch cases**

4. **Validate**: Build → all tests green → commit

**Known dead code**: `handleAdminManagement` `delete_user` case (~line 2050) has unreachable code after first `return`. Remove during extraction.

**Risk**: Very Low  
**Effort**: Small

---

### Phase 3: Secrets & Projects

**Priority**: High — builds on `encryption.ts` from Phase 1.

**Scope**:

| Deliverable                                            | Type           |
| ------------------------------------------------------ | -------------- |
| `app/backend/src/routes/functions/secrets.handlers.ts`         | Handler module |
| `app/backend/src/routes/functions/projects.handlers.ts`        | Handler module |
| `app/backend/src/routes/functions/database-import.handlers.ts` | Handler module |
| 3 test files                                           | Handler tests  |

**Registered function names**: `database-connection-secrets`, `deployment-secrets`, `project-activity`, `create-project`, `delete-project`, `clone-project`, `database-agent-import`

**Steps**:

1. **TDD**: Write test files against monolith → green
   - Secrets: database-connection-secrets, deployment-secrets (encryption roundtrip)
   - Projects: CRUD operations, clone flow
   - Database Import: import flow

2. **Extract** 3 handler files
   - `secrets.handlers.ts` imports `encrypt`/`decrypt` from `../../utils/encryption` (Phase 1)
   - `projects.handlers.ts` uses `db`, `rpc`, `broadcast`, `logger`, GitHub API

3. **Register & remove switch cases**

4. **Validate**: Build → all tests green → commit

**Risk**: Low  
**Effort**: Small–Medium

---

### Phase 4: AI Core (Utilities + Requirements, Image, Streaming)

**Priority**: Medium — largest utility extraction phase. Introduces `ai-client.ts` and `sse.ts` that many subsequent handlers depend on.

**Scope**:

| Deliverable                                            | Type                 |
| ------------------------------------------------------ | -------------------- |
| `app/backend/src/utils/ai-client.ts`                           | Shared utility (NEW) |
| `app/backend/src/utils/sse.ts`                                 | Shared utility (NEW) |
| `app/backend/src/__tests__/utils/ai-client.test.ts`            | Utility tests        |
| `app/backend/src/__tests__/utils/sse.test.ts`                  | Utility tests        |
| `app/backend/src/routes/functions/ai-requirements.handlers.ts` | Handler module       |
| `app/backend/src/routes/functions/image.handlers.ts`           | Handler module       |
| `app/backend/src/routes/functions/ai-streaming.handlers.ts`    | Handler module       |
| 3 handler test files                                   | Handler tests        |

**Registered function names**: `ai-create-standards`, `expand-requirement`, `decompose-requirements`, `expand-standards`, `generate-image`, `enhance-image`, `visual-recognition`, `upload-artifact-image`, `chat-stream-foundry`, `collaboration-agent-orchestrator`, `generate-specification`, `summarize-artifact`, `summarize-chat`, `presentation-agent`, `recast-slide-layout`

**Steps**:

1. **TDD — ai-client utility**: Write `ai-client.test.ts`
   - Correct endpoint construction, default vs custom model, streaming flag, header propagation

2. **Extract `ai-client.ts`**:
   ```typescript
   // app/backend/src/utils/ai-client.ts
   import { getModelConfig, buildEndpointUrl, getDefaultModel } from '../config/aiModels';

   export interface AIChatOptions {
     model?: string;
     maxTokens?: number;
     temperature?: number;
     stream?: boolean;
     responseFormat?: { type: string };
   }

   export async function callAI(
     messages: Array<{ role: string; content: string | any[] }>,
     options: AIChatOptions = {}
   ): Promise<globalThis.Response> {
     const modelConfig = options.model
       ? (getModelConfig(options.model) || getDefaultModel())
       : getDefaultModel();
     const endpoint = buildEndpointUrl(modelConfig.id);

     return fetch(endpoint, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({
         messages,
         max_tokens: options.maxTokens ?? 4096,
         temperature: options.temperature ?? 0.7,
         ...(options.stream ? { stream: true } : {}),
         ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
       }),
     });
   }
   ```
   Replace 15+ occurrences of inline `await import('../config/aiModels')` + fetch construction in monolith.

3. **TDD — sse utility**: Write `sse.test.ts`
   - Headers set correctly, write format matches `data: {...}\n\n`, handles closed connection

4. **Extract `sse.ts`**:
   ```typescript
   // app/backend/src/utils/sse.ts
   import { Response } from 'express';

   export function setupSSE(res: Response): void {
     res.setHeader('Content-Type', 'text/event-stream');
     res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
     res.setHeader('Connection', 'keep-alive');
     res.setHeader('X-Accel-Buffering', 'no');
     res.setHeader('Access-Control-Allow-Origin', '*');
     res.flushHeaders();
   }

   export function sendSSE(res: Response, eventType: string, data: any): void {
     try {
       res.write(`data: ${JSON.stringify({ type: eventType, ...data })}\n\n`);
     } catch (e) { /* swallow write errors on closed connections */ }
   }

   export function sendNamedSSE(res: Response, event: string, data: any): void {
     res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
   }
   ```
   Replace inline SSE setup in 8+ handlers with imports.

5. **TDD — handler tests**: Write tests for AI requirements, image, AI streaming → green

6. **Extract** 3 handler files

7. **Register & remove switch cases**

8. **Validate**: Build → all tests green → commit

**Risk**: Medium  
**Effort**: Medium–Large

---

### Phase 5: Repos & Deployments

**Priority**: Medium–High — repos introduces the `GitProvider` abstraction, deployments is highest-risk extraction.

**Scope**:

| Deliverable                                        | Type                                                     |
| -------------------------------------------------- | -------------------------------------------------------- |
| `app/backend/src/utils/git-provider.ts`                    | Shared utility — `GitProvider` interface + factory (NEW) |
| `app/backend/src/utils/github-provider.ts`                 | `GitHubProvider` implementation using Octokit (NEW)      |
| `app/backend/src/__tests__/utils/git-provider.test.ts`     | Utility tests                                            |
| `app/backend/src/__tests__/utils/github-provider.test.ts`  | Utility tests                                            |
| `app/backend/src/routes/functions/repos.handlers.ts`       | Handler module                                           |
| `app/backend/src/routes/functions/deployments.handlers.ts` | Handler module                                           |
| 2 handler test files                               | Handler tests                                            |

**New dependency**: `npm install @octokit/rest` in `app/backend/`

**Registered function names**: `create-empty-repo`, `create-repo-from-template`, `clone-public-repo`, `link-existing-repo`, `sync-repo-push`, `sync-repo-pull`, `staging-operations`, `cloud-deployment`, `deployment-preview-token`, `generate-local-package`

**Steps**:

1. **TDD — git-provider**: Write `git-provider.test.ts` + `github-provider.test.ts`
   - Factory returns correct provider, throws for unknown providers
   - Each `GitHubProvider` method delegates to correct Octokit method, maps responses, handles errors

2. **Extract `git-provider.ts`** (interface + factory) and **`github-provider.ts`** (Octokit implementation)
   - See Appendix A for full implementation
   - `handleStagingOperations` is purely database-driven (RPC calls) — does NOT need `GitProvider`

3. **TDD — handler tests**: Write `repos.handlers.test.ts` + `deployments.handlers.test.ts` → green
   - Repos: all 4 repo operations, sync push/pull, staging operations
   - Deployments: all 10 sub-actions, preview token, local package generation

4. **Extract** 2 handler files
   - `repos.handlers.ts` imports `createGitProvider` from `../../utils/git-provider`
   - `deployments.handlers.ts` imports `encrypt`/`decrypt` from `../../utils/encryption` (Phase 1)

5. **Register & remove switch cases**

6. **Validate**: Build → all tests green → commit

**Risk**: High (deployments has Azure ARM API calls, many sub-actions)  
**Effort**: Large

---

### Phase 6: Complex AI & Orchestration

**Priority**: Medium — highest code complexity, needs `json-parser.ts`.

**Scope**:

| Deliverable                                               | Type                                        |
| --------------------------------------------------------- | ------------------------------------------- |
| `app/backend/src/utils/json-parser.ts`                            | Shared utility — `jsonrepair` wrapper (NEW) |
| `app/backend/src/__tests__/utils/json-parser.test.ts`             | Utility tests                               |
| `app/backend/src/routes/functions/coding-agent.handlers.ts`       | Handler module                              |
| `app/backend/src/routes/functions/ai-architect.handlers.ts`       | Handler module                              |
| `app/backend/src/routes/functions/orchestrate-agents.handlers.ts` | Handler module                              |
| 3 handler test files                                      | Handler tests                               |

**New dependency**: `npm install jsonrepair` in `app/backend/`

**Registered function names**: `coding-agent-orchestrator`, `ai-architect`, `ai-architect-critic`, `orchestrate-agents`

**Steps**:

1. **TDD — json-parser**: Write `json-parser.test.ts`
   ```typescript
   describe('parseJsonFromLLM', () => {
     it('parses valid JSON', () => {
       expect(parseJsonFromLLM('{"key": "value"}')).toEqual({ key: 'value' });
     });
     it('parses JSON wrapped in markdown fences', () => {
       expect(parseJsonFromLLM('```json\n{"ops": []}\n```')).toEqual({ ops: [] });
     });
     it('repairs trailing commas', () => {
       expect(parseJsonFromLLM('{"a": 1, "b": 2,}')).toEqual({ a: 1, b: 2 });
     });
     it('returns null for non-JSON text', () => {
       expect(parseJsonFromLLM('not json')).toBeNull();
     });
   });
   ```

2. **Extract `json-parser.ts`**:
   ```typescript
   // app/backend/src/utils/json-parser.ts
   import { jsonrepair } from 'jsonrepair';

   export function parseJsonFromLLM(text: string): any {
     try { return JSON.parse(jsonrepair(text)); }
     catch { return null; }
   }

   export function parseJsonFromLLMOrThrow(text: string): any {
     try { return JSON.parse(jsonrepair(text)); }
     catch (err) { throw new Error(`Failed to parse AI response: ${(err as Error).message}`); }
   }
   ```
   Replace `parseAgentResponse` (~line 2750) and `parseAIResponse` (~line 4877) with imports.

3. **TDD — handler tests**: Write tests for all 3 handler modules → green
   - Coding agent: session setup, AI streaming, operation execution
   - AI architect: generate + critic modes (SSE streaming pattern — see §3.3)
   - Orchestrate agents: multi-agent orchestration flow

4. **Extract** 3 handler files

5. **Register & remove switch cases**

6. **Validate**: Build → all tests green → commit

**Risk**: High (600+ line handlers, streaming, complex state)  
**Effort**: Large

---

### Phase 7: Audit Pipeline

**Priority**: Medium — self-contained domain, moderate complexity.

**Scope**:

| Deliverable                                                 | Type           |
| ----------------------------------------------------------- | -------------- |
| `app/backend/src/routes/functions/audit.handlers.ts`                | Handler module |
| `app/backend/src/__tests__/routes/functions/audit.handlers.test.ts` | Handler tests  |

**Registered function names**: `audit-orchestrator`, `audit-extract-concepts`, `audit-merge-concepts-v2`, `audit-build-tesseract`, `audit-generate-venn`, `audit-enhanced-sort`

**Steps**:

1. **TDD**: Write `audit.handlers.test.ts` → green
   - All 5 audit pipeline stages + orchestrator
   - SSE streaming pattern for `audit-merge-concepts-v2` and `audit-generate-venn`

2. **Extract** `audit.handlers.ts` (includes `callAuditLLM`, `getProjectModelSettings`, `TAXONOMY_MISSION` as module-private functions)
   - Uses `ai-client.ts` (Phase 4) and `sse.ts` (Phase 4)

3. **Register & remove switch cases**

4. **Validate**: Build → all tests green → commit

**Risk**: Medium  
**Effort**: Medium

---

### Phase 8: Finalize

**Goal**: Remove the switch fallback, leaving only registry-based dispatch. `functions.ts` shrinks from 6,453 lines to ~30 lines.

**Steps**:

1. **Verify** all function names are registered (compare registry keys against original switch cases)

2. **Remove** the switch fallback from the router:

   ```typescript
   // app/backend/src/routes/functions.ts (final form)
   import { Router, Request, Response } from 'express';
   import { logger } from '../utils/logger';
   import { Errors } from '../middleware/errorHandler';
   import { handlerRegistry } from './functions/index';

   const router = Router();

   router.post('/:functionName', async (req: Request, res: Response) => {
     const { functionName } = req.params;
     const body = req.body || {};

     logger.info(`Function invoke: ${functionName}`);

     const handler = handlerRegistry[functionName];
     if (!handler) {
       logger.warn(`Unknown function: ${functionName}`);
       throw Errors.notFound(`Function '${functionName}' not found`);
     }

     return handler(req, res, body, functionName);
   });

   export default router;
   ```

3. **Full validation**: Build → lint → all tests → endpoint smoke test for every function name

4. **Final commit**

**Risk**: Very Low (all handlers already migrated and tested)  
**Effort**: Trivial

---

## 5. God Function Decomposition (Within Handler Files)

These handlers contain nested `switch` statements and should be decomposed into sub-handlers **within their respective domain files** after extraction. This is an internal refactor within each handler file, not a structural change. It can be done as a follow-up within each phase or as a separate pass.

### 5.1 `handleManageDatabase` (~400 lines, 9 sub-actions) — Phase 1

Decompose into internal functions within `database.handlers.ts`:

```
handleManageDatabase
  ├── getSchema(req, res, body)
  ├── executeSql(req, res, body)
  ├── executeSqlBatch(req, res, body)
  ├── getTableData(req, res, body)
  ├── getTableColumns(req, res, body)
  ├── exportTable(req, res, body)
  ├── getTableDefinition(req, res, body)
  ├── getViewDefinition(req, res, body)
  └── getFunctionDefinition(req, res, body)
```

`handleManageDatabase` becomes a thin dispatcher:

```typescript
const dbActions: Record<string, (req, res, body) => Promise<void>> = {
  get_schema: getSchema,
  execute_sql: executeSql,
  execute_sql_batch: executeSqlBatch,
  // ...
};
```

### 5.2 `handleDeploymentService` (~800 lines, 10 sub-actions) — Phase 5

Decompose into internal functions within `deployments.handlers.ts`:

```
handleDeploymentService
  ├── getDeploymentStatus(...)
  ├── createDeployment(...)
  ├── deployContainerApp(...)
  ├── startContainerApp(...)
  ├── stopContainerApp(...)
  ├── restartContainerApp(...)
  ├── deleteDeployment(...)
  ├── getDeploymentLogs(...)
  ├── getEnvVars(...)
  └── updateEnvVars(...)
```

Also extract inline Azure REST helpers as private functions:
`getAzureToken()`, `azureRest()`, `pollOperation()`, `enableAcrTrustedServices()`, `disableAcrPublicAccess()`, `fixSecretsForPut()`, `assignAcrPullRole()`

### 5.3 `handleDatabaseProvisioning` (~310 lines, 7 sub-actions) — Phase 1

Decompose similarly within `database.handlers.ts`.

> **Note (post database-per-project work)**: This handler now uses `queryWithPoolTarget()` for per-database pool connections, `escapeLiteral()` for SQL injection prevention in CREATE ROLE, inline AES-256-GCM encryption for connection strings, and queries `pg_database` for status checks. These security and isolation improvements must be preserved during extraction and decomposition.

### 5.4 `handleCodingAgentOrchestrator` (~600 lines) — Phase 6

Decompose into logical stages within `coding-agent.handlers.ts`:

```
handleCodingAgentOrchestrator
  ├── validateAndSetupSession(...)       # Auth, session create/resume, SSE setup
  ├── buildSystemPrompt(...)             # Manifest, instructions, context assembly
  ├── callAIWithStreaming(...)            # AI call + token streaming
  ├── executeOperations(...)             # Operation dispatch loop
  └── finalizeIteration(...)             # Status update, broadcast, results
```

### 5.5 `handleRepoOperations` (~500 lines, 4 sub-actions) — Phase 5

Decompose within `repos.handlers.ts`:

```
handleRepoOperations
  ├── createEmptyRepo(...)
  ├── createRepoFromTemplate(...)
  ├── clonePublicRepo(...)
  └── linkExistingRepo(...)
```

---

## 6. Known Dead Code

| Location                                                 | Issue                                                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `handleAdminManagement`, `delete_user` case (~line 2050) | Unreachable code after first `return`: `res.json({ success: true, message: 'User account deleted' })` |

Remove during Phase 2 extraction.

---

## 7. Risk Mitigation

| Risk                               | Mitigation                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Breaking import paths              | Each handler file uses relative imports from `../../utils/*` and `../../websocket` — verified against existing `app/backend/src/` structure                                                                     |
| Missing exports                    | Handler registry in `index.ts` provides compile-time verification that all handlers are exported and importable                                                                                         |
| `functionName` parameter threading | Handlers that use `functionName` (e.g., `handleSecretsManagement`, `handleRepoOperations`, `handleSuperadminManagement`) receive it as the 4th argument — preserved in the registry via wrapper lambdas |
| Circular dependencies              | No handler imports another handler. All shared logic lives in `utils/`. The registry imports from handlers, not vice versa                                                                              |
| `this` binding                     | No handlers use `this` — all are standalone `async function` declarations, safe to export as named functions                                                                                            |
| Dynamic imports                    | `import('../config/aiModels')` calls within handlers are replaced with static imports from `../../utils/ai-client` which itself statically imports from `../config/aiModels`                            |
| Partial migration breakage         | Hybrid router (registry → switch fallback) ensures non-migrated handlers continue to work throughout the refactor. Each phase is independently shippable.                                               |

---

## 8. Execution Summary

| Phase | Domain             | Files Created                  | Utilities Extracted                     | Handlers Migrated                                          | Risk     | Effort       |
| ----- | ------------------ | ------------------------------ | --------------------------------------- | ---------------------------------------------------------- | -------- | ------------ |
| 0     | Foundation         | 2                              | —                                       | 0                                                          | Very Low | Trivial      |
| 1     | Database           | 2 handler + 2 utility          | `encryption.ts`                         | 3 (`manage-database`, `render-database`, `cloud-database`) | Medium   | Medium       |
| 2     | Auth, Admin, Misc  | 4 handler + 4 test             | —                                       | 10                                                         | Very Low | Small        |
| 3     | Secrets, Projects  | 3 handler + 3 test             | —                                       | 7                                                          | Low      | Small–Medium |
| 4     | AI Core            | 3 handler + 2 utility + 5 test | `ai-client.ts`, `sse.ts`                | 15                                                         | Medium   | Medium–Large |
| 5     | Repos, Deployments | 2 handler + 2 utility + 4 test | `git-provider.ts`, `github-provider.ts` | 10                                                         | High     | Large        |
| 6     | Complex AI         | 3 handler + 1 utility + 4 test | `json-parser.ts`                        | 4                                                          | High     | Large        |
| 7     | Audit              | 1 handler + 1 test             | —                                       | 6                                                          | Medium   | Medium       |
| 8     | Finalize           | 0 (modify router)              | —                                       | 0                                                          | Very Low | Trivial      |

**Totals**: 17 handler files, 6 utility modules, 23 test files, 2 new dependencies (`jsonrepair`, `@octokit/rest`)

**End state**: `functions.ts` shrinks from **6,453 lines to ~30 lines**. Handler logic is distributed across **17 domain files** averaging ~370 lines each. Six shared utility modules eliminate all cross-cutting duplication. A comprehensive test suite provides a behavioral safety net validated green at every step.

### TDD Invariant

At **no point** during the refactor are tests allowed to go red due to a structural change:

```
Write test → Green → Extract/Move code → Green → Register → Green → Commit
```

Any extraction that causes a test failure is a bug in the extraction, not in the test. Fix the extraction before proceeding.

---

## 9. Post-Refactor: Integration Testing with Testcontainers

Once the refactor is complete, the extracted database handlers (`database.handlers.ts`, `database-management.handlers.ts`) should be validated against a real PostgreSQL 16 engine using Testcontainers.

The full plan is documented in [003-TESTCONTAINERS_INTEGRATION_PLAN.md](003-TESTCONTAINERS_INTEGRATION_PLAN.md). It covers:

- **`proj_XXXX` lifecycle testing** — `CREATE DATABASE`, `CREATE ROLE`, `GRANT`, `DROP DATABASE WITH (FORCE)` against a containerized PostgreSQL 16 instance
- **User operations against `proj_XXXX`** — schema introspection, SQL execution, batch operations, data export via the refactored `handleManageDatabase`
- **Pool factory validation** — `queryWithPoolTarget` connecting to project databases
- **CI workflow** — A new `.github/workflows/ci.yml` that runs both mocked unit tests and Testcontainers integration tests

This integration testing step provides the confidence gate that the refactored code behaves identically to the original implementation when executing real DDL/DML against PostgreSQL.

---

## Appendix A: GitProvider Interface & Implementation

> Full implementation reference for Phase 5. See `git-provider.ts` (interface + factory) and `github-provider.ts` (Octokit implementation).

### `git-provider.ts`

```typescript
// app/backend/src/utils/git-provider.ts

export interface GitRepoInfo {
  name: string;
  fullName: string;
  htmlUrl: string;
  private: boolean;
  defaultBranch: string;
}

export interface GitTreeEntry {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

export interface GitBlobContent {
  content: string;
  encoding: 'utf-8' | 'base64';
  size: number;
}

export interface GitCommitInfo {
  sha: string;
  treeSha: string;
  message: string;
}

export interface CreateRepoOptions {
  private?: boolean;
  autoInit?: boolean;
  description?: string;
}

export interface CreateCommitOptions {
  message: string;
  treeSha: string;
  parents: string[];
}

export interface GitProvider {
  createRepo(name: string, options?: CreateRepoOptions): Promise<GitRepoInfo>;
  createRepoFromTemplate(templateOwner: string, templateRepo: string, name: string, options?: CreateRepoOptions): Promise<GitRepoInfo>;
  getRepo(owner: string, repo: string): Promise<GitRepoInfo>;
  verifyBranch(owner: string, repo: string, branch: string): Promise<boolean>;
  getTree(owner: string, repo: string, treeSha: string, recursive?: boolean): Promise<GitTreeEntry[]>;
  getBlob(owner: string, repo: string, sha: string): Promise<GitBlobContent>;
  createBlob(owner: string, repo: string, content: string, encoding: 'utf-8' | 'base64'): Promise<string>;
  getRef(owner: string, repo: string, branch: string): Promise<string>;
  getCommit(owner: string, repo: string, sha: string): Promise<GitCommitInfo>;
  createTree(owner: string, repo: string, tree: Array<{ path: string; mode: string; type: string; sha?: string; content?: string }>, baseTree?: string): Promise<string>;
  createCommit(owner: string, repo: string, options: CreateCommitOptions): Promise<string>;
  updateRef(owner: string, repo: string, branch: string, sha: string, force?: boolean): Promise<void>;
  createBranch(owner: string, repo: string, branch: string, sha: string): Promise<void>;
}

export function createGitProvider(provider: 'github', config: { token: string; userAgent?: string }): GitProvider {
  switch (provider) {
    case 'github': {
      const { GitHubProvider } = require('./github-provider');
      return new GitHubProvider(config.token, config.userAgent);
    }
    default:
      throw new Error(`Unsupported git provider: ${provider}`);
  }
}
```

### `github-provider.ts`

```typescript
// app/backend/src/utils/github-provider.ts
import { Octokit } from '@octokit/rest';
import type {
  GitProvider, GitRepoInfo, GitTreeEntry, GitBlobContent,
  GitCommitInfo, CreateRepoOptions, CreateCommitOptions,
} from './git-provider';

export class GitHubProvider implements GitProvider {
  private octokit: Octokit;

  constructor(token: string, userAgent = 'Pronghorn') {
    this.octokit = new Octokit({ auth: token, userAgent });
  }

  async createRepo(name: string, options: CreateRepoOptions = {}): Promise<GitRepoInfo> {
    const { data } = await this.octokit.repos.createForAuthenticatedUser({
      name, private: options.private ?? true, auto_init: options.autoInit ?? true, description: options.description,
    });
    return this.mapRepo(data);
  }

  async createRepoFromTemplate(templateOwner: string, templateRepo: string, name: string, options: CreateRepoOptions = {}): Promise<GitRepoInfo> {
    const { data } = await this.octokit.repos.createUsingTemplate({
      template_owner: templateOwner, template_repo: templateRepo, name,
      owner: undefined as any, private: options.private ?? true, description: options.description,
    });
    return this.mapRepo(data);
  }

  async getRepo(owner: string, repo: string): Promise<GitRepoInfo> {
    const { data } = await this.octokit.repos.get({ owner, repo });
    return this.mapRepo(data);
  }

  async verifyBranch(owner: string, repo: string, branch: string): Promise<boolean> {
    try { await this.octokit.repos.getBranch({ owner, repo, branch }); return true; }
    catch { return false; }
  }

  async getTree(owner: string, repo: string, treeSha: string, recursive = false): Promise<GitTreeEntry[]> {
    const { data } = await this.octokit.git.getTree({
      owner, repo, tree_sha: treeSha, ...(recursive ? { recursive: 'true' } : {}),
    });
    return (data.tree || []).map(item => ({
      path: item.path!, type: item.type as 'blob' | 'tree', sha: item.sha!, size: item.size,
    }));
  }

  async getBlob(owner: string, repo: string, sha: string): Promise<GitBlobContent> {
    const { data } = await this.octokit.git.getBlob({ owner, repo, file_sha: sha });
    return { content: data.content, encoding: data.encoding as 'utf-8' | 'base64', size: data.size };
  }

  async createBlob(owner: string, repo: string, content: string, encoding: 'utf-8' | 'base64'): Promise<string> {
    const { data } = await this.octokit.git.createBlob({ owner, repo, content, encoding });
    return data.sha;
  }

  async getRef(owner: string, repo: string, branch: string): Promise<string> {
    const { data } = await this.octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
    return data.object.sha;
  }

  async getCommit(owner: string, repo: string, sha: string): Promise<GitCommitInfo> {
    const { data } = await this.octokit.git.getCommit({ owner, repo, commit_sha: sha });
    return { sha: data.sha, treeSha: data.tree.sha, message: data.message };
  }

  async createTree(owner: string, repo: string, tree: Array<{ path: string; mode: string; type: string; sha?: string; content?: string }>, baseTree?: string): Promise<string> {
    const { data } = await this.octokit.git.createTree({
      owner, repo, tree: tree as any, ...(baseTree ? { base_tree: baseTree } : {}),
    });
    return data.sha;
  }

  async createCommit(owner: string, repo: string, options: CreateCommitOptions): Promise<string> {
    const { data } = await this.octokit.git.createCommit({
      owner, repo, message: options.message, tree: options.treeSha, parents: options.parents,
    });
    return data.sha;
  }

  async updateRef(owner: string, repo: string, branch: string, sha: string, force = false): Promise<void> {
    await this.octokit.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha, force });
  }

  async createBranch(owner: string, repo: string, branch: string, sha: string): Promise<void> {
    await this.octokit.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha });
  }

  private mapRepo(data: any): GitRepoInfo {
    return {
      name: data.name, fullName: data.full_name, htmlUrl: data.html_url,
      private: data.private, defaultBranch: data.default_branch,
    };
  }
}
```

> **Extensibility**: To add GitLab support, implement `GitLabProvider` in `gitlab-provider.ts` and add a `'gitlab'` case to `createGitProvider`. No handler code changes needed.

---

## Appendix B: Full Handler Registry (Phase 8 Final State)

```typescript
// app/backend/src/routes/functions/index.ts
import type { HandlerRegistry } from './types';

import { handleValidateSignupCode, handleSendAuthEmail, handleUpdateSignupValidated } from './auth.handlers';
import { handleAdminManagement, handleSuperadminManagement } from './admin.handlers';
import { handleProjectActivity, handleCreateProject, handleDeleteProject, handleCloneProject } from './projects.handlers';
import { handleManageDatabase, handleDatabaseProvisioning } from './database.handlers';
import { handleDeploymentService, handleDeploymentPreviewToken, handleGenerateLocalPackage } from './deployments.handlers';
import { handleAiPlaceholder } from './ai-requirements.handlers';
import { handleAiArchitect } from './ai-architect.handlers';
import { handleChatStream, handleCollaborationOrchestrator, handleGenerateSpecification, handleSummarize, handlePresentationAgent, handleRecastSlideLayout } from './ai-streaming.handlers';
import { handleCodingAgentOrchestrator } from './coding-agent.handlers';
import { handleGenerateImage, handleEnhanceImage, handleVisualRecognition, handleUploadArtifactImage } from './image.handlers';
import { handleRepoOperations, handleStagingOperations, handleRepoSync } from './repos.handlers';
import { handleSecretsManagement } from './secrets.handlers';
import { handleOrchestrateAgents } from './orchestrate-agents.handlers';
import { handleAuditOrchestrator, handleAuditExtractConcepts, handleAuditMergeConceptsV2, handleAuditBuildTesseract, handleAuditGenerateVenn, handleAuditEnhancedSort } from './audit.handlers';
import { handleLogActivity, handleReportLocalIssue, handleDatabaseAgentOrchestrator } from './misc.handlers';
import { handleDatabaseAgentImport } from './database-import.handlers';
import { handleIngestArtifacts } from './ingest.handlers';

export const handlerRegistry: HandlerRegistry = {
  'validate-signup-code': handleValidateSignupCode,
  'send-auth-email': handleSendAuthEmail,
  'update-signup-validated': handleUpdateSignupValidated,
  'project-activity': handleProjectActivity,
  'create-project': handleCreateProject,
  'delete-project': handleDeleteProject,
  'clone-project': handleCloneProject,
  'manage-database': handleManageDatabase,
  'render-database': handleDatabaseProvisioning,
  'cloud-database': handleDatabaseProvisioning,
  'cloud-deployment': handleDeploymentService,
  'deployment-preview-token': handleDeploymentPreviewToken,
  'admin-management': handleAdminManagement,
  'ai-create-standards': (req, res, body) => handleAiPlaceholder(req, res, body, 'ai-create-standards'),
  'expand-requirement': (req, res, body) => handleAiPlaceholder(req, res, body, 'expand-requirement'),
  'decompose-requirements': (req, res, body) => handleAiPlaceholder(req, res, body, 'decompose-requirements'),
  'expand-standards': (req, res, body) => handleAiPlaceholder(req, res, body, 'expand-standards'),
  'audit-orchestrator': handleAuditOrchestrator,
  'coding-agent-orchestrator': handleCodingAgentOrchestrator,
  'ai-architect': (req, res, body) => { body.__functionName = 'ai-architect'; return handleAiArchitect(req, res, body); },
  'ai-architect-critic': (req, res, body) => { body.__functionName = 'ai-architect-critic'; return handleAiArchitect(req, res, body); },
  'generate-image': handleGenerateImage,
  'upload-artifact-image': handleUploadArtifactImage,
  'generate-local-package': handleGenerateLocalPackage,
  'database-connection-secrets': (req, res, body) => handleSecretsManagement(req, res, body, 'database-connection-secrets'),
  'deployment-secrets': (req, res, body) => handleSecretsManagement(req, res, body, 'deployment-secrets'),
  'staging-operations': handleStagingOperations,
  'create-empty-repo': (req, res, body) => handleRepoOperations(req, res, body, 'create-empty-repo'),
  'create-repo-from-template': (req, res, body) => handleRepoOperations(req, res, body, 'create-repo-from-template'),
  'clone-public-repo': (req, res, body) => handleRepoOperations(req, res, body, 'clone-public-repo'),
  'link-existing-repo': (req, res, body) => handleRepoOperations(req, res, body, 'link-existing-repo'),
  'sync-repo-push': (req, res, body) => handleRepoSync(req, res, body, 'sync-repo-push'),
  'sync-repo-pull': (req, res, body) => handleRepoSync(req, res, body, 'sync-repo-pull'),
  'database-agent-import': handleDatabaseAgentImport,
  'superadmin-github-management': (req, res, body) => handleSuperadminManagement(req, res, body, 'superadmin-github-management'),
  'superadmin-cloud-management': (req, res, body) => handleSuperadminManagement(req, res, body, 'superadmin-cloud-management'),
  'enhance-image': handleEnhanceImage,
  'orchestrate-agents': handleOrchestrateAgents,
  'chat-stream-foundry': (req, res, body) => handleChatStream(req, res, body, 'chat-stream-foundry'),
  'collaboration-agent-orchestrator': handleCollaborationOrchestrator,
  'database-agent-orchestrator': handleDatabaseAgentOrchestrator,
  'generate-specification': handleGenerateSpecification,
  'ingest-artifacts': handleIngestArtifacts,
  'presentation-agent': handlePresentationAgent,
  'summarize-artifact': (req, res, body) => handleSummarize(req, res, body, 'summarize-artifact'),
  'summarize-chat': (req, res, body) => handleSummarize(req, res, body, 'summarize-chat'),
  'recast-slide-layout': handleRecastSlideLayout,
  'visual-recognition': handleVisualRecognition,
  'log-activity': handleLogActivity,
  'report-local-issue': handleReportLocalIssue,
  'audit-extract-concepts': handleAuditExtractConcepts,
  'audit-merge-concepts-v2': handleAuditMergeConceptsV2,
  'audit-build-tesseract': handleAuditBuildTesseract,
  'audit-generate-venn': handleAuditGenerateVenn,
  'audit-enhanced-sort': handleAuditEnhancedSort,
};
```
