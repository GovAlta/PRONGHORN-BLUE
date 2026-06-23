# Static Data to API Endpoints Migration Plan

**Date:** 2026-05-14  
**Branch:** `pronghorn-feature-database-isolation`  
**Scope:** Frontend `app/frontend/public/data/*.json` and corresponding backend/API ownership

---

## Executive Summary

The frontend currently relies on multiple static JSON files under `app/frontend/public/data/`.
Some of these files are directly forwarded to backend AI handlers as instruction input, while others are UI-only defaults.

This creates three problems:

1. **Change control gap:** static files are deployed code artifacts, not runtime-managed configuration.
2. **Source-of-truth split:** some domains are DB-backed (RPC) while others remain file-backed.
3. **Security/consistency risk:** instruction-bearing content can be modified via code deploy without audit/version metadata.

This document proposes migrating all active static data to API endpoints (with DB-backed storage where appropriate), with staged rollout and compatibility fallback.

---

## Current State (Verified)

### A) Static files that are forwarded to backend as instructions

1. `agents.json`
- Loaded in frontend Specifications flow.
- Selected `systemPrompt` is sent to `/api/v1/functions/chat-stream-foundry`.
- Backend uses incoming `systemPrompt` directly in chat message construction.

2. `buildAgents.json`
- Loaded in iterative architecture flow.
- Agent nodes (including `data.systemPrompt`) are sent to `/api/v1/functions/orchestrate-agents`.
- Backend uses each node prompt for per-agent execution.

### B) Static files used as UI/default configuration (not authoritative backend instruction source today)

1. `codingAgentPromptTemplate.json`
2. `codingAgentToolsManifest.json`
3. `databaseAgentPromptTemplate.json`
4. `databaseAgentToolsManifest.json`

- Frontend loads these as default templates/manifests.
- Project-specific overrides are saved/retrieved via RPC (`get_project_agent_with_token`, `upsert_project_agent_with_token`).
- Backend `coding-agent-orchestrator` currently builds its own instruction/manifest from backend local files and does not apply frontend-sent custom prompt/tool payload as primary source.

### C) Static files used for non-instruction UI config

1. `deploymentSettings.json`
- Used by deployment dialog to populate project type presets.

2. `graphicStyles.json`
- Used by infographic dialog for style taxonomy and style prompt text.
- `stylePrompt` is sent in request body, but image generation backend currently validates/uses `prompt` and does not depend on style taxonomy from backend storage.

3. `connectionLogic.json`
- Imported client-side for canvas logic and connection rules.
- Not forwarded to backend.

---

## Supersedence and Gaps

## Already DB/API-backed domains

1. Project agent overrides:
- RPC endpoints exist for project agent config (`get_project_agent_with_token`, `upsert_project_agent_with_token`, `delete_project_agent_with_token`).

2. Canvas node taxonomy:
- DB table exists (`canvas_node_types`) and RPC endpoint exists (`get_canvas_node_types`).

3. Specifications persistence:
- RPC endpoint exists (`insert_specification_with_token`) and table exists (`project_specifications`).

## Gaps identified

1. No DB/API source for `agents.json` and `buildAgents.json` catalog definitions.
2. No DB/API source for deployment settings presets (`deploymentSettings.json`).
3. No DB/API source for infographic style taxonomy (`graphicStyles.json`).
4. No DB-backed source for canvas connection rules (`connectionLogic.json`) if runtime mutability is desired.
5. `project_agents` behavior exists in RPC/code, but there is no `project_agents` DDL in `infra/migrations/001_full_schema.sql` (schema drift risk).

---

## Security Considerations

Static JSON itself is not executable code, but instruction-bearing JSON can still be a control-plane input to LLM behavior.

Primary risks today:

1. **Prompt tampering via deployment pipeline:** if a static prompt file is modified, production behavior changes immediately after deploy.
2. **No row-level audit/version metadata:** static files do not have first-class DB audit trails.
3. **Validation mismatch:** frontend may send fields backend ignores, causing false assumptions about effective behavior.

Moving these assets to API + DB allows:

1. validation,
2. versioning,
3. role-based mutation controls,
4. explicit audit trail,
5. safer rollback.

---

## Proposed Target Architecture

Introduce a versioned configuration API surface under `/api/v1/config/*` with DB-backed storage.

### Proposed endpoint groups

1. `GET /api/v1/config/agent-catalog?context=specifications|iterative`
- Replaces `agents.json` and `buildAgents.json` fetches.
- Returns active catalog entries with version metadata.

2. `GET /api/v1/config/agent-templates?agentType=coding|database`
- Replaces default prompt template/manifests static loads.
- Returns baseline template + tool manifest.

