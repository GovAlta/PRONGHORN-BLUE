/**
 * StagedContentStore — single gateway for all staged content reads and writes.
 *
 * Blob storage (Azure) is the canonical source of truth for staged file bytes.
 * `repo_staging` holds metadata only; `new_content` is always NULL post-refactor.
 *
 * All backend code that reads or writes staged content MUST go through this
 * module.  Callers never interact with `getBlobStagingStore()` or
 * `repo_staging.new_content` directly.
 *
 * @example
 * // Write staged content
 * await putStagedFile('repo-1', 'src/app.ts', 'export default {};', {
 *   projectId: 'proj-1',
 *   operationType: 'modify',
 * });
 *
 * @example
 * // Read staged content for commit
 * const staged = await getStagedContent('repo-1', 'src/app.ts');
 * if (staged) {
 *   console.log(staged.content, staged.operationType);
 * }
 */

import db from "../utils/database";
import { getRepoBlobStore } from "../utils/repoBlobStore";
import type { StagingOpType } from "./stagingTypes";

// =============================================================================
// Types
// =============================================================================

/** Full staged file content, including bytes from blob storage. */
export interface StagedFileContent {
  /** UTF-8 string content read from blob storage. */
  content: string;
  /** True if the content buffer contains a null byte (binary file detection). */
  isBinary: boolean;
  /** Byte length of the content in UTF-8 encoding. */
  contentLength: number;
  /** The staging operation type. */
  operationType: StagingOpType;
  /** Previous path for rename operations; null for all other op types. */
  oldPath: string | null;
}

/** Lightweight staging row metadata — no content bytes. */
export interface StagedFileMetadata {
  id: string;
  repoId: string;
  projectId: string;
  filePath: string;
  operationType: StagingOpType;
  isBinary: boolean;
  contentLength: number | null;
  oldPath: string | null;
  /** Always null post-blob-refactor; kept for API shape compatibility. */
  oldContent: null;
  /** Always null post-blob-refactor; content lives in blob storage. */
  newContent: null;
  createdAt: Date;
}

