import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFileBuffer } from "../useFileBuffer";

const { mockRpc, mockStageFile, mockUnstageFile } = vi.hoisted(() => ({
    mockRpc: vi.fn(),
    mockStageFile: vi.fn(),
    mockUnstageFile: vi.fn(),
}));

vi.mock("@/integrations/pronghorn-api/client", () => ({
    pronghornApi: {
        rpc: mockRpc,
    },
}));

vi.mock("@/lib/stagingOperations", () => ({
    stageFile: mockStageFile,
    unstageFile: mockUnstageFile,
}));

beforeEach(() => {
    mockRpc.mockReset();
    mockStageFile.mockReset();
    mockUnstageFile.mockReset();
    mockStageFile.mockResolvedValue(undefined);
    mockUnstageFile.mockResolvedValue(undefined);
});

describe("useFileBuffer save behavior", () => {
    it("documents saveFileAsync skips staged SELECT and unstage before staging", async () => {
        await saveChangedFile();

        expect(mockRpc).not.toHaveBeenCalledWith("get_staged_changes_with_token", expect.any(Object));
        expect(mockRpc).not.toHaveBeenCalledWith("unstage_file_with_token", expect.any(Object));
        expect(mockStageFile).toHaveBeenCalledWith(expect.objectContaining({
            filePath: "src/example.ts",
            operationType: "modify",
            newContent: "changed",
        }));
    });

    it("documents a single stage call per save", async () => {
        await saveChangedFile();

        expect(mockStageFile).toHaveBeenCalledTimes(1);
    });

    it("documents operation type derived from buffer state", async () => {
        await saveChangedFile({ fileId: "file-1", isStaged: true });

        expect(mockStageFile).toHaveBeenLastCalledWith(expect.objectContaining({
            operationType: "modify",
        }));

        mockStageFile.mockClear();
        // A new file staged with operation_type "add" should preserve that type through saves
        await saveChangedFile({ fileId: "file-new", isStaged: true, stagedOperationType: "add" });

        expect(mockStageFile).toHaveBeenLastCalledWith(expect.objectContaining({
            operationType: "add",
        }));
    });

    it("documents oldContent is not sent when staging saves", async () => {
        await saveChangedFile();

        expect(mockStageFile.mock.calls[0][0]).not.toHaveProperty("oldContent");
    });

    it("documents smart-unstage when content is reverted to the original baseline", async () => {
        mockRpc.mockImplementation(async (name: string) => {
            if (name === "get_file_content_with_token") return { data: [{ content: "base" }], error: null };
            if (name === "get_staged_changes_with_token") return { data: [], error: null };
            return { data: null, error: null };
        });

        const { result } = renderUseFileBuffer();

        await act(async () => {
            await result.current.switchFile("file-1", "src/example.ts");
        });
        act(() => result.current.updateContent("changed"));
        await act(async () => {
            await result.current.saveCurrentFile();
        });
        act(() => result.current.updateContent("base"));
        await act(async () => {
            await result.current.saveCurrentFile();
        });

        expect(mockUnstageFile).toHaveBeenCalledWith({
            repoId: "repo-1",
            shareToken: null,
            filePath: "src/example.ts",
        });
    });

    it("documents dirty detection based on lastSavedContent", async () => {
        mockRpc.mockImplementation(async (name: string) => {
            if (name === "get_file_content_with_token") return { data: [{ content: "base" }], error: null };
            if (name === "get_staged_changes_with_token") return { data: [], error: null };
            return { data: null, error: null };
        });

        const { result } = renderUseFileBuffer();

        await act(async () => {
            await result.current.switchFile("file-1", "src/example.ts");
        });

        expect(result.current.currentFile?.isDirty).toBe(false);

        act(() => result.current.updateContent("changed"));
        expect(result.current.currentFile?.isDirty).toBe(true);

        await act(async () => {
            await result.current.saveCurrentFile();
        });
        expect(result.current.currentFile?.lastSavedContent).toBe("changed");
        expect(result.current.currentFile?.isDirty).toBe(false);

        act(() => result.current.updateContent("base"));
        expect(result.current.currentFile?.isDirty).toBe(true);
    });
});

