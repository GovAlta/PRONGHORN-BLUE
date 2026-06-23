# Build v2 — Standalone Git-Native File Management (Feature-Flagged Per Project)

> Status: Plan / proposal. Not yet implemented.
> Supersedes (for the Build tab file-management problem): the unify-three-lifecycles proposal discussed prior; this doc is the authoritative starting point for v2 work.

A complete v2 of Build + file management, shipped alongside v1 with **zero behavioral changes to v1**. Users opt projects in via a per-project toggle. v2 starts empty per project (no import from v1), the AI coding agent remains on v1, and v2 reuses v1's GitHub auth chain. Built on a real git working tree via [`isomorphic-git`](https://isomorphic-git.org/) against an Azure Blob FS adapter, exposed as git porcelain over REST, with a Monaco-driven UI.

---

## 1. Goals & non-goals

### Goals
- Ship Build v2 as a fully standalone feature with its own routes, tables, blob namespace, WS channel, and React components.
- Provide a clean per-project toggle (project owner opts in/out) that flips the Build tab between v1 and v2; no other surface changes.
- Use git semantics end-to-end: stage / commit / push / pull / diff / log / revert / reset / branch / merge, all backed by real git objects.
- Reuse v1's GitHub auth resolution (`repo_pats` → user OAuth → `GITHUB_TOKEN`) so users don't reconnect.
- Allow safe staged rollout (env gate → per-project opt-in) and safe rollback (toggle off; v2 data persists for re-enable).

### Non-goals (this release)
- AI coding agent in v2 (stays on v1; AI sessions on v2-enabled projects still operate against v1 storage with a clear banner — see §7).
- Migrating any existing v1 project data into v2.
- Replacing v1. v2 and v1 coexist indefinitely; cutover is a future decision.
- UI/UX layout changes outside the Build tab and one Settings row.
- Multi-tab/multi-tenant changes; v2 stays single-project-scoped.

---

## 2. User stories

1. **As a project owner** I can flip "Build v2 (preview)" on in Project Settings and the Build tab switches to v2 for everyone on the project.
2. **As a developer** in a v2 project I can connect an empty project to a GitHub repo and `git clone` the contents into v2.
3. **As a developer** I can edit, see a Monaco side-by-side diff vs HEAD, write a commit message, commit, and push — without leaving the Build tab.
4. **As a developer** I can see commit history, click any commit, view the diff for that commit, and revert or hard-reset to it.
5. **As a developer** I can create and switch branches, and pull from `origin` with a clear conflict prompt if pull diverges.
6. **As a developer** I can push to multiple remotes (mirrors) with one "Sync all" action.
7. **As a project owner** I can disable v2 and return the Build tab to v1; my v2 data is preserved if I re-enable.
8. **As staff** I can flip a global env gate that hides the v2 toggle from all users, regardless of per-project state, for incident response.

---

## 3. Functional requirements

### F1. Toggle & gating
- **F1.1** Global env gate: `ENABLE_BUILD_V2=true|false` (default `false` until GA). When `false`, the per-project toggle is hidden and any v2 routes return `404`.
- **F1.2** Per-project flag: stored as `projects.build_v2_enabled BOOLEAN NOT NULL DEFAULT false`. Only project owner can change it.
- **F1.3** Switching off does **not** delete v2 data. Switching on a previously enabled project restores the prior v2 repo state.
- **F1.4** The toggle is visible in Project Settings (existing page; **new toggle row only**, no layout change).
- **F1.5** Build tab reads the flag once on mount and on toggle change; no flicker between v1 and v2 in the same session.

### F2. Repository lifecycle
- **F2.1** First v2 open on a project initializes an empty bare-ish repo: `git.init({ defaultBranch: 'main' })`, an initial empty commit, no remote configured. Idempotent.
- **F2.2** The user can attach a GitHub remote via "Connect repository": picks org/repo from a list (reusing v1's GitHub lister) → `git.remote add origin <url>` → `git.fetch` → choose to `clone` (`git.checkout origin/main` into empty repo) or `keep` (treat the empty repo as truth; future push will populate the GitHub repo).
- **F2.3** Multiple remotes supported: `origin` (primary) + arbitrary additional named remotes for mirrors.
- **F2.4** Disconnect removes the remote configuration but keeps local commits.

### F3. Working tree operations
- **F3.1** List tree at a ref (`GET /tree?ref=`).
- **F3.2** Read file content at a ref or from the working tree (`GET /blob`).
- **F3.3** Write/overwrite a working-tree file (`PUT /blob`). Binary detection is server-side from content (not extension).
- **F3.4** Delete a working-tree file (`DELETE /blob`).
- **F3.5** Rename/move (`POST /move`).
- **F3.6** Status across head/workdir/stage (`GET /status` returns `git.statusMatrix` rows).
- **F3.7** Discard working-tree changes per path (`POST /checkout { paths }`).
- **F3.8** Server-enforced per-file size limit (config: `BUILD_V2_MAX_FILE_BYTES`, default 10 MiB). Returns `413`.
- **F3.9** Server-enforced repo-size soft cap (warn at 500 MiB, hard cap configurable). Returns `507` past hard cap.

### F4. Commits
- **F4.1** `POST /commit { message, paths?, author? }` — adds the specified paths (or all dirty) and commits. Empty commits rejected.
- **F4.2** `GET /log?ref&path&limit` — paginated commit list.
- **F4.3** `GET /commits/{sha}` — commit details + changed files + per-file numstat.
- **F4.4** `POST /revert { sha }` — inverse commit; preserves history; conflict-aware.
- **F4.5** `POST /reset { ref, mode }` — `soft` / `mixed` / `hard`; `hard` requires explicit `confirm: true` in payload.
- **F4.6** `POST /checkout { ref, paths? }` — switch branch (no paths) or restore files from a ref.

### F5. Diffs
- **F5.1** `GET /diff?path&base&head` — unified diff text plus JSON hunks. `head=WORKDIR` allowed.
- **F5.2** `GET /diff?base&head` (no path) — whole-tree diff summary `{ added, modified, deleted, renamed }`.
- **F5.3** Monaco `DiffEditor` in the UI is fed `GET /blob?ref=base` + buffer; no diff library needed client-side.

### F6. Branches
- **F6.1** `GET /branches`, `POST /branches { name, from? }`, `DELETE /branches/{name}`.
- **F6.2** Branch switching is `POST /checkout { ref: name }`. Refused if working tree is dirty (returns `409` with paths).

### F7. Remotes & GitHub
- **F7.1** `GET / POST / DELETE /remotes` — name + URL.
- **F7.2** `POST /fetch`, `POST /pull`, `POST /push`, `POST /push-all`.
- **F7.3** Auth chain reused from v1: a single `resolveGitHubToken(projectId, repoUrl, userId)` helper used by every v2 GitHub call. **Refactor in v1:** extract the existing chain in `app/backend/src/utils/githubAuth.ts` into a pure function with no edge-fn coupling so v2 can import it (see §8 Allowed v1 refactors).
- **F7.4** Push refuses non-fast-forward unless `force: true` (and `force` is owner-only).
- **F7.5** Pull surfaces conflicts (`isomorphic-git` returns merge conflict info) as a `409` with a list of conflicted paths; UI offers Monaco 3-way resolution OR "abort merge" (`git.merge --abort` equivalent via reset).

### F8. Realtime
- **F8.1** One channel per v2 project: `build-v2-{projectId}`. One event: `git_event` with payload `{ kind: 'workdir' | 'commit' | 'push' | 'pull' | 'branch' | 'merge', ref, paths, sha? }`.
- **F8.2** The frontend uses a single React Query invalidation map keyed by `kind`.

### F9. Settings & telemetry
- **F9.1** Project Settings page exposes the toggle, current branch, configured remotes, and last sync time.
- **F9.2** Server emits a structured event per git operation (`git.op` with op name, duration, repo size).
- **F9.3** Frontend emits a single mode load event (`build.mode=v1|v2`) on Build tab mount.

---

## 4. Non-functional requirements

- **N1. Isolation.** v2 has its own DB tables, blob namespace, routes (`/api/v1/projects/{id}/git/*`), WS channel, frontend feature folder (`app/frontend/src/features/buildV2/`), and tests. No shared mutable state with v1.
- **N2. Performance.**
  - Status for a 500-file repo < 400 ms p95.
  - Commit of 20 files < 700 ms p95.
  - Push to GitHub matches v1 baseline ±15%.
  - Diff vs HEAD for a 5 k-line file < 250 ms p95.
- **N3. Concurrency.** `p-queue` per project serializes git operations; queue depth instrumented and bounded (reject with `429` past N=50).
- **N4. Atomicity.** Each git operation either fully succeeds (refs + objects written, then DB metadata row inserted) or fully rolls back. Objects are content-addressed so partial writes are inert garbage; a sweeper job removes unreferenced objects weekly.
- **N5. Security.**
  - All endpoints behind existing project authorization middleware.
  - GitHub token never returned to client.
  - File-path sanitation (reject `..`, absolute paths, NUL bytes).
  - Repo-size and per-file caps server-enforced.
  - Audit log for push / force / reset-hard / revert / merge.
- **N6. Observability.** OpenTelemetry spans wrap every `GitService` method; App Insights dashboard "Build v2".
- **N7. Cost.** Blob storage cost dominated by loose objects; pack rollup job keeps it bounded.
- **N8. Backward compat.** v2 off = system behaves bit-identically to today. Verified by running existing test suite with `ENABLE_BUILD_V2=false`.

---

## 5. Architecture

### 5.1 Backend layout (all new under `app/backend/src/buildV2/`)

```
buildV2/
  blobFs.ts            # Azure Blob FS adapter for isomorphic-git
  gitService.ts        # Thin wrapper over isomorphic-git; project-scoped
  gitQueue.ts          # p-queue per projectId, with metrics + bounding
  routes/
    git.ts             # Express router mounted at /api/v1/projects/:id/git
    settings.ts        # GET/POST /api/v1/projects/:id/build-v2/settings
  middleware/
    requireBuildV2.ts  # 404 if global gate off or project flag off
  channels.ts          # build-v2-{projectId} channel name builder + payloads
  events.ts            # Type-safe git_event payloads
  index.ts             # Public surface; nothing else in app imports buildV2/* internals
```

### 5.2 Storage

- Blob container: existing `generated-apps-files` (no new container needed).
- Prefix: `build-v2/{projectId}/.git/...` — **no overlap** with v1's `{repoId}/staged/*` or `{repoId}/committed/*`.
- v2 is keyed by `projectId` (not `repoId`); a v2 project has one repo. Mirrors are git remotes, not separate prefixes.
- `.git/objects/`, `.git/refs/`, `.git/HEAD`, `.git/config` all stored as blobs. Working tree is virtual (never persisted).
- Periodic packfile rollup job (Phase 4) packs loose objects into `.git/objects/pack/*.pack`.

### 5.3 Database

Single new migration (separate from v1 file tables):

```sql
-- infra/migrations/008_build_v2.sql
ALTER TABLE projects
    ADD COLUMN build_v2_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE build_v2_repos (
    project_id        UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    default_branch    TEXT NOT NULL DEFAULT 'main',
    initialized_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_op_at        TIMESTAMPTZ,
    repo_size_bytes   BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE build_v2_remotes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    UUID NOT NULL REFERENCES build_v2_repos(project_id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    url           TEXT NOT NULL,
    is_primary    BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, name)
);

CREATE TABLE build_v2_audit (
    id            BIGSERIAL PRIMARY KEY,
    project_id    UUID NOT NULL,
    user_id       UUID,
    op            TEXT NOT NULL,        -- 'push' | 'force-push' | 'reset-hard' | 'revert' | 'merge' | 'config'
    payload       JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_build_v2_audit_project ON build_v2_audit(project_id, created_at DESC);
```

That's the entire schema for v2. Everything else (commits, files, staging) lives inside the git repo itself.

### 5.4 API surface

All routes under `/api/v1/projects/{projectId}/git/*`, protected by `requireBuildV2`:

```
GET    /tree?ref=HEAD                              list tree
GET    /blob?path=&ref=                            read content (or WORKDIR)
PUT    /blob                                       write working-tree file
DELETE /blob?path=                                 delete working-tree file
POST   /move      { from, to }                     rename

GET    /status                                     statusMatrix rows
GET    /diff?path=&base=&head=                     unified diff + hunks
POST   /checkout  { ref, paths? }                  discard / restore / switch branch

POST   /commit    { message, paths?, author? }
GET    /log?ref=&path=&limit=&cursor=
GET    /commits/{sha}
POST   /revert    { sha }
POST   /reset     { ref, mode, confirm? }

GET    /branches
POST   /branches  { name, from? }
DELETE /branches/{name}
POST   /merge     { from, into?, strategy? }

GET    /remotes
POST   /remotes   { name, url, primary? }
DELETE /remotes/{name}
POST   /fetch     { remote? }
POST   /pull      { remote?, branch? }
POST   /push      { remote?, branch?, force? }
POST   /push-all  { branch? }
```

Settings:

```
GET    /api/v1/projects/{id}/build-v2/settings
POST   /api/v1/projects/{id}/build-v2/settings    { enabled: bool }
```

### 5.5 WebSocket

- Channel: `build-v2-{projectId}`
- Event: `git_event`
- Payload: `{ kind: 'workdir'|'commit'|'push'|'pull'|'branch'|'merge', ref: string, paths: string[], sha?: string, by?: { userId, name } }`
- One channel, one event — frontend uses a single invalidation map.

### 5.6 Frontend layout (all new under `app/frontend/src/features/buildV2/`)

```
features/buildV2/
  hooks/
    useBuildV2Enabled.ts    # reads project flag + env gate
    useGitStatus.ts         # query against /status; invalidated by git_event
    useGitLog.ts
    useGitDiff.ts
    useGitActions.ts        # mutations: commit/push/pull/reset/revert/checkout/branch
    useGitContent.ts        # GET /blob, used by Monaco model registry
  components/
    BuildV2Page.tsx         # the v2 Build page (layout host)
    FileTreeV2.tsx          # status badges from /status
    SourceControlPanel.tsx  # commit message + paths + commit/sync
    HistoryPanel.tsx        # log + click-to-diff + revert/reset
    DiffView.tsx            # Monaco DiffEditor
    BranchSwitcher.tsx
    RemoteManager.tsx       # connect/disconnect GitHub repo, manage mirrors
    ConflictResolver.tsx    # 3-way merge UI (Phase 4)
  api/
    gitClient.ts            # typed REST client
  index.tsx                 # exported BuildV2Page
```

### 5.7 Toggle integration (minimal v1 touch)

Build tab routing change — the only v1 code that must be modified:

```tsx
// app/frontend/src/pages/project/Build.tsx (existing)
const { enabled } = useBuildV2Enabled(projectId);
if (enabled) return <BuildV2Page projectId={projectId} />;
// ...existing v1 implementation unchanged
```

Project Settings page adds one new row (component lives in `features/buildV2/`):

```tsx
// existing settings page
<BuildV2ToggleRow projectId={projectId} />
```

These are the only v1 changes. Everything else lives under `features/buildV2/` and `app/backend/src/buildV2/`.

---

## 6. Toggle UX

- **Off (default).** Project Settings shows a row "Build v2 (preview) — Off" with a "Learn more" link and an "Enable" button (owner only). Hidden entirely if env gate is off.
- **Enabling.** Confirm dialog: "Build v2 uses a new file management system. Your existing files stay in v1 and are not copied over. AI assistants continue to use v1. You can switch back any time." Owner confirms → flag flips → next Build tab open is v2.
- **On.** Build tab shows v2. A small banner inside v2: "Build v2 (preview) — [Switch back]". The "Switch back" button flips the flag (with a confirm) and reloads.
- **Re-enabling.** v2 state (repo, remotes, history) is preserved; user comes back to exactly where they left off.

---

## 7. Coexistence rules

| Concern | Behavior |
|---|---|
| Same project, v1 staged data | Untouched, still readable through v1 routes. |
| AI sessions opened on a v2-enabled project | Still write through v1 `repo_staging`. Banner in agent UI: "Agent edits use v1 storage and are not visible in Build v2 yet." |
| Deploy / generated-app pipelines | Continue reading from v1's `repo_files` blobs; v2 is not yet plumbed to deploy. (Future work.) |
| GitHub repo | Both v1 and v2 can push to the same GitHub repo; they don't share local state but they can both produce real commits there. Owners can choose to deprecate v1 pushes on a v2-enabled project (manual). |
| Webhooks (if any) | Not affected. |
| Auth & RBAC | Reused entirely. |

This isolation is enforced in code by §5.1 layout — v2 never imports from `app/backend/src/staging/*`, `app/backend/src/routes/v1/staging*`, etc., and v1 never imports from `buildV2/*`. A CI lint rule (`eslint-plugin-import` `no-restricted-paths`) enforces the boundary.

---

## 8. Allowed minor v1 refactors

These are the only v1 touches sanctioned by this plan, each small and additive:

1. **Extract GitHub token resolver.** Pull the chain `repo_pats → user OAuth → GITHUB_TOKEN` out of `app/backend/src/utils/githubAuth.ts` into a pure function `resolveGitHubToken({ projectId, repoUrl, userId, db })` returning `{ token, source } | null`. Existing v1 callers re-routed through it (no behavior change). v2 imports it.
2. **Project authorization middleware export.** If `authorizeProjectAccess` isn't already an Express-friendly middleware, wrap it once and export so v2 routes can mount it directly.
3. **Add `build_v2_enabled` to projects.** New column-with-default via migration 008. v1 ignores it.
4. **`Build.tsx` toggle.** The 2-line branch at the top to render `<BuildV2Page>` when enabled.
5. **Project Settings page.** One new row (`<BuildV2ToggleRow>`); no layout reflow.
6. **WS dispatcher registration.** Register the new channel pattern `build-v2-*` in the WS authz allowlist.

No other v1 file is modified.

---

## 9. Phased delivery

### Phase 0 — Spike (gated)
- Stand up `BlobFs` + `GitService` locally against Azurite.
- Prove: `init → write 50 files → commit → log → diff → push to a sandbox GitHub repo`.
- Latency numbers vs §4 N2 targets.
- Decide go/no-go.

### Phase 1 — Backend foundations
- `BlobFs`, `GitService`, `GitQueue` with unit tests.
- Migration 008 + the `resolveGitHubToken` refactor.
- `requireBuildV2` middleware + global env gate.
- Settings endpoints (toggle on/off, idempotent init).
- Health check + repo-size accounting.

### Phase 2 — Backend porcelain
- All routes in §5.4 with supertest contract tests.
- WS channel + `git_event` payloads.
- Audit log writes for push / force / reset-hard / revert / merge.
- Size cap enforcement.

### Phase 3 — Frontend MVP
- `BuildV2Page` shell + the v1 `Build.tsx` 2-line branch.
- `FileTreeV2`, Monaco editor wired to `useGitContent` + `PUT /blob`.
- `SourceControlPanel` (status list, commit message, commit, push).
- `HistoryPanel` (log + per-commit diff).
- `DiffView` (Monaco `DiffEditor`).
- `RemoteManager` (connect GitHub repo, list/add/remove remotes, clone-on-attach).
- `BuildV2ToggleRow` in Project Settings.

### Phase 4 — Polish & hardening
- `BranchSwitcher`.
- `ConflictResolver` (Monaco 3-way) on pull/merge conflicts.
- Packfile rollup job + orphan object sweeper.
- App Insights dashboard.
- Closed beta with env gate; staff-only.

### Phase 5 — Public preview
- Env gate on globally; per-project flag remains opt-in.
- Owner-visible "Preview" badge; feedback link.

### Phase 6 — GA decision point (out of scope of this plan)
- Evaluate: deprecate v1 path? Plumb v2 into deploy? AI agent on v2?

---

## 10. Relevant files

**New backend**
- `app/backend/src/buildV2/blobFs.ts`
- `app/backend/src/buildV2/gitService.ts`
- `app/backend/src/buildV2/gitQueue.ts`
- `app/backend/src/buildV2/routes/git.ts`
- `app/backend/src/buildV2/routes/settings.ts`
- `app/backend/src/buildV2/middleware/requireBuildV2.ts`
- `app/backend/src/buildV2/channels.ts`
- `app/backend/src/buildV2/events.ts`
- `app/backend/src/buildV2/index.ts`
- `app/backend/src/__tests__/buildV2/**`
- `infra/migrations/008_build_v2.sql`

**New frontend** (under `app/frontend/src/features/buildV2/` as listed in §5.6)

**Existing files touched** (the v1 refactors in §8)
- `app/backend/src/utils/githubAuth.ts` — extract `resolveGitHubToken`.
- `app/backend/src/app.ts` (or wherever routes mount) — mount `buildV2` router.
- `app/backend/src/websocket` — allowlist `build-v2-*` channel pattern.
- `app/frontend/src/pages/project/Build.tsx` — 2-line branch.
- Project Settings page — add `<BuildV2ToggleRow>` row.

---

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `isomorphic-git` perf on large repos | Pack rollup; per-project queue; perf budget gates in CI. |
| Blob round-trips dominate latency | In-process FS cache per project with LRU on object reads. |
| Two systems pushing to one GitHub repo cause divergence | Owner-facing docs; audit log on every push; non-fast-forward refused by default. |
| Users confused which Build they're in | Persistent banner in v2 with "Switch back"; settings page shows status. |
| AI agent users on v2 projects see no agent edits | Banner; FAQ; targeted at preview audience that accepts this gap. |
| Push token leaks via logs | Token never logged; structured logger redacts `Authorization` headers; lint rule. |
| Orphan blob accumulation | Weekly sweeper; metric on object count per repo. |
| Cross-team writes to same v2 project causing index conflicts | `p-queue` per project; backend operations atomic; broadcasts ensure stale UI is refreshed. |

---

## 12. Verification

1. **Unit (Jest).** `BlobFs` against Azurite; `GitService` for every op; `requireBuildV2` middleware; `resolveGitHubToken` parity tests.
2. **Contract (supertest).** Every porcelain route with fixture seed repos: empty repo, 100-file repo, branchy repo.
3. **WS contract.** Spy on `broadcast()`; assert `git_event` payload for each op.
4. **Frontend (Vitest + MSW).** Hooks for status / log / diff / actions; `SourceControlPanel` state matrix (clean / dirty / staged / conflict); `ToggleRow` owner-vs-member gating.
5. **E2E (Playwright over docker-compose).** Toggle on → init → connect remote → clone → edit → diff → commit → push → pull → branch → reset → toggle off → re-enable shows preserved state.
6. **Backwards compat.** Run the existing test suite with `ENABLE_BUILD_V2=false`; expect zero changes.
7. **Perf.** Bench script in `scripts/buildV2-perf/` against targets in N2.
8. **Lint + build.** `npm run lint && npm run build` in both apps; skill `21.test-all`; skill `20.build-and-lint`.

---

## 13. Decisions confirmed

- **Toggle scope:** per-project flag (owner opts in for the whole project).
- **v2 ↔ v1 data relationship:** fully isolated; v2 starts empty per project; no import.
- **AI agent:** stays on v1 for this release; banner in v2.
- **GitHub auth:** reuse v1's chain via extracted `resolveGitHubToken`.

---

## 14. Further considerations

1. **Connect-GitHub UX.** A: pick from a list (reusing v1's lister). B: paste-URL only. C: GitHub App install flow. *Recommended: A for parity with v1.*
2. **Working-tree persistence.** A: virtual working tree (recompute from index/HEAD on every read). B: persist working tree as a separate blob prefix for fast reads, invalidated on commit. *Recommended: A; revisit if perf budget misses.*
3. **Commit author identity.** A: derive from authenticated user (email + name). B: project-level "git identity" config. *Recommended: A with B as future config.*
4. **Mirror pushes.** A: `push-all` continues on first mirror failure with a per-remote status report. B: stop on first failure. *Recommended: A — matches v1's effective behavior and is more useful.*
5. **Documentation page.** A short marketing-copy block + a docs page under `docs/build-v2.md` (out of code; documentation only). Skip if not wanted.

---

## Appendix A — Library choices

- **`isomorphic-git`** — pure-JS git on the backend with a pluggable FS interface. Supports add / commit / checkout / reset / log / push / pull / branch / merge / diff and HTTPS transport to GitHub. Apache-2.0. No `git` binary needed (works in Azure Container Apps without bundling git).
- **Custom FS adapter** (`BlobFs`, ~150 LOC) for Azure Blob. Implements only the subset isomorphic-git needs: `readFile`, `writeFile`, `unlink`, `readdir`, `mkdir`, `stat`. Caches loose-object reads. Optional: periodically pack the repo to reduce blob count.
- **`diff` (jsdiff)** for any non-Monaco diff rendering (e.g., the source-control summary).
- **`@monaco-editor/react`** already installed (`app/frontend/package.json`) — use `DiffEditor` for inline review.
- **`@octokit/rest`** only for GitHub-specific things isomorphic-git doesn't do (PR creation, repo discovery, branch-protection checks, user info). Not used for fetch/push.
- **`p-queue`** to serialize git operations per project (the git index isn't concurrency-safe).
- **`react-diff-view`** *optional*, only if a GitHub-style unified/split hunk view is wanted alongside Monaco.

## Appendix B — What this collapses from v1

| Today (v1) | After (v2) |
|---|---|
| `repo_staging` table + staged blob prefix | git index (`.git/index`) |
| `repo_files` table + committed blob prefix | git tree at `HEAD` |
| `repo_commits` table (`pushed_at`, `github_sha`) | `refs/heads/*` and `refs/remotes/origin/*` |
| `stageFileChangeWithToken`, `batchStageFiles`, `commitStagedWithToken`, `sync-repo-push`, `sync-repo-pull`, `reset_repo_files`, `restoreToCommit` | `git.add`, `git.commit`, `git.push`, `git.pull`, `git.reset`, `git.checkout`, `git.revert` |
| Custom client-side merge of staged + committed metadata | `git.statusMatrix()` |
| Custom diff computation against committed baseline | `git.walk()` + `diff` lib, or pass blobs to Monaco `DiffEditor` |
| Two WS channels with bespoke payloads | one `git_event` channel with `{ kind, ref, paths }` |
| Three-tier blob prefixes (staged/committed/artifacts split) | one blob prefix per project storing `.git/objects/*` |
| Frontend prime/mirror push orchestration | `git remote add` once per mirror + a single `push-all` server endpoint that loops `git.push` per remote |

Crucially, in v2 **none of the v1 rows are removed**. The collapse only applies to net-new state created in v2 projects.
