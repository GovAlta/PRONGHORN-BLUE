<!--
Sync Impact Report
Version change: 1.0.0 -> 1.1.0
Modified principles:
- I. Contract Preservation and Compatibility (unchanged)
- II. Spec-Driven Traceability (unchanged)
- III. Verification Before Merge (NON-NEGOTIABLE) (unchanged)
- IV. Security and Compliance by Default (unchanged)
- V. Operability and Reproducible Delivery (unchanged)
Added sections:
- VI. UI/UX Layout Immutability (NON-NEGOTIABLE) — new principle
- Layer-Aware Development — new subsection under Platform Constraints
- Tooling Resources — new section documenting MCP servers and external skills
Removed sections:
- None
Templates requiring updates:
- ✅ .specify/templates/plan-template.md (verified; Constitution Check
  already lists principles generically — new principle VI is covered by the
  existing "Contract Preservation" and "Verification" checkboxes; plan
  authors MUST additionally confirm UI/UX immutability for frontend work)
- ✅ .specify/templates/spec-template.md (verified; no structural update
  required — specs touching src/** MUST note UI/UX impact per Principle VI)
- ✅ .specify/templates/tasks-template.md (verified; no structural update
  required — task validation includes layer identification per new subsection)
- ✅ .github/instructions/frontend.instructions.md (verified; already
  contains UI/UX immutability mandate)
- ✅ .github/agents/code-review.agent.md (verified; already enforces
  UI/UX immutability check)
- ✅ .github/copilot-instructions.md (verified; already contains UI/UX
  Layout Immutability section and layer-scoped development docs)
Follow-up TODOs:
- None
-->

# Pronghorn Constitution

## Core Principles

### I. Contract Preservation and Compatibility

All changes that affect user-facing behavior, persisted data, public APIs,
realtime events, or deployment interfaces MUST document the current contract,
the intended post-change contract, and the compatibility strategy before
implementation begins. Existing frontend flows, automation, and infrastructure
consumers MUST continue to work unless an intentional break is approved in the
feature spec and accompanied by migration or fallback steps.

Rationale: Pronghorn is a brownfield platform with live React, API, database,
and Azure deployment surfaces; untracked contract drift creates regressions
across multiple layers at once.

### II. Spec-Driven Traceability

Every non-trivial change MUST start from a feature spec, plan, and task set
that tie the requested outcome to concrete files, affected systems, and
validation evidence. Implementation work MUST be traceable from user story to
code path to verification artifact.

Rationale: The product itself is standards-first and agentic; the repository
must follow the same discipline it promotes.

### III. Verification Before Merge (NON-NEGOTIABLE)

Behavioral changes MUST include executable verification appropriate to the
risk: lint, build, targeted unit or integration tests, or a documented manual
validation procedure when automation is not practical. A change is not complete
until the required checks have been run or a blocker is explicitly recorded in
the feature artifacts.

Rationale: This repository spans frontend, API, database, and infrastructure
code; unverified changes create cross-layer failures that are expensive to
diagnose after merge or deployment.

### IV. Security and Compliance by Default

Secrets, tokens, certificates, tenant identifiers, and environment-specific
values MUST remain outside source control and flow through approved secret
stores or environment configuration. Features that touch authentication,
authorization, external connectivity, storage, or Azure resources MUST state
their security impact, least-privilege assumptions, and any
compliance-sensitive data handling.

Rationale: Pronghorn targets Government of Alberta and Azure-hosted
environments where security posture and auditability are core product
constraints, not optional hardening.

### V. Operability and Reproducible Delivery

Changes MUST preserve or improve observability, diagnosability, and repeatable
deployment. Any modification to runtime behavior, infrastructure, migrations,
or CI/CD MUST specify how it is deployed, monitored, rolled back, and validated
in the target environment.

Rationale: The repository includes Terraform, GitHub Actions, and Azure
delivery paths; undocumented operational changes are production risks even when
the code compiles.

### VI. UI/UX Layout Immutability (NON-NEGOTIABLE)

The existing user interface layout, visual hierarchy, page structure,
navigation patterns, and component arrangement MUST NOT be modified unless
explicitly approved in writing by the client. This includes but is not limited
to: page layouts, sidebar/header/footer structure, navigation flows,
modal/dialog patterns, component positioning, and responsive breakpoints.

Styling changes (colors, fonts, spacing) within the existing layout structure
ARE permitted when they do not alter structural layout. Any proposed layout
change MUST be flagged in the feature spec and plan, and MUST NOT proceed
without documented client approval attached to the spec artifacts.

Rationale: The UI/UX layout is an explicit client requirement reflecting
approved user research and stakeholder sign-off. Unauthorized layout changes
risk client relationship damage and require re-approval cycles that delay
delivery.

## Platform Constraints

Pronghorn is a TypeScript-first monorepo spanning a Vite/React frontend, a
Node/Express-style API surface, PostgreSQL schema and migrations, and Azure
infrastructure managed through Terraform and GitHub Actions. New work MUST fit
the existing repository layout unless the implementation plan justifies a
structural change.

Frontend changes MUST preserve the established application patterns, route
structure, authentication model, and data-contract expectations. Backend and
database changes MUST account for migration safety, token and RBAC rules, and
compatibility with the frontend adapter layer. Infrastructure changes MUST
remain declarative, environment-aware, and safe to execute through the
documented deployment workflow.

### Layer-Aware Development

The repository is organized into four development layers, each with distinct
tooling, validation requirements, and auto-attached instruction files:

| Layer          | Directory            | Instruction File           | Validation                                       |
| -------------- | -------------------- | -------------------------- | ------------------------------------------------ |
| Web App        | `app/frontend/src/`  | `frontend.instructions.md` | `npm run lint` + `npm run build` (app/frontend/) |
| API            | `app/backend/`       | `api.instructions.md`      | `npm run build` (app/backend/)                   |
| Infrastructure | `infra/`             | `infra.instructions.md`    | `terraform plan`                                 |
| CI/CD          | `.github/workflows/` | `cicd.instructions.md`     | Workflow syntax check                            |

Every change MUST identify which layers it touches. Validation MUST cover each
affected layer's build and test requirements. Cross-layer changes MUST validate
all touched layers before the change is considered complete.

## Tooling Resources

The following MCP servers and external skills are available to agents and
contributors for development, review, and deployment workflows:

**MCP Servers** (configured in `.vscode/mcp.json`):
- GitHub MCP (remote) — issues, PRs, Actions, code security, secret scanning
- Azure Terraform MCP — AzureRM/AzAPI provider docs, Azure Verified Modules,
  aztfexport, conftest policy validation
- PostgreSQL MCP — read-only schema introspection against local dev database
- Context7 — documentation lookup for any library
- Azure MCP (built-in) — 40+ Azure service namespaces, Terraform best
  practices, deployment guidance

**External Skills** (invoke by name in agent workflows):
- `azure-deploy`, `azure-validate`, `azure-diagnostics` — deployment lifecycle
- `azure-compliance`, `azure-rbac` — security posture
- `azure-observability`, `appinsights-instrumentation` — monitoring
- `entra-app-registration` — auth configuration
- `azure-enterprise-infra-planner` — infrastructure design
- `find-skills` — discover additional capabilities

## Delivery Workflow and Quality Gates

Work MUST follow the Spec Kit sequence for non-trivial changes: constitution,
specification, plan, tasks, then implementation. Plans MUST capture touched
subsystems, compatibility strategy, validation steps, security impact, and
operational impact before coding starts.

Pull requests and handoffs MUST include:

- the governing spec, plan, and tasks references;
- the exact validation performed or the reason it could not be completed;
- documentation updates when behavior, deployment, or operations changed;
- explicit notes for any intentional contract break, migration step, or
  follow-up work.

A feature MAY omit exhaustive automation only when the change is
documentation-only, purely cosmetic, or otherwise demonstrably non-behavioral.
In those cases, the artifacts MUST say why lower validation is sufficient.

## Governance

This constitution overrides ad hoc preferences for planning, implementation,
and review in this repository. Every feature plan and task list MUST include a
constitution check against these principles, and every review MUST verify
compliance or record an explicit exception.

Amendments require a pull request that updates `.specify/memory/constitution.md`
and any affected templates or prompt files in the same change. Versioning
follows semantic rules: MAJOR for removing or redefining a principle, MINOR for
adding a principle or materially expanding governance, PATCH for clarifications
that do not change expected behavior. Compliance review happens during
planning, before merge, and whenever deployment or migration risk changes
materially.

**Version**: 1.1.0 | **Ratified**: 2026-03-27 | **Last Amended**: 2026-05-01