const saveChangedFile = async ({
    fileId = "file-1",
    isStaged,
    stagedOperationType = "modify",
}: { fileId?: string; isStaged?: boolean; stagedOperationType?: string } = {}) => {
    mockRpc.mockImplementation(async (name: string) => {
        if (name === "get_file_content_with_token") return { data: [{ content: "base" }], error: null };
        if (name === "get_staged_file_content_with_token") {
            // When the file is staged, return staged metadata so operationType is set correctly
            return { data: { content: "base", old_content: "base", operation_type: stagedOperationType }, error: null };
        }
        return { data: null, error: null };
    });

    const { result } = renderUseFileBuffer();

    await act(async () => {
        await result.current.switchFile(fileId, "src/example.ts", isStaged);
    });
    mockRpc.mockClear();
    act(() => result.current.updateContent("changed"));
    await act(async () => {
        await result.current.saveCurrentFile();
    });
};

export const renderUseFileBuffer = () =>
    renderHook(() =>
        useFileBuffer({
            repoId: "repo-1",
            shareToken: null,
            onFileSaved: vi.fn(),
        }),
    );

describe("useFileBuffer staged-add safety", () => {
    it("does not auto-unstage a staged-add file when content reverts to empty baseline", async () => {
        /**
         * Regression guard for F11: the smart-unstage check previously fired
         * on any file where content === originalContent, including new files
         * (operationType === "add") whose baseline is always "".  After the fix,
         * add/create operations are excluded from the auto-unstage path entirely.
         *
         * Scenario: user creates a new file (staged-add), types content, saves
         * (advances lastSavedContent), then clears the editor back to "".
         * content("") === originalContent("") so old code would have called
         * unstageFile.  New code skips unstage for add ops and re-stages instead.
         */
        mockRpc.mockImplementation(async (name: string) => {
            if (name === "get_staged_file_content_with_token") {
                return { data: { content: "", old_content: "", operation_type: "add" }, error: null };
            }
            return { data: null, error: null };
        });

        const { result } = renderUseFileBuffer();

        // Open the new staged-add file
        await act(async () => {
            await result.current.switchFile("file-new", "src/new-file.ts", true);
        });

        // Type content and save — advances lastSavedContent
        act(() => result.current.updateContent("typed content"));
        await act(async () => { await result.current.saveCurrentFile(); });

        mockStageFile.mockClear();
        mockUnstageFile.mockClear();

        // Clear editor back to "" — matches originalContent but not lastSavedContent
        act(() => result.current.updateContent(""));
        await act(async () => { await result.current.saveCurrentFile(); });

        // Must NOT auto-unstage even though content === originalContent === ""
        expect(mockUnstageFile).not.toHaveBeenCalled();
        // Must re-stage with empty content to persist the intentional clear
        expect(mockStageFile).toHaveBeenCalledWith(expect.objectContaining({
            operationType: "add",
            newContent: "",
        }));
    });
});

describe("useFileBuffer switchFile generation guard", () => {
    it("discards stale content when switchFile is superseded before its load resolves", async () => {
        /**
         * Regression guard for F9: without the navGenRef generation counter,
         * a slow first load could overwrite the buffer with stale content after
         * the user had already navigated to a second file.
         */
        let resolveFirst!: (v: unknown) => void;
        const firstBlocked = new Promise<unknown>(r => { resolveFirst = r; });

        let callCount = 0;
        mockRpc.mockImplementation(async (name: string) => {
            if (name === "get_file_content_with_token" || name === "get_staged_file_content_with_token") {
                callCount++;
                if (callCount === 1) await firstBlocked; // block only the first load
                return { data: [{ content: `content-for-${callCount === 1 ? "first" : "second"}` }], error: null };
            }
            return { data: null, error: null };
        });

        const { result } = renderUseFileBuffer();

        // Start first navigation — fire-and-forget so it remains in-flight.
        // Use synchronous act() to avoid the "act(async) without await" warning;
        // the inner switchFile promise is intentionally not awaited here.
        const firstPromise = new Promise<void>(resolve => {
            act(() => {
                result.current.switchFile("file-1", "src/first.ts").catch(() => { /* ignore */ }).finally(resolve);
            });
        });

        // Immediately navigate to a second file and wait for it to finish
        await act(async () => {
            await result.current.switchFile("file-2", "src/second.ts");
        });

        // Unblock the first (now-stale) load and let it settle
        resolveFirst({});
        await firstPromise;

        // The second file should remain current; the stale first result is discarded
        expect(result.current.currentPath).toBe("src/second.ts");
    });
});