import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodeEditor } from "../repository/CodeEditor";

const { mockRpc, mockToast, mockEditor } = vi.hoisted(() => ({
    mockRpc: vi.fn(),
    mockToast: vi.fn(),
    mockEditor: vi.fn(() => <textarea aria-label="code editor" readOnly />),
}));

vi.mock("@monaco-editor/react", () => ({
    __esModule: true,
    default: mockEditor,
    DiffEditor: vi.fn(() => <div data-testid="diff-editor" />),
}));

vi.mock("@/integrations/pronghorn-api/client", () => ({
    pronghornApi: {
        rpc: mockRpc,
    },
}));

vi.mock("@/hooks/use-toast", () => ({
    useToast: () => ({ toast: mockToast }),
}));

beforeEach(() => {
    mockRpc.mockReset();
    mockToast.mockReset();
    mockEditor.mockClear();
});

describe("CodeEditor staged content loading", () => {
    it("fetches blob content via get_staged_file_content_with_token when isStaged is true", async () => {
        /**
         * Regression guard for F1: the editor was reading repo_staging.new_content
         * (always NULL post-blob-refactor) instead of calling the dedicated staged
         * content RPC that reads from blob storage.  After the fix, opening a staged
         * file calls get_staged_file_content_with_token and the editor displays the
         * non-empty content returned by the blob-backed RPC.
         */
        mockRpc.mockImplementation(async (name: string) => {
            if (name === "get_staged_file_content_with_token") {
                return {
                    data: {
                        content: "export const staged = true;",
                        old_content: "",
                        operation_type: "add",
                    },
                    error: null,
                };
            }
            return { data: null, error: null };
        });

        render(
            <CodeEditor
                fileId="file-new"
                filePath="src/new-file.ts"
                repoId="repo-1"
                shareToken={null}
                isStaged={true}
                onClose={vi.fn()}
            />,
        );

        await waitFor(() => {
            expect(mockRpc).toHaveBeenCalledWith(
                "get_staged_file_content_with_token",
                expect.objectContaining({
                    p_repo_id: "repo-1",
                    p_file_path: "src/new-file.ts",
                }),
            );
        });
        // The committed-file RPC must NOT have been called — content came from blob
        expect(mockRpc).not.toHaveBeenCalledWith("get_file_content_with_token", expect.any(Object));
    });
});

describe("CodeEditor save behavior", () => {
    it("documents handleSave stages without staged SELECT", async () => {
        mockExistingStagedRow();

        renderCodeEditor();
        fireEvent.click(screen.getByRole("button", { name: /save/i }));

        await waitFor(() => {
            expect(mockRpc).toHaveBeenCalledWith("stage_file_change_with_token", expect.any(Object));
        });

        expect(mockRpc).not.toHaveBeenCalledWith("get_staged_changes_with_token", expect.any(Object));
        expect(mockRpc.mock.calls[0][0]).toBe("stage_file_change_with_token");
    });

    it("documents handleSave uses a single stage RPC with null old_content", async () => {
        mockExistingStagedRow();

        renderCodeEditor();
        fireEvent.click(screen.getByRole("button", { name: /save/i }));

        await waitFor(() => {
            expect(mockRpc).toHaveBeenCalledTimes(1);
        });
        expect(mockRpc.mock.calls.map(([name]) => name)).toEqual([
            "stage_file_change_with_token",
        ]);
        expect(mockRpc.mock.calls[0][1]).toEqual(expect.objectContaining({
            p_operation_type: "modify",
            p_old_content: null,
            p_new_content: "export const value = 1;",
        }));
    });
});

const mockExistingStagedRow = () => {
    mockRpc.mockImplementation(async (name: string) => {
        if (name === "get_staged_changes_with_token") {
            return {
                data: [{
                    id: "stage-1",
                    file_path: "src/example.ts",
                    operation_type: "edit",
                    old_content: "first baseline",
                    new_content: "previous staged",
                }],
                error: null,
            };
        }

        return { data: null, error: null };
    });
};

export const renderCodeEditor = () =>
    render(
        <CodeEditor
            fileId="file-1"
            filePath="src/example.ts"
            repoId="repo-1"
            shareToken={null}
            initialContent="export const value = 1;"
            onClose={vi.fn()}
        />,
    );

export const codeEditorRpcSpy = mockRpc;