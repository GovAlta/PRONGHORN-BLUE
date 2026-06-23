# Tasks: Deployment Rollback Controls

**Input**: Design documents from `/specs/001-deployment-rollback/`
**Prerequisites**: [plan.md](c:/onedrive-prsn/OneDrive/02.00.00.GENERAL/repos/git/pronghorn/specs/001-deployment-rollback/plan.md) (required), [spec.md](c:/onedrive-prsn/OneDrive/02.00.00.GENERAL/repos/git/pronghorn/specs/001-deployment-rollback/spec.md) (required for user stories), [research.md](c:/onedrive-prsn/OneDrive/02.00.00.GENERAL/repos/git/pronghorn/specs/001-deployment-rollback/research.md), [data-model.md](c:/onedrive-prsn/OneDrive/02.00.00.GENERAL/repos/git/pronghorn/specs/001-deployment-rollback/data-model.md), [contracts/rollback-workflow-dispatch.md](c:/onedrive-prsn/OneDrive/02.00.00.GENERAL/repos/git/pronghorn/specs/001-deployment-rollback/contracts/rollback-workflow-dispatch.md), [contracts/rollback-record.schema.json](c:/onedrive-prsn/OneDrive/02.00.00.GENERAL/repos/git/pronghorn/specs/001-deployment-rollback/contracts/rollback-record.schema.json), [quickstart.md](c:/onedrive-prsn/OneDrive/02.00.00.GENERAL/repos/git/pronghorn/specs/001-deployment-rollback/quickstart.md)

**Tests**: Include validation tasks because this feature changes workflow behavior, deployment orchestration, infrastructure handling, and destructive-operation safeguards.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish shared rollback configuration and validation entry points used by all stories.

- [X] T001 Create the rollback component-set manifest in infra/config/rollback-component-sets.json
- [X] T002 Create the shared rollback helper module in infra/scripts/rollback-helpers.ps1
- [X] T003 [P] Add rollback validation test script entries in package.json

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add shared workflow contracts, snapshot handling, and artifact plumbing before any user story can be implemented.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T004 Extend workflow dispatch inputs and rollback mode guards in .github/workflows/deploy-to-azure.yml
- [X] T005 [P] Implement rollback auth/config preflight checks for plan and execute modes in infra/scripts/test-rollback-prerequisites.ps1
- [X] T006 [P] Add deployment snapshot capture logic in infra/scripts/get-deployment-snapshot.ps1
- [X] T007 [P] Add rollback snapshot resolution logic in infra/scripts/resolve-rollback-snapshot.ps1
- [X] T008 Implement shared rollback plan construction in infra/scripts/new-rollback-plan.ps1
- [X] T009 Implement rollback record schema validation in infra/scripts/validate-rollback-record.ps1
- [X] T010 Wire snapshot publishing, rollback plan artifacts, shared summaries, and rollback preflight checks into .github/workflows/deploy-to-azure.yml

**Checkpoint**: Shared rollback configuration, snapshot artifacts, and workflow dispatch contracts are ready.

---

## Phase 3: User Story 1 - Safe Rollback Planning (Priority: P1) 🎯 MVP

**Goal**: Let operators choose rollback scopes and inspect dependency-safe rollback plans without performing destructive actions.

**Independent Test**: Dispatch the workflow in `rollback-plan` mode and confirm that `rollback-plan.json` lists resolved scopes, excluded scopes, dependency ordering, blocked checks, and confirmation requirements without changing Azure resources.

### Tests for User Story 1

- [X] T011 [P] [US1] Add rollback plan contract tests in infra/scripts/tests/rollback-plan-contract.test.js
- [X] T012 [P] [US1] Add workflow rollback input validation tests in infra/scripts/tests/rollback-dispatch-inputs.test.js

### Implementation for User Story 1

- [X] T013 [US1] Implement scope normalization and component-set resolution in infra/scripts/new-rollback-plan.ps1
- [X] T014 [US1] Implement dependency-rule evaluation and blocked-step output in infra/scripts/new-rollback-plan.ps1
- [X] T015 [US1] Emit rollback-plan.json and plan-only job summaries from .github/workflows/deploy-to-azure.yml
- [X] T016 [US1] Update rollback planning examples and operator expectations in specs/001-deployment-rollback/quickstart.md

**Checkpoint**: Operators can generate and review a rollback plan safely before any live execution exists.

---

## Phase 4: User Story 2 - Targeted Stateless Rollback (Priority: P2)

**Goal**: Let operators roll back application runtime or AI model deployments independently from infrastructure and database resources.

**Independent Test**: Dispatch the workflow in `rollback-execute` mode for `application-runtime` or `ai-models` only and confirm that only the selected stateless scope is reverted while all unselected scopes remain untouched.

### Tests for User Story 2

- [X] T017 [P] [US2] Add application-runtime rollback tests in infra/scripts/tests/application-runtime-rollback.test.js
- [X] T018 [P] [US2] Add AI model rollback tests in infra/scripts/tests/ai-model-rollback.test.js

### Implementation for User Story 2

- [X] T019 [US2] Extend runtime rollback image and revision resolution in infra/scripts/deploy-containers.ps1
- [X] T020 [US2] Extend AI deployment reconciliation to use rollback snapshots in infra/scripts/deploy-models.ps1
- [X] T021 [US2] Implement stateless rollback execution orchestration in infra/scripts/invoke-rollback-execution.ps1
- [X] T022 [US2] Wire stateless rollback-execute paths into .github/workflows/deploy-to-azure.yml

**Checkpoint**: Stateless rollback for runtime and AI deployments works independently of stateful teardown paths.

---

## Phase 5: User Story 3 - Guarded Stateful Rollback (Priority: P3)

**Goal**: Enforce preflight checks, dependency-safe ordering, and explicit destructive acknowledgement for database-related and foundational rollback scopes.

**Independent Test**: Dispatch the workflow in `rollback-execute` mode for `database` or `infrastructure` and confirm the run blocks when preconditions or acknowledgement requirements are missing, or records safe-stop and partial outcomes when an execution path is interrupted.

### Tests for User Story 3

- [X] T023 [P] [US3] Add stateful preflight and destructive acknowledgement tests in infra/scripts/tests/stateful-rollback-guards.test.js
- [X] T024 [P] [US3] Add rollback execution record schema tests in infra/scripts/tests/rollback-execution-record.test.js

### Implementation for User Story 3

- [X] T025 [US3] Implement database and infrastructure preflight guards in infra/scripts/invoke-rollback-execution.ps1
- [X] T026 [US3] Implement guarded infrastructure rollback strategy in infra/scripts/deploy.ps1
- [X] T027 [US3] Enforce destructive acknowledgement, safe-stop behavior, and partial outcome handling in .github/workflows/deploy-to-azure.yml
- [X] T028 [US3] Persist and validate rollback-execution.json against specs/001-deployment-rollback/contracts/rollback-record.schema.json in infra/scripts/validate-rollback-record.ps1

**Checkpoint**: Stateful rollback is available only through guarded, auditable execution paths.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Finalize documentation, validation commands, and operator guidance across all rollback paths.

- [X] T029 Implement per-scope post-rollback validation checks and summary output in infra/scripts/test-post-rollback-state.ps1
- [X] T030 [P] Update operator-facing rollback documentation in docs/deployment-rollback.md
- [X] T031 [P] Add post-rollback validation tests in infra/scripts/tests/post-rollback-validation.test.js
- [X] T032 Document final validation commands and manual checks in specs/001-deployment-rollback/quickstart.md

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1: Setup** starts immediately.
- **Phase 2: Foundational** depends on Phase 1 and blocks all story work.
- **Phase 3: User Story 1** depends on Phase 2 and is the MVP.
- **Phase 4: User Story 2** depends on Phase 2 and reuses snapshot and plan artifacts from User Story 1.
- **Phase 5: User Story 3** depends on Phases 2 and 3, and builds on the execution flow introduced in User Story 2.
- **Phase 6: Polish** depends on the stories that are intended for the release.

### User Story Dependencies

- **US1** has no dependency on later stories and is independently deliverable once the foundational phase is complete.
- **US2** depends on the shared snapshot and plan infrastructure from the foundational phase and should reuse the rollback plan contract from US1.
- **US3** depends on the shared execution orchestration from US2 and the planning safeguards from US1.

### Parallel Opportunities

- `T003` can run in parallel with `T001` and `T002`.
- `T006` and `T007` can run in parallel after `T004` and `T005` establish the workflow contract and rollback preflight checks.
- `T011` and `T012` can run in parallel before US1 implementation.
- `T017` and `T018` can run in parallel before US2 implementation.
- `T023` and `T024` can run in parallel before US3 implementation.
- `T030` and `T031` can run in parallel during the polish phase.

---

## Parallel Example: User Story 1

```text
Task: "Add rollback plan contract tests in infra/scripts/tests/rollback-plan-contract.test.js"
Task: "Add workflow rollback input validation tests in infra/scripts/tests/rollback-dispatch-inputs.test.js"
```

## Parallel Example: User Story 2

```text
Task: "Add application-runtime rollback tests in infra/scripts/tests/application-runtime-rollback.test.js"
Task: "Add AI model rollback tests in infra/scripts/tests/ai-model-rollback.test.js"
```

## Parallel Example: User Story 3

```text
Task: "Add stateful preflight and destructive acknowledgement tests in infra/scripts/tests/stateful-rollback-guards.test.js"
Task: "Add rollback execution record schema tests in infra/scripts/tests/rollback-execution-record.test.js"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 and Phase 2 to establish rollback workflow inputs, snapshots, and shared planning helpers.
2. Complete Phase 3 to deliver read-only rollback planning.
3. Validate the quickstart rollback-plan scenario before moving to live execution.

### Incremental Delivery

1. Deliver US1 to give operators safe planning and visibility.
2. Deliver US2 to add low-risk stateless rollback.
3. Deliver US3 to add guarded stateful rollback after the execution path is proven.
4. Finish with Phase 6 documentation and validation hardening.

### Suggested MVP Scope

- **MVP**: Phase 1, Phase 2, and Phase 3 only.
- **Second increment**: Phase 4 for stateless runtime and AI rollback.
- **Final increment**: Phase 5 and Phase 6 for guarded destructive rollback and operator hardening.

---

## Notes

- Every task follows the required checklist format with a task ID and exact file path.
- Tests are included because the feature changes workflow behavior and destructive safeguards.
- The task list assumes implementation stays workflow-and-infrastructure-first and does not introduce product UI work unless later required.
