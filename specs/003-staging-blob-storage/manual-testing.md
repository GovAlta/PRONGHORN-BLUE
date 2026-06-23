# Manual Testing Guide: Staging Storage Optimization

**Feature**: `003-staging-blob-storage`  
**Audience**: Single user validating the feature through the UI  
**Scope**: Phase 1 staging optimization workflows, with checkpoints for deferred blob migration behavior

## Purpose

Use this guide to verify that a single user can edit, stage, review, commit, and push code changes without visible regressions after the staging storage optimization.

The main user-visible promise is unchanged: edits are preserved while working, staged changes appear in the Staging Panel, diffs are accurate, commits are atomic from the user's perspective, and pushes still work. The implementation should also reduce unnecessary staging reads and writes, but those checks are listed as optional browser DevTools observations because they are not visible in the UI.

## Current Implementation Readiness

Based on [tasks.md](tasks.md), the currently completed implementation covers:

| Area                               | Status               | Manual Testing Coverage                                                                         |
| ---------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------- |
| Save/stage optimization            | Implemented          | Test cases MT-01 through MT-05                                                                  |
| AI batch staging                   | Implemented          | Test case MT-09                                                                                 |
| Diff baseline from committed files | Planned              | Test cases MT-06 through MT-08, expected to fail or show old behavior until Phase 5 is complete |
| Commit/push regression             | Planned verification | Test cases MT-10 through MT-12                                                                  |
| Observability and load testing     | Planned              | Optional checks only; not fully testable through the UI                                         |
| Blob storage migration             | Deferred             | Not included as pass/fail for Phase 1                                                           |

## Prerequisites

- Local API, frontend, and PostgreSQL are running with migrations through `004_*` applied.
- You can sign in or open a project with a valid share token.
- The project has a configured repository visible from the Build/code editing UI.
- The repository contains at least two committed text files that can be safely edited.
- Browser DevTools are available if you want to run optional network checks.
- Auto-commit is disabled unless a test explicitly asks you to enable it.

## Test Data

Use a disposable project or branch. Prepare these files in the repository:

| File                     | Starting Content                     | Used By                                      |
| ------------------------ | ------------------------------------ | -------------------------------------------- |
| `src/manual-modify-a.ts` | `export const manualA = "original";` | Edit, save, diff, commit                     |
| `src/manual-modify-b.ts` | `export const manualB = "original";` | Rapid switching and multi-file commit        |
| `src/manual-delete.ts`   | Any short text content               | Delete flow, if the UI exposes file delete   |
| `src/manual-new.ts`      | Does not exist before test           | New file flow, if the UI exposes file create |

If the UI does not expose file creation or deletion, mark the affected tests as `Blocked by UI capability` rather than failed.

## Result Legend

| Result              | Meaning                                                                             |
| ------------------- | ----------------------------------------------------------------------------------- |
| Pass                | The expected UI behavior occurred without errors                                    |
| Fail                | The UI showed incorrect behavior, data loss, wrong diff, or an error toast          |
| Blocked             | The current environment or UI does not expose the required action                   |
| Not Yet Implemented | The scenario maps to planned tasks that are still unchecked in [tasks.md](tasks.md) |

## MT-01: Preserve Unsaved Edits While Switching Files

**Covers**: US1, FR-001, FR-007, SC-007

1. Open the Build/code editing UI for the test project.
2. Open `src/manual-modify-a.ts`.
3. Change the text to `export const manualA = "unsaved buffer edit";`.
4. Do not click Save.
5. Open `src/manual-modify-b.ts`.
6. Change the text to `export const manualB = "second unsaved buffer edit";`.
7. Switch back to `src/manual-modify-a.ts`.
8. Switch back to `src/manual-modify-b.ts`.

**Expected Result**

- Both files retain the unsaved edits after switching away and back.
- The editor shows the unsaved-change indicator for changed files.
- No error toast appears.
- The Staging Panel does not list either file until Save is clicked.

**Optional DevTools Check**

- While switching between unsaved files, the Network panel should not show staging RPC calls caused only by switching files.

## MT-02: Save a Modified File to Staging

**Covers**: US1, FR-002, FR-003, SC-001

1. Open `src/manual-modify-a.ts`.
2. Change the content to `export const manualA = "saved staged edit";`.
3. Click `Save`.
4. Open or refresh the Staging Panel.
5. Expand the staged files section if it is collapsed.

**Expected Result**

- A success indication appears or the editor clears the unsaved-change indicator.
- The Staging Panel shows `src/manual-modify-a.ts` as a staged changed file.
- The staged file has an edit/modify-style operation badge.
- The file remains staged after refreshing the browser page and reopening the project.

**Optional DevTools Check**

