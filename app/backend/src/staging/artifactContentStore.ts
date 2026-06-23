/**
 * ArtifactContentStore — single gateway for all artifact content reads and writes.
 *
 * Blob storage (Azure) is the canonical source of truth for artifact document
 * content.  The `artifacts` table holds metadata only; the `content` column
 * will be dropped once all callers migrate through this module.
 *
 * All backend code that reads or writes artifact content MUST go through this
 * module.  Callers never interact with `getRepoBlobStore()` artifact methods
 * directly.
 *
 * @example
 * // Write artifact content
 * const { contentLength } = await putArtifactContent('proj-1', 'art-1', 'document text');
 *
 * @example
 * // Read artifact content
 * const content = await getArtifactContent('proj-1', 'art-1');
 */

import { getRepoBlobStore } from "../utils/repoBlobStore";

// =============================================================================
// Public API
// =============================================================================

/**
 * Read artifact content from blob storage.
 *
 * @param projectId  - Project UUID (blob container name).
 * @param artifactId - Artifact UUID (blob name under `artifacts/` prefix).
 * @returns Content string, or null if the blob does not exist.
 *
 * @example
 * const content = await getArtifactContent('proj-1', 'art-1');
 * if (content === null) throw new Error('No artifact content');
 */
export async function getArtifactContent(
  projectId: string,
  artifactId: string,
): Promise<string | null> {
  return getRepoBlobStore().readArtifact(projectId, artifactId);
}

/**
 * Write artifact content to blob storage.
 *
 * Blob write is intentionally the only storage operation — the DB row is
 * updated separately by the caller with `content_length` metadata.
 *
 * @param projectId  - Project UUID (blob container name).
 * @param artifactId - Artifact UUID (blob name under `artifacts/` prefix).
 * @param content    - UTF-8 document content.
 * @returns `{ contentLength }` byte length for DB metadata updates.
 *
 * @example
 * const { contentLength } = await putArtifactContent('proj-1', 'art-1', 'doc');
 */
export async function putArtifactContent(
  projectId: string,
  artifactId: string,
  content: string,
): Promise<{ contentLength: number }> {
  await getRepoBlobStore().writeArtifact(projectId, artifactId, content);
  return { contentLength: Buffer.byteLength(content, "utf8") };
}

/**
 * Delete artifact content from blob storage (best-effort).
 *
 * @param projectId  - Project UUID (blob container name).
 * @param artifactId - Artifact UUID.
 *
 * @example
 * await deleteArtifactContent('proj-1', 'art-1');
 */
export async function deleteArtifactContent(
  projectId: string,
  artifactId: string,
): Promise<void> {
  try {
    await getRepoBlobStore().deleteArtifact(projectId, artifactId);
  } catch {
    // Best-effort: orphaned blobs are tolerable
  }
}

/**
 * Clone artifact content from one project/artifact to another.
 *
 * @param sourceProjectId  - Source project UUID.
 * @param sourceArtifactId - Source artifact UUID.
 * @param targetProjectId  - Target project UUID.
 * @param targetArtifactId - Target artifact UUID.
 * @returns `{ contentLength }` or null if source blob was missing.
 *
 * @example
 * await cloneArtifactContent('proj-1', 'art-1', 'proj-2', 'art-2');
 */
export async function cloneArtifactContent(
  sourceProjectId: string,
  sourceArtifactId: string,
  targetProjectId: string,
  targetArtifactId: string,
): Promise<{ contentLength: number } | null> {
  const content = await getRepoBlobStore().readArtifact(sourceProjectId, sourceArtifactId);
  if (content === null) {
    return null;
  }
  await getRepoBlobStore().writeArtifact(targetProjectId, targetArtifactId, content);
  return { contentLength: Buffer.byteLength(content, "utf8") };
}