3. `GET /api/v1/config/deployment-settings`
- Replaces `deploymentSettings.json`.

4. `GET /api/v1/config/graphic-styles`
- Replaces `graphicStyles.json`.

5. `GET /api/v1/config/connection-rules`
- Replaces `connectionLogic.json` import (if server-managed behavior desired).

6. Admin mutation endpoints (owner/admin only):
- `POST /api/v1/config/...`
- `PATCH /api/v1/config/...`
- `DELETE /api/v1/config/...`
- gated behind existing auth and project/org role checks.

---

## Proposed Data Model (Minimal)

Use generic configuration tables for rapid migration, with optional later specialization.

1. `config_catalogs`
- `id`, `domain`, `name`, `version`, `is_active`, `created_at`, `updated_at`, `created_by`.

2. `config_entries`
- `id`, `catalog_id`, `key`, `value_jsonb`, `order_score`, `is_active`, `created_at`, `updated_at`.

3. `config_entry_versions` (optional phase 2)
- immutable historical snapshots for rollback/audit.

Domain examples:
- `agent_catalog_specifications`
- `agent_catalog_iterative`
- `agent_template_coding`
- `agent_template_database`
- `deployment_settings`
- `graphic_styles`
- `connection_rules`

Note: For high-query domains (`agent catalogs`), specialization tables can be introduced later after usage patterns are known.

---

## Migration Plan (Phased)

### Phase 0: Stabilize and baseline

1. Document all static data consumers (completed in this analysis).
2. Add explicit telemetry logs for config-source resolution (`static` vs `api` fallback).
3. Confirm/add schema migration for any missing runtime tables (including `project_agents` alignment).

### Phase 1: Read API with static fallback

1. Implement read-only endpoints under `/api/v1/config/*`.
2. Seed DB from existing static JSON content.
3. Frontend fetch order:
- try API first,
- fallback to current static JSON if API unavailable.
4. Keep behavior parity; no UI structure changes required.

### Phase 2: Backend instruction source alignment

1. For `coding-agent-orchestrator` and `database-agent-orchestrator`, resolve templates/manifests from DB/API first.
2. Retain backend local static fallback only for resilience.
3. Validate custom prompt/tool payload handling path and make effective-source explicit in logs.

### Phase 3: Remove frontend static dependency

1. Replace all `/data/*.json` fetch/import with API calls.
2. Remove now-unused files from `app/frontend/public/data/`.
3. Add integration tests to verify API-config availability and fallback behavior.

### Phase 4: Lockdown and governance

1. Restrict config mutations to privileged roles.
2. Add change history and rollback endpoints.
3. Add optional approval workflow for prompt-bearing config changes.

---

## API Contract and Validation Requirements

For prompt-bearing payloads:

1. Validate required fields (`id`, `label`, `systemPrompt`, etc.).
2. Enforce content size limits and UTF-8 normalization.
3. Reject malformed schema with 400.
4. Include `version`, `updated_at`, and `source` fields in responses.

For style/settings payloads:

1. Validate enum fields and allowed value sets.
2. Strip unknown fields unless explicitly allowed.
3. Return stable sorted order for deterministic UI rendering.

---

## Testing and Rollout Checks

1. Unit tests for each config endpoint response schema.
2. Integration tests for frontend API-first + static fallback behavior.
3. Regression tests for:
- Specifications generation path,
- Iterative orchestration path,
- Deployment dialog defaults,
- Infographic style selection,
- Canvas connection logic.
4. Runtime verification in dev:
- no direct `/data/*.json` network fetches after cutover,
- expected config endpoint calls visible and successful.

---

## Recommended Near-Term Work Items

1. Create migration `00x_add_config_catalog_tables.sql` and seed script from current static JSON.
2. Implement `GET /api/v1/config/agent-catalog` and migrate `agents.json` + `buildAgents.json` first (highest priority because these feed AI instructions).
3. Implement `GET /api/v1/config/deployment-settings` and `GET /api/v1/config/graphic-styles`.
4. Decide whether `connectionLogic` should remain frontend-static (fast path) or move to server-managed config (governed path).
5. Reconcile and codify `project_agents` DDL in migrations to remove schema drift.

---

## Decision Request

For implementation planning, confirm the preferred policy:

1. **Governed Runtime Config (recommended):** all active `public/data` moved to DB/API with role-controlled mutation and versioning.
2. **Hybrid:** instruction-bearing files moved first (`agents`, `buildAgents`, templates/manifests), while pure UI lookup files remain static.
3. **Minimal change:** keep static files, but add signing/checksum and strict CI controls (lowest engineering change, weaker runtime governance).