- Saving should make one `stage_file_change_with_token` request for the file.
- Saving should not first call `get_staged_changes_with_token` just to preserve `old_content`.
- Saving should not call `unstage_file_with_token` before the stage request for the same file.

## MT-03: Re-save the Same File Without Duplicate Staged Rows

**Covers**: US1, FR-002, SC-001, CR-003

1. With `src/manual-modify-a.ts` already staged, change it again to `export const manualA = "saved staged edit v2";`.
2. Click `Save`.
3. Open the Staging Panel.

**Expected Result**

- The Staging Panel still shows only one row for `src/manual-modify-a.ts`.
- The row reflects the latest saved content when opened in diff view.
- No duplicate staged rows appear after refresh.

## MT-04: Stage Multiple Files and Keep All Changes

**Covers**: US1, SC-007

1. Edit `src/manual-modify-a.ts` and save it.
2. Edit `src/manual-modify-b.ts` and save it.
3. Switch between both files several times.
4. Refresh the browser.
5. Reopen the project and the Staging Panel.

**Expected Result**

- Both files are still listed as staged changes.
- Reopening each file shows the saved staged content, not the original content.
- No staged file is lost after browser refresh.

## MT-05: Revert a Staged File to Its Original Content

**Covers**: US1, FR-007

1. Open `src/manual-modify-b.ts` after it has been staged.
2. Change the content back to its original committed text.
3. Click `Save`.
4. Check the Staging Panel.

**Expected Result**

- If smart-unstage is active for this path, `src/manual-modify-b.ts` disappears from the staged files list.
- If smart-unstage is not exposed in the current UI path, the file remains staged but the diff should show no meaningful changes. Record this as a product behavior note, not data loss.
- No error toast appears.

## MT-06: View Diff for a Modified File

**Covers**: US3, FR-004, CR-001, CR-002, SC-004

**Implementation Note**: Phase 5 tasks for committed-baseline fetching are not complete in [tasks.md](tasks.md). Run this test now to document current behavior; mark `Not Yet Implemented` if it still depends on staged `old_content`.

1. Stage `src/manual-modify-a.ts` with content that differs from the committed version.
2. Open the Staging Panel.
3. Expand the staged files section.
4. Click `Diff` for `src/manual-modify-a.ts`.

**Expected Result**

- The diff view opens inside the Staging Panel.
- The original committed content appears as the removal/old side.
- The staged content appears as the addition/new side.
- The diff loads within about 1 second for normal text files.
- `Back to Staging` returns to the staged files list.

**Optional DevTools Check After Phase 5**

- Clicking `Diff` for a modified file should call `get_file_content_by_path_with_token` for that specific path.
- Merely opening the Staging Panel should not fetch committed content for every staged file.

## MT-07: View Diff for a Newly Created File

**Covers**: US3, FR-005, CR-002

1. Create `src/manual-new.ts` through the UI, if supported.
2. Add `export const manualNew = "created in manual test";`.
3. Click `Save`.
4. Open the Staging Panel.
5. Click `Diff` for `src/manual-new.ts`.

**Expected Result**

- The file is listed as an add/new-file operation.
- The diff shows the full file as additions against an empty baseline.
- No old committed content is displayed.

**Optional DevTools Check After Phase 5**

- New-file diff should not need a committed-baseline RPC call, because the baseline is empty.

## MT-08: View Diff for a Deleted File

**Covers**: US3, FR-004, CR-002

1. Delete `src/manual-delete.ts` through the UI, if supported.
2. Open the Staging Panel.
3. Click `View` for `src/manual-delete.ts`.

**Expected Result**

- The file is listed as a delete operation.
- The diff/view shows the committed file content as removed content.
- The staged new content is empty.

**Optional DevTools Check After Phase 5**

- Deleted-file diff should fetch committed content with `get_file_content_by_path_with_token`.

## MT-09: Stage AI-Generated Multi-File Changes

**Covers**: US2, FR-006, SC-003, CR-003

1. Start an AI task from the UI that edits or creates multiple files in the repository.
2. Choose or prompt for a small, safe task such as updating comments or adding simple exports across 3 to 5 files.
3. Wait for the task to complete.
4. Open the Staging Panel.

**Expected Result**

- All files changed by the AI task appear in the Staging Panel.
- Each staged file has the expected operation type.
- The UI refreshes once the AI task completes, without requiring a full page reload.
- If batch staging fails, the UI should still show the staged changes through the fallback path or display a clear error without partial silent loss.

**Optional DevTools Check**

- The network or server logs should show one batch staging operation for the task where available, not one user-visible refresh per file.

## MT-10: Unstage and Discard Staged Changes

**Covers**: CR-001, CR-003

1. Stage at least two files.
2. In the Staging Panel, click the `X` action on one staged file.
3. Confirm the file disappears from the staged files list.
4. Stage another file if needed.
5. Click `Discard All`.

