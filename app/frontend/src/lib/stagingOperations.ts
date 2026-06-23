import { pronghornApi } from "@/integrations/pronghorn-api/client";

interface StageFileParams {
  repoId: string;
  shareToken: string | null;
  filePath: string;
  operationType: string;
  oldContent?: string | null;
  newContent?: string | null;
  oldPath?: string | null;
  isBinary?: boolean;
}

interface UnstageFileParams {
  repoId: string;
  shareToken: string | null;
  filePath: string;
}

interface UnstageMultipleParams {
  repoId: string;
  shareToken: string | null;
  filePaths: string[];
}

interface DiscardAllParams {
  repoId: string;
  shareToken: string | null;
}

interface CommitParams {
  repoId: string;
  shareToken: string | null;
  commitMessage: string;
  branch?: string;
  filePaths?: string[];
}

/**
 * Stage a file change via the staging-operations edge function.
 * This ensures server-side broadcasts are emitted for real-time updates.
 */
export async function stageFile(params: StageFileParams): Promise<void> {
  const { data, error } = await pronghornApi.functions.invoke("staging-operations", {
    body: {
      action: "stage",
      repoId: params.repoId,
      shareToken: params.shareToken,
      filePath: params.filePath,
      operationType: params.operationType,
      newContent: params.newContent ?? null,
      oldPath: params.oldPath ?? null,
    },
  });

  if (error) throw error;
  if (data && !data.success) throw new Error(data.error || "Stage operation failed");
}

/**
 * Unstage a single file via the staging-operations edge function.
 */
export async function unstageFile(params: UnstageFileParams): Promise<void> {
  const { data, error } = await pronghornApi.functions.invoke("staging-operations", {
    body: {
      action: "unstage",
      repoId: params.repoId,
      shareToken: params.shareToken,
      filePath: params.filePath,
    },
  });

  if (error) throw error;
  if (data && !data.success) throw new Error(data.error || "Unstage operation failed");
}

/**
 * Unstage multiple files via the staging-operations edge function.
 */
export async function unstageMultiple(params: UnstageMultipleParams): Promise<void> {
  const { data, error } = await pronghornApi.functions.invoke("staging-operations", {
    body: {
      action: "unstage_selected",
      repoId: params.repoId,
      shareToken: params.shareToken,
      filePaths: params.filePaths,
    },
  });

  if (error) throw error;
  if (data && !data.success) throw new Error(data.error || "Unstage operation failed");
}

/**
 * Discard all staged changes via the staging-operations edge function.
 */
export async function discardAllStaged(params: DiscardAllParams): Promise<void> {
  const { data, error } = await pronghornApi.functions.invoke("staging-operations", {
    body: {
      action: "discard_all",
      repoId: params.repoId,
      shareToken: params.shareToken,
    },
  });

  if (error) throw error;
  if (data && !data.success) throw new Error(data.error || "Discard operation failed");
}

/**
 * Commit staged changes via the staging-operations edge function.
 */
export async function commitStaged(params: CommitParams): Promise<any> {
  const { data, error } = await pronghornApi.functions.invoke("staging-operations", {
    body: {
      action: "commit",
      repoId: params.repoId,
      shareToken: params.shareToken,
      commitMessage: params.commitMessage,
      branch: params.branch || "main",
      filePaths: params.filePaths,
    },
  });

  if (error) throw error;
  if (data && !data.success) throw new Error(data.error || "Commit operation failed");
  return data?.data;
}