/** Parameters for writing a staged file entry. */
export interface PutStagedFileOptions {
  /** project_id for the repo_staging row. */
  projectId: string;
  /** Staging operation type. */
  operationType: StagingOpType | string;
  /** Old file path for rename operations. */
  oldPath?: string | null;
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Compute binary flag and byte length from raw content.
 * Exported so callers such as batchStageFiles can reuse without importing blob store.
 *
 * @param content - UTF-8 string content, or null for delete operations.
 * @returns `{ isBinary, contentLength }` — both null/false for delete ops.
 *
 * @example
 * const { isBinary, contentLength } = computeContentMeta(fileContent);
 */
export function computeContentMeta(content: string | null | undefined): {
  isBinary: boolean;
  contentLength: number | null;
} {
  if (content === null || content === undefined) {
    return { isBinary: false, contentLength: null };
  }
  const buf = Buffer.from(content, "utf8");
  return { isBinary: buf.includes(0), contentLength: buf.length };
}

/** Map a raw DB row to `StagedFileMetadata`. */
function rowToMetadata(r: Record<string, unknown>): StagedFileMetadata {
  return {
    id: r.id as string,
    repoId: r.repo_id as string,
    projectId: r.project_id as string,
    filePath: r.file_path as string,
    operationType: r.operation_type as StagingOpType,
    isBinary: (r.is_binary as boolean) ?? false,
    contentLength: (r.content_length as number | null) ?? null,
    oldPath: (r.old_path as string | null) ?? null,
    oldContent: null,
    newContent: null,
    createdAt: r.created_at as Date,
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Read staged content for a single file from blob storage.
 *
 * Returns null when:
 * - No staged row exists for the given repo/path.
 * - The operation type is 'delete' (no content to read).
 * - The blob is missing (content was never written or was cleaned up).
 *
 * @param repoId  - Repo UUID.
 * @param filePath - Repository-relative file path.
 *
 * @example
 * const staged = await getStagedContent('repo-1', 'src/app.ts');
 * if (staged === null) throw new Error('No staged content');
 * writeToRepoFiles(staged.content);
 */
export async function getStagedContent(
  repoId: string,
  filePath: string,
): Promise<StagedFileContent | null> {
  const result = await db.query(
    "SELECT operation_type, is_binary, old_path, project_id FROM repo_staging WHERE repo_id = $1 AND file_path = $2",
    [repoId, filePath],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  if (row.operation_type === "delete") {
    return null;
  }

  const content = await getRepoBlobStore().readStaged(row.project_id, repoId, filePath);
  if (content === null) {
    return null;
  }

  return {
    content,
    isBinary: (row.is_binary as boolean) ?? false,
    contentLength: Buffer.byteLength(content),
    operationType: row.operation_type as StagingOpType,
    oldPath: (row.old_path as string | null) ?? null,
  };
}

/**
 * List staged file metadata for a repo without fetching content bytes.
 *
 * @param repoId - Repo UUID.
 *
 * @example
 * const files = await listStagedFiles('repo-1');
 * console.log(files.map(f => f.filePath));
 */
export async function listStagedFiles(repoId: string): Promise<StagedFileMetadata[]> {
  const result = await db.query(
    "SELECT * FROM repo_staging WHERE repo_id = $1 ORDER BY created_at",
    [repoId],
  );
  return result.rows.map(rowToMetadata);
}

/**
 * Write staged content: blob first, then metadata UPSERT.
 *
 * Blob write is intentionally ordered before the DB write so a crash between
 * the two leaves an orphaned blob rather than a DB row pointing to missing
 * content — the safer failure mode.
 *
 * @param repoId   - Repo UUID.
 * @param filePath - Repository-relative file path.
 * @param content  - UTF-8 file content. Pass null for delete operations.
 * @param options  - Metadata options including projectId and operationType.
 * @returns The upserted metadata row.
 *
 * @example
 * const meta = await putStagedFile('repo-1', 'src/app.ts', 'export default {};', {
 *   projectId: 'proj-1',
 *   operationType: 'modify',
 * });
 */
export async function putStagedFile(
  repoId: string,
  filePath: string,
  content: string | null,
  options: PutStagedFileOptions,
): Promise<StagedFileMetadata> {
  const opType = options.operationType;

  if (opType !== "delete" && content !== null && content !== undefined) {
    await getRepoBlobStore().writeStaged(options.projectId, repoId, filePath, content);
  }

  const { isBinary, contentLength } = computeContentMeta(opType !== "delete" ? content : null);

  const result = await db.query(
    `INSERT INTO repo_staging (repo_id, project_id, file_path, operation_type, old_path, is_binary, content_length, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (repo_id, file_path) DO UPDATE SET
       operation_type = CASE
         WHEN repo_staging.operation_type IN ('add', 'create') AND $4 IN ('modify', 'edit')
         THEN repo_staging.operation_type
         ELSE $4
       END,
       old_path = $5, is_binary = $6, content_length = $7, created_at = NOW()
     RETURNING *`,
    [
      repoId,
      options.projectId,
      filePath,
      opType,
      options.oldPath ?? null,
      isBinary,
      contentLength,
    ],
  );

  return rowToMetadata(result.rows[0]);
}

/**
 * Remove a staged file: deletes both the blob and the metadata row.
 * The blob deletion is best-effort — a missing blob does not cause an error.
 *
 * @param repoId   - Repo UUID.
 * @param filePath - Repository-relative file path.
 *
 * @example
 * await removeStagedFile('repo-1', 'src/old-file.ts');
 */
export async function removeStagedFile(repoId: string, filePath: string): Promise<void> {
  // Look up project_id before deleting the staging row (needed for blob container name)
  const repoLookup = await db.query(
    "SELECT project_id FROM project_repos WHERE id = $1",
    [repoId],
  );
  const projectId = repoLookup.rows[0]?.project_id;

  await db.query(
    "DELETE FROM repo_staging WHERE repo_id = $1 AND file_path = $2",
    [repoId, filePath],
  );
  if (projectId) {
    try {
      await getRepoBlobStore().deleteStaged(projectId, repoId, filePath);
    } catch {
      // Best-effort: blob may already be absent (already committed or never written).
    }
  }
}