**Expected Result**

- The individually unstaged file disappears and remains unstaged after refresh.
- `Discard All` clears the staged files list.
- The Staging Panel shows `No staged changes` after all changes are cleared.
- No committed files are changed by unstaging or discarding.

## MT-11: Commit Staged Files

**Covers**: US4, CR-004, SC-006, SC-007

1. Stage at least two files.
2. In the Staging Panel, enter a commit message such as `Manual staging optimization verification`.
3. Click `Commit Changes`.
4. Wait for the commit to finish.

**Expected Result**

- A success toast appears with the number of committed changes.
- The staged files list clears.
- The panel shows pending commit information if the repository has not been pushed yet.
- Reopening the edited files shows the committed content as the current baseline.
- No partial commit is visible; either all staged files commit or the staged list remains intact after an error.

## MT-12: Push Pending Commit to Repository

**Covers**: US4, CR-005

1. Complete MT-11 and leave the commit unpushed.
2. In the Staging Panel, confirm the pending commit appears.
3. Click `Push to Repository`.
4. Wait for the push to finish.
5. Verify the remote repository or configured GitHub target contains the committed file changes.

**Expected Result**

- A success toast appears after the push.
- Pending commits clear or update to show that the repository is current.
- The remote repository contains the same content that was committed from the UI.
- If the push fails, the error message is clear and the local commit remains available to retry.

## MT-13: Auto-Commit and Push Smoke Test

**Covers**: CR-001, CR-005

1. Enable `Auto-commit and push changes` in the Staging Panel.
2. Edit one safe test file.
3. Click `Save`.
4. Watch the Staging Panel and repository state.
5. Disable `Auto-commit and push changes` after the test.

**Expected Result**

- The UI does not break or lose the saved edit.
- If auto-commit/push is wired for the current project, the change commits and pushes without manual commit steps.
- If auto-commit/push is not available in the current environment, record the visible behavior and verify the file remains staged for manual commit.

## MT-14: Browser Refresh and Session Recovery

**Covers**: SC-007, CR-006

1. Stage one modified file.
2. Refresh the browser.
3. Reopen the project.
4. Open the Staging Panel and the staged file.

**Expected Result**

- Saved staged content is preserved after refresh.
- The staged file remains listed.
- The diff still opens without an error.
- Unsaved edits that were never staged may be lost after refresh; this is an expected known gap from the spec, not a failure.

## MT-15: Phase 2 Blob Migration Placeholder

**Covers**: US5, FR-008 through FR-013, OR-004, OR-005

**Status**: Deferred. Do not use this as a Phase 1 pass/fail gate.

When Phase 2 is implemented, add manual checks for:

- Saving a staged file stores file content in blob-backed staging storage.
- The Staging Panel still lists files using metadata.
- Diff view fetches staged content and committed baseline successfully.
- Commit reads staged blob content and writes committed content to `repo_files`.
- A simulated blob read failure preserves staging and shows a clear error.
- Successful commit cleanup removes orphaned staging blobs or records cleanup results.

## Optional Network Verification Checklist

Use Browser DevTools only if you need evidence that the optimization is active.

| User Action                         | Expected Request Pattern                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| Switch between unsaved edited files | No staging RPC caused by switching alone                                         |
| Save a modified file                | One `stage_file_change_with_token` call                                          |
| Re-save the same file               | One `stage_file_change_with_token` call; no duplicate staged row                 |
| Open Staging Panel                  | Staged list loads; after Phase 5, should prefer metadata/list calls for the list |
| Click modified-file diff            | After Phase 5, one `get_file_content_by_path_with_token` call for that path      |
| Click new-file diff                 | No committed-baseline fetch required                                             |
| Commit staged files                 | One commit RPC; staged list clears after success                                 |

## Manual Test Report Template

```text
Tester:
Date:
Environment:
Frontend URL:
API URL:
Project:
Repository/branch:
Build or commit under test:

| Test ID | Result | Notes / Evidence |
| ------- | ------ | ---------------- |
| MT-01   |        |                  |
| MT-02   |        |                  |
| MT-03   |        |                  |
| MT-04   |        |                  |
| MT-05   |        |                  |
| MT-06   |        |                  |
| MT-07   |        |                  |
| MT-08   |        |                  |
| MT-09   |        |                  |
| MT-10   |        |                  |
| MT-11   |        |                  |
| MT-12   |        |                  |
| MT-13   |        |                  |
| MT-14   |        |                  |
| MT-15   |        |                  |
```

## Pass Criteria

For Phase 1 UI acceptance, MT-01 through MT-05 and MT-10 through MT-14 should pass or have a clear environment-specific block. MT-06 through MT-08 become required pass criteria after Phase 5 is implemented. MT-15 is deferred until the blob storage migration phase starts.
