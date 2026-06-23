import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StagingPanel } from "../build/StagingPanel";

const { mockRpc, mockRemoveChannel, mockCodeEditor } = vi.hoisted(() => ({
    mockRpc: vi.fn(),
    mockRemoveChannel: vi.fn(),
    mockCodeEditor: vi.fn(() => <div data-testid="code-editor" />),
}));

vi.mock("@/integrations/pronghorn-api/client", () => ({
    pronghornApi: {
        rpc: mockRpc,
        channel: vi.fn(() => ({
            on: vi.fn().mockReturnThis(),
            subscribe: vi.fn(),
        })),
        removeChannel: mockRemoveChannel,
    },
}));

vi.mock("@/hooks/use-toast", () => ({
    useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/components/repository/CodeEditor", () => ({
    CodeEditor: mockCodeEditor,
}));

vi.mock("@/lib/stagingOperations", () => ({
    unstageFile: vi.fn(),
    unstageMultiple: vi.fn(),
    discardAllStaged: vi.fn(),
    commitStaged: vi.fn(),
}));

beforeEach(() => {
    mockRpc.mockReset();
    mockRemoveChannel.mockReset();
    mockCodeEditor.mockClear();
});

describe("StagingPanel diff behavior", () => {
    it("fetches committed baseline into CodeEditor diffOldContent", async () => {
        mockStagingPanelRpc([stagedChange({ old_content: "stale staged baseline", new_content: "changed" })], {
            content: "committed baseline",
            is_binary: false,
            content_length: 18,
        });

        renderStagingPanel();
        await openFirstDiff();

        expect(mockCodeEditor).toHaveBeenLastCalledWith(
            expect.objectContaining({ diffOldContent: "committed baseline" }),
            expect.any(Object),
        );
    });

    it("fetches modify baseline with repo id and file path", async () => {
        mockStagingPanelRpc([stagedChange({ operation_type: "modify", file_path: "src/changed.ts" })], {
            content: "committed modify baseline",
            is_binary: false,
            content_length: 25,
        });

        renderStagingPanel();
        await openFirstDiff();

        expect(mockRpc).toHaveBeenCalledWith("get_committed_file_content_by_path_with_token", {
            p_repo_id: "repo-1",
            p_file_path: "src/changed.ts",
            p_token: null,
        });
        expect(mockCodeEditor).toHaveBeenLastCalledWith(
            expect.objectContaining({ diffOldContent: "committed modify baseline" }),
            expect.any(Object),
        );
    });

    it("fetches deleted file committed content as baseline", async () => {
        mockStagingPanelRpc([stagedChange({ operation_type: "delete", new_content: "deleted staged content" })], {
            content: "deleted committed content",
            is_binary: false,
            content_length: 25,
        });

        renderStagingPanel();
        await openFirstDiff(/view/i);

        expect(mockCodeEditor).toHaveBeenLastCalledWith(
            expect.objectContaining({
                initialContent: "",
                diffOldContent: "deleted committed content",
            }),
            expect.any(Object),
        );
    });

    it("passes staged new_content into CodeEditor initialContent", async () => {
        mockStagingPanelRpc([stagedChange({ old_content: "baseline", new_content: "changed" })], {
            content: "committed baseline",
            is_binary: false,
            content_length: 18,
        });

        renderStagingPanel();
        await openFirstDiff();

        // "after" content now comes from get_staged_file_content_with_token, not change.new_content
        expect(mockCodeEditor).toHaveBeenLastCalledWith(
            expect.objectContaining({ initialContent: "changed" }),
            expect.any(Object),
        );
    });

    it("uses an empty old_content baseline for a new file diff", async () => {
        mockStagingPanelRpc([stagedChange({ operation_type: "add", old_content: undefined, new_content: "new file" })]);

        renderStagingPanel();
        await openFirstDiff();

        expect(mockCodeEditor).toHaveBeenLastCalledWith(
            expect.objectContaining({
                initialContent: "new file",
                diffOldContent: "",
            }),
            expect.any(Object),
        );
        expect(mockRpc).not.toHaveBeenCalledWith(
            "get_committed_file_content_by_path_with_token",
            expect.any(Object),
        );
    });

    it("fetches baseline on demand instead of panel load", async () => {
        mockStagingPanelRpc([stagedChange()], {
            content: "committed baseline",
            is_binary: false,
            content_length: 18,
        });

        renderStagingPanel();
        await screen.findByRole("button", { name: /1 file staged/i });

        expect(mockRpc).not.toHaveBeenCalledWith(
            "get_committed_file_content_by_path_with_token",
            expect.any(Object),
        );

        await openFirstDiff();

        expect(mockRpc).toHaveBeenCalledWith("get_committed_file_content_by_path_with_token", expect.any(Object));
    });
});

const stagedChange = (overrides: Record<string, unknown> = {}) => ({
    id: "stage-1",
    operation_type: "edit",
    file_path: "src/example.ts",
    old_content: "base",
    new_content: "changed",
    created_at: "2026-05-19T00:00:00.000Z",
    ...overrides,
});

const mockStagingPanelRpc = (
    stagedChanges: Array<Record<string, unknown>>,
    baseline: Record<string, unknown> | null = null,
    stagedContent: Record<string, unknown> | null = null,
) => {
    mockRpc.mockImplementation(async (name: string, params?: Record<string, unknown>) => {
        if (name === "get_project_repos_with_token") {
            return { data: [{ id: "repo-1", branch: "main", is_prime: true, is_default: true }], error: null };
        }
        if (name === "get_staged_changes_with_token") {
            return { data: stagedChanges, error: null };
        }
        if (name === "get_commit_history_with_token") {
            return { data: [], error: null };
        }
        if (name === "get_committed_file_content_by_path_with_token") {
            return { data: baseline, error: null };
        }
        if (name === "get_staged_file_content_with_token") {
            // Return the first staged change's new_content if no explicit stagedContent override given
            const firstChange = stagedChanges[0] as Record<string, unknown> | undefined;
            const content = stagedContent ?? (firstChange ? { content: firstChange.new_content ?? "", operation_type: firstChange.operation_type ?? "edit" } : null);
            return { data: content, error: null };
        }
        return { data: null, error: null };
    });
};

const openFirstDiff = async (buttonName: RegExp = /diff/i) => {
    const stagedSectionTrigger = await screen.findByRole("button", { name: /1 file staged/i });
    fireEvent.click(stagedSectionTrigger);
    const diffButton = await screen.findByRole("button", { name: buttonName });
    fireEvent.click(diffButton);
    await waitFor(() => {
        expect(mockCodeEditor).toHaveBeenCalled();
    });
};

export const renderStagingPanel = () =>
    render(
        <StagingPanel
            projectId="project-1"
            shareToken={null}
            autoCommit={false}
            onAutoCommitChange={vi.fn()}
        />,
    );

export const codeEditorSpy = mockCodeEditor;
export const stagedRpcSpy = mockRpc;