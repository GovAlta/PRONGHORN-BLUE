# Data Model: Deployment Rollback Controls

## Deployment Snapshot

- **Purpose**: Immutable record of a successful deploy that can later seed
  rollback planning and live rollback execution.
- **Fields**:
  - `snapshotId`: unique identifier for the deploy snapshot
  - `environment`: deployment environment (`dev`, `test`, `prod`)
  - `archetype`: workflow archetype (`online`, `corp`)
  - `sourceRef`: branch, commit SHA, and workflow run metadata
  - `terraformStateKey`: backend state key used for the deployment
  - `componentSets`: resolved list of component sets and concrete resources
  - `runtimeArtifacts`: frontend/API image digests, tags, and container app
    revision identifiers when available
  - `aiDeployments`: model deployment names, versions, and SKU metadata
  - `outputs`: selected Terraform outputs needed for post-rollback validation
- **Relationships**:
  - One deployment snapshot can be referenced by many rollback requests.

## Rollback Request

- **Purpose**: Operator-submitted request describing what to inspect or roll
  back.
- **Fields**:
  - `requestId`: unique request identifier
  - `requestedAt`: timestamp
  - `requestedBy`: GitHub actor or operator identity
  - `environment`: target environment
  - `sourceSnapshotId`: snapshot chosen as rollback source
  - `mode`: `plan` or `execute`
  - `selectedScopes`: one or more rollback scope identifiers
  - `acknowledgementLevel`: none, stateless confirmation, destructive
    confirmation
  - `destructiveAcknowledgement`: operator-entered acknowledgement token when
    required
- **Relationships**:
  - One rollback request produces one rollback plan.
  - One rollback request can produce zero or one rollback execution record.

## Component Set

- **Purpose**: Named group of deployment-managed resources that share a rollback
  strategy and dependency boundaries.
- **Fields**:
  - `componentSetId`: stable scope key such as `infrastructure`,
    `database`, `application-runtime`, or `ai-models`
  - `displayName`: operator-facing label
  - `category`: `stateless`, `stateful`, or `foundational`
  - `owner`: `terraform`, `workflow`, `azure-cli`, or mixed
  - `resources`: concrete module names, resource names, scripts, and outputs
  - `rollbackStrategy`: planning, reconcile, targeted apply, targeted destroy,
    revision rollback, or deployment delete and recreate
- **Relationships**:
  - Component sets participate in dependency rules.

## Dependency Rule

- **Purpose**: Expresses ordering and blocking logic between component sets.
- **Fields**:
  - `ruleId`: unique identifier
  - `fromScope`: source component set
  - `toScope`: dependent component set
  - `relationshipType`: `requires-before`, `blocks-if-missing`,
    `validate-after`, or `conflicts-with`
  - `condition`: human-readable rule or precheck expression
  - `severity`: info, warning, blocking
- **Relationships**:
  - Many dependency rules can apply to one rollback request or plan.

## Preflight Check Result

- **Purpose**: Captures whether a rollback request is safe to execute.
- **Fields**:
  - `checkId`: unique identifier
  - `requestId`: owning rollback request
  - `scope`: component set being evaluated
  - `checkType`: auth, snapshot availability, resource existence, service state,
    dependency order, destructive acknowledgement, backup readiness
  - `status`: passed, warning, blocked
  - `details`: actionable operator message
- **Relationships**:
  - Many preflight checks belong to one rollback plan.

## Rollback Plan

- **Purpose**: Read-only or pre-execution plan output for a rollback request.
- **Fields**:
  - `planId`: unique identifier
  - `requestId`: source rollback request
  - `resolvedScopes`: normalized component sets included in the request
  - `excludedScopes`: explicitly untouched component sets
  - `orderedSteps`: dependency-safe execution order
  - `preflightChecks`: associated check results
  - `requiresDestructiveAck`: boolean
  - `safeStopStrategy`: instructions if execution halts mid-run
- **Relationships**:
  - One rollback plan can become one execution record.

## Rollback Step

- **Purpose**: Unit of work inside a rollback execution.
- **Fields**:
  - `stepId`: unique step identifier
  - `planId`: owning rollback plan
  - `scope`: owning component set
  - `actionType`: inspect, update, apply, destroy, restore, delete, validate
  - `status`: pending, running, completed, skipped, blocked, failed
  - `resourceRefs`: resource or artifact identifiers touched by the step
  - `message`: operator-facing outcome summary

## Rollback Execution Record

- **Purpose**: Auditable result of a live rollback run.
- **Fields**:
  - `executionId`: unique run identifier
  - `planId`: source rollback plan
  - `startedAt`: start timestamp
  - `finishedAt`: end timestamp
  - `overallStatus`: completed, partially completed, blocked, failed
  - `steps`: ordered rollback steps with outcomes
  - `postValidation`: per-scope validation outcomes
  - `followUpActions`: operator actions required after safe stop or failure
- **Relationships**:
  - One execution record references one rollback plan and many rollback steps.

## State Transitions

- `Rollback Request`: `draft` -> `planned` -> `approved-for-execution` ->
  `executing` -> `completed | blocked | failed`
- `Rollback Plan`: `generated` -> `approved` -> `consumed-by-execution | expired`
- `Rollback Step`: `pending` -> `running` -> `completed | skipped | blocked | failed`
- `Rollback Execution Record`: `started` -> `completed | partially completed | blocked | failed`
