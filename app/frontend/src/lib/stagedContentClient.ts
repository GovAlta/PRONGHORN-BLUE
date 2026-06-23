/**
 * stagedContentClient — frontend gateway for fetching staged file content.
 *
 * All frontend code that needs to read a staged file's bytes MUST go through
 * this module.  It wraps the `get_staged_file_content_with_token` RPC so
 * there is a single place to update if the contract changes.
 *
 * @example
 * const staged = await fetchStagedFileContent('repo-1', 'src/app.ts', shareToken);
 * if (staged) {
 *   editor.setValue(staged.content);
 * }
 */

import { pronghornApi } from "@/integrations/pronghorn-api/client";

// =============================================================================
// Types
// =============================================================================

/** Staged file content returned from the blob-backed RPC. */
export interface StagedFileContent {
  /** Current file bytes (UTF-8). Empty string when blob is missing. */
  content: string;
  /**
   * Committed baseline used as the diff "before" side.
   * Empty string for 'add'/'create' operations (file is new).
   */
  oldContent: string;
  /** The staging operation type (e.g. 'add', 'create', 'modify', 'edit', 'delete'). */
  operationType: string;
  /** True when the file contains binary content (null-byte detection). */
  isBinary: boolean;
}

// =============================================================================
// API
// =============================================================================

/**
 * Fetch staged file content from blob storage via the backend RPC.
 *
 * Returns null when:
 * - No staged row exists for the file.
 * - The RPC returns an error.
 *
 * @param repoId    - Repo UUID.
 * @param filePath  - Repository-relative file path.
 * @param shareToken - Optional project share token (null for authenticated requests).
 *
 * @example
 * const staged = await fetchStagedFileContent(
 *   'repo-abc',
 *   'src/components/Button.tsx',
 *   null,
 * );
 * if (staged) {
 *   console.log('op:', staged.operationType, 'bytes:', staged.content.length);
 * }
 */
export async function fetchStagedFileContent(
  repoId: string,
  filePath: string,
  shareToken: string | null,
): Promise<StagedFileContent | null> {
  if (!repoId || !filePath) return null;

  const { data, error } = await pronghornApi.rpc("get_staged_file_content_with_token", {
    p_repo_id: repoId,
    p_file_path: filePath,
    p_token: shareToken,
  });

  if (error || data === null || data === undefined) {
    return null;
  }

  return {
    content: (data as { content?: string | null }).content ?? "",
    oldContent: (data as { old_content?: string | null }).old_content ?? "",
    operationType: (data as { operation_type?: string | null }).operation_type ?? "modify",
    isBinary: (data as { is_binary?: boolean | null }).is_binary ?? false,
  };
}
