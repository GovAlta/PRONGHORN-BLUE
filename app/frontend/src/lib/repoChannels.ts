/**
 * Canonical WebSocket broadcast channel name builders for repository events.
 *
 * Mirrors app/backend/src/utils/repoChannels.ts — keep in sync.
 *
 * @example
 * pronghornApi.channel(stagingChannel(repoId)).on('broadcast', ...)
 * pronghornApi.channel(repoFilesChannel(projectId)).on('broadcast', ...)
 */

/** Channel for staging changes scoped to a single repo. */
export const stagingChannel = (repoId: string): string => `repo-staging-${repoId}`;

/** Channel for committed-file changes scoped to a project (all repos). */
export const repoFilesChannel = (projectId: string): string => `repo-changes-${projectId}`;
