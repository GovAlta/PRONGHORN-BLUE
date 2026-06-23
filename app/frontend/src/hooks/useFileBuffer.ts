import { useState, useCallback, useRef } from "react";
import { pronghornApi } from "@/integrations/pronghorn-api/client";
import { toast } from "sonner";
import { stageFile, unstageFile } from "@/lib/stagingOperations";
import { fetchStagedFileContent } from "@/lib/stagedContentClient";

/**
 * Discriminated kind for a buffer entry — replaces the fragile `isStaged + operationType`
 * heuristic.  Op-type for the stage RPC is derived directly from `kind` so F3-class
 * bugs (wrong op type inferred from a truthy id) are structurally impossible.
 *
 * - `committed`     — file exists in repo_files; not staged
 * - `staged-add`    — new file that does not exist in repo_files yet
 * - `staged-modify` — existing file that has staged modifications
 */
export type FileKind = "committed" | "staged-add" | "staged-modify";

export interface BufferedFile {
  id: string;
  path: string;
  /** Discriminated file state. Prefer `kind` over `isStaged + operationType` checks. */
  kind: FileKind;
  /** @deprecated Use `kind` instead. Kept for backward compatibility. */
  isStaged?: boolean;
  /** @deprecated Use `kind` instead. Kept for backward compatibility. */
  operationType?: string;
  content: string;
  originalContent: string;    // Baseline from DB - NEVER changes after load (for diffs)
  lastSavedContent: string;   // What was last saved to staging (for dirty detection)
  isDirty: boolean;
  isSaving: boolean;
}

interface UseFileBufferOptions {
  repoId: string | undefined;
  shareToken: string | null;
  onFileSaved?: () => void;
}

