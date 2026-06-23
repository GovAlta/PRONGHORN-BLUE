# Specification Quality Checklist: Route Docker Container Deployments Through the Generated-App GitHub Actions Workflow

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-05-28
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- This is a brownfield refactor of a specific subsystem; certain proper nouns
  (the generated-app deploy workflow, the deployment service entry point, the
  `project_deployments` row, `resolveGitHubToken`) appear in requirements
  because they are existing contracts the feature must honour. These are
  contracts, not implementation prescriptions.
- The 1,400-line reduction in `functions.ts` (SC-006) is a structural success
  criterion that encodes the operator constraint "no new business logic in
  `functions.ts`". It is measurable and stable.
- The 30-minute stall window and 15-second poller interval are recorded as
  defaults in Assumptions / Success Criteria so they are testable while
  remaining tunable post-launch.
- All clarifications gathered before drafting were resolved up front:
  decomposition shape (single Docker-deployment module, factory deferred),
  legacy router disposition (delete), token resolution (`resolveGitHubToken`,
  with new dispatching-user-id column), backfill scope (none — legacy rows
  orphan on next deploy), `updateServiceConfig` scope (non-env fields only),
  cutover (single-commit with manual smoke test), naming tests (TypeScript
  unit tests only), and failure-mode requirements (dispatch error, stall,
  failure conclusion, pre-push failure, concurrent 409).
- Items marked incomplete require spec updates before `/speckit.clarify` or
  `/speckit.plan`.
