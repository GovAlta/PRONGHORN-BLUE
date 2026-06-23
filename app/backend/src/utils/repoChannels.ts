/**
 * Canonical WebSocket broadcast channel name builders for repository events.
 *
 * Using these helpers in every broadcast site ensures that producer and
 * subscriber channel names cannot drift out of sync.
 *
 * @example
 * broadcast(stagingChannel(repoId), 'staging_refresh', { repoId })
 * broadcast(repoFilesChannel(projectId), 'repo_files_refresh', { projectId, repoId })
 */

/** Channel for staging changes scoped to a single repo. */
export const stagingChannel = (repoId: string): string => `repo-staging-${repoId}`;

/** Channel for committed-file changes scoped to a project (all repos). */
export const repoFilesChannel = (projectId: string): string => `repo-changes-${projectId}`;