export function useFileBuffer({ repoId, shareToken, onFileSaved }: UseFileBufferOptions) {
  const [buffer, setBuffer] = useState<Map<string, BufferedFile>>(new Map());
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const savePromisesRef = useRef<Map<string, Promise<void>>>(new Map());
  // Track the latest switchFile navigation so a stale async load doesn't override a newer one
  const navGenRef = useRef(0);

  // Get current file from buffer
  const currentFile = currentPath ? buffer.get(currentPath) || null : null;

  // Check if any files are dirty
  const hasDirtyFiles = Array.from(buffer.values()).some(f => f.isDirty);

  // Check if any files are currently saving
  const isSaving = Array.from(buffer.values()).some(f => f.isSaving);

  // Load file content from database
  const loadFileContent = useCallback(async (
    fileId: string,
    filePath: string,
    isStaged?: boolean
  ): Promise<{ content: string; originalContent: string; operationType?: string } | null> => {
    if (!repoId) return null;

    try {
      // First check for staged content — fetch via StagedContentStore client (single canonical read path)
      if (isStaged) {
        const staged = await fetchStagedFileContent(repoId, filePath, shareToken);

        if (staged !== null) {
          return {
            content: staged.content,
            originalContent: staged.oldContent,
            operationType: staged.operationType,
          };
        }

        // Staged content was null — file was likely just committed.
        // Fall through to committed fetch using path-based lookup since the
        // fileId may be a stale staging row ID that no longer exists.
      }

      // Load from committed files — use path-based lookup when we know the staged
      // row was removed (avoids querying with a stale staging ID).
      if (isStaged) {
        const { data: pathData, error: pathError } = await pronghornApi.rpc(
          "get_file_content_by_path_with_token",
          {
            p_repo_id: repoId,
            p_file_path: filePath,
            p_token: shareToken || null,
          }
        );

        if (!pathError && pathData) {
          return {
            content: pathData.content ?? "",
            originalContent: pathData.content ?? "",
          };
        }
      }

      // Load from committed files by ID
      const { data, error } = await pronghornApi.rpc("get_file_content_with_token", {
        p_file_id: fileId,
        p_token: shareToken || null,
      });

      if (error) throw error;

      if (data && data.length > 0) {
        return {
          content: data[0].content,
          originalContent: data[0].content,
        };
      }

      return { content: "", originalContent: "" };
    } catch (error) {
      console.error("Error loading file content:", error);
      toast.error(error instanceof Error ? error.message : "Failed to load file content");
      return null;
    }
  }, [repoId, shareToken]);

  // Save a single file (async, returns promise)
  const saveFileAsync = useCallback(async (filePath: string): Promise<void> => {
    const file = buffer.get(filePath);
    if (!file || !file.isDirty || file.isSaving || !repoId) return;

    // Mark as saving
    setBuffer(prev => {
      const newMap = new Map(prev);
      const f = newMap.get(filePath);
      if (f) {
        newMap.set(filePath, { ...f, isSaving: true });
      }
      return newMap;
    });

    try {
      // SMART UNSTAGE: revert to committed baseline → remove staged row.
      // Only applies to staged-modify (existing file reverted to committed content).
      // staged-add files have no committed baseline so they must never be auto-unstaged.
      if (file.kind === "staged-modify" && file.content === file.originalContent) {
        console.log("Content reverted to baseline, unstaging file:", filePath);
        await unstageFile({
          repoId,
          shareToken,
          filePath,
        });

        // Mark as clean and update lastSavedContent
        setBuffer(prev => {
          const newMap = new Map(prev);
          const f = newMap.get(filePath);
          if (f) {
            if (filePath === currentPath) {
              newMap.set(filePath, {
                ...f,
                kind: "committed",  // file no longer staged — reset to committed state
                isDirty: false,
                isSaving: false,
                isStaged: false,
                lastSavedContent: f.content,
              });
            } else {
              newMap.delete(filePath);
            }
          }
          return newMap;
        });

        onFileSaved?.();
        return;
      }

      // Derive op-type from the kind discriminant — no inference from id needed.
      const operationType =
        file.kind === "staged-add" ? "add"
        : file.kind === "staged-modify" ? (file.operationType ?? "modify")
        : "modify";

      // Stage via edge function to emit server-side broadcast
      await stageFile({
        repoId,
        shareToken,
        filePath,
        operationType,
        newContent: file.content,
      });

      // Update buffer: mark as clean, update lastSavedContent but PRESERVE originalContent.
      // Elevate kind to staged-modify when a committed file is first staged.
      setBuffer(prev => {
        const newMap = new Map(prev);
        const f = newMap.get(filePath);
        if (f) {
          if (filePath === currentPath) {
            newMap.set(filePath, {
              ...f,
              kind: f.kind === "committed" ? "staged-modify" : f.kind,
              isDirty: false,
              isSaving: false,
              lastSavedContent: f.content,  // Update last saved
              // originalContent stays unchanged - it's the baseline for diffs!
              isStaged: true,
            });
          } else {
            newMap.delete(filePath);
          }
        }
        return newMap;
      });

      onFileSaved?.();
    } catch (error) {
      console.error("Error saving file:", filePath, error);
      toast.error(`Failed to save ${filePath}`);

      // Reset saving state
      setBuffer(prev => {
        const newMap = new Map(prev);
        const f = newMap.get(filePath);
        if (f) {
          newMap.set(filePath, { ...f, isSaving: false });
        }
        return newMap;
      });
    }
  }, [buffer, repoId, shareToken, currentPath, onFileSaved]);

  // Switch to a new file - triggers async save for dirty current file
  const switchFile = useCallback(async (
    fileId: string,
    filePath: string,
    isStaged?: boolean,
    forceReload?: boolean
  ): Promise<void> => {
    if (!repoId) return;

    // Increment and capture the generation for this navigation
    const generation = ++navGenRef.current;

    // If current file is dirty, trigger async save (fire-and-forget)
    if (currentPath && buffer.get(currentPath)?.isDirty) {
      const pathToSave = currentPath;
      const savePromise = saveFileAsync(pathToSave);
      savePromisesRef.current.set(pathToSave, savePromise);
      savePromise.finally(() => {
        savePromisesRef.current.delete(pathToSave);
      });
    }

    // Check if file is already in buffer - skip cache if forceReload
    if (!forceReload) {
      const existingFile = buffer.get(filePath);
      if (existingFile) {
        setCurrentPath(filePath);
        return;
      }
    }

    // Load file content
    const loadedContent = await loadFileContent(fileId, filePath, isStaged);

    // Discard result if a newer navigation was triggered while this was in-flight
    if (generation !== navGenRef.current) return;

    // Derive kind from loaded context
    const kind: FileKind =
      !isStaged ? "committed"
      : (loadedContent?.operationType === "add" || loadedContent?.operationType === "create") ? "staged-add"
      : "staged-modify";

    if (loadedContent) {
      setBuffer(prev => {
        const newMap = new Map(prev);
        newMap.set(filePath, {
          id: fileId,
          path: filePath,
          kind,
          isStaged,
          operationType: loadedContent.operationType,
          content: loadedContent.content,
          originalContent: loadedContent.originalContent,  // Baseline for diffs
          lastSavedContent: loadedContent.content,         // Initial = content
          isDirty: false,
          isSaving: false,
        });
        return newMap;
      });
    }

    setCurrentPath(filePath);
  }, [repoId, buffer, currentPath, saveFileAsync, loadFileContent]);

  // Update content for current file
  const updateContent = useCallback((newContent: string) => {
    if (!currentPath) return;

    setBuffer(prev => {
      const newMap = new Map(prev);
      const file = newMap.get(currentPath);
      if (file) {
        // Dirty = content differs from last saved content (not original baseline)
        const isDirty = newContent !== file.lastSavedContent;
        newMap.set(currentPath, { ...file, content: newContent, isDirty });
      }
      return newMap;
    });
  }, [currentPath]);

  // Manual save for current file (returns promise for Save button)
  const saveCurrentFile = useCallback(async (): Promise<boolean> => {
    if (!currentPath) return false;

    const file = buffer.get(currentPath);
    if (!file?.isDirty) return true;

    try {
      await saveFileAsync(currentPath);
      return true;
    } catch {
      return false;
    }
  }, [currentPath, buffer, saveFileAsync]);

  // Save all dirty files (for navigation away)
  const saveAllDirty = useCallback(() => {
    const dirtyFiles = Array.from(buffer.entries())
      .filter(([_, file]) => file.isDirty && !file.isSaving);

    dirtyFiles.forEach(([path]) => {
      const savePromise = saveFileAsync(path);
      savePromisesRef.current.set(path, savePromise);
      savePromise.finally(() => {
        savePromisesRef.current.delete(path);
      });
    });
  }, [buffer, saveFileAsync]);

  // Close current file
  const closeFile = useCallback(async () => {
    if (!currentPath) return;

    const file = buffer.get(currentPath);
    if (file?.isDirty) {
      await saveFileAsync(currentPath);
    }

    setBuffer(prev => {
      const newMap = new Map(prev);
      newMap.delete(currentPath);
      return newMap;
    });
    setCurrentPath(null);
  }, [currentPath, buffer, saveFileAsync]);

  // Clear the buffer for a specific file
  const clearFile = useCallback((filePath: string) => {
    setBuffer(prev => {
      const newMap = new Map(prev);
      newMap.delete(filePath);
      return newMap;
    });
    if (currentPath === filePath) {
      setCurrentPath(null);
    }
  }, [currentPath]);

  // Evict all clean (non-dirty) staged entries from the buffer except an optional excluded path.
  // Call this on staging_refresh so a subsequent file open fetches fresh content instead of
  // returning a potentially stale cached version.
  const clearCleanStagedEntries = useCallback((excludePath?: string | null) => {
    setBuffer(prev => {
      const newMap = new Map(prev);
      for (const [path, file] of newMap) {
        if (file.isStaged && !file.isDirty && path !== excludePath) {
          newMap.delete(path);
        }
      }
      return newMap;
    });
  }, []);

  // Reload current file from database (discard local changes)
  const reloadCurrentFile = useCallback(async () => {
    if (!currentPath || !repoId) return;

    const file = buffer.get(currentPath);
    if (!file) return;

    const loadedContent = await loadFileContent(file.id, file.path, file.isStaged);

    if (loadedContent) {
      // If the file was staged but loadFileContent returned no operationType,
      // the staged row was deleted (file was committed) — update kind/isStaged.
      const wasCommitted = file.isStaged && !loadedContent.operationType;
      setBuffer(prev => {
        const newMap = new Map(prev);
        newMap.set(currentPath, {
          ...file,
          content: loadedContent.content,
          originalContent: loadedContent.originalContent,
          lastSavedContent: loadedContent.content,
          isDirty: false,
          isSaving: false,
          ...(wasCommitted ? { kind: "committed" as FileKind, isStaged: false, operationType: undefined } : {}),
        });
        return newMap;
      });
    }
  }, [currentPath, buffer, repoId, loadFileContent]);

  return {
    currentFile,
    currentPath,
    hasDirtyFiles,
    isSaving,
    switchFile,
    updateContent,
    saveCurrentFile,
    saveAllDirty,
    closeFile,
    clearFile,
    clearCleanStagedEntries,
    reloadCurrentFile,
  };
}
