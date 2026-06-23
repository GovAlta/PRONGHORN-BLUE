/**
 * Route-level scaffold for AI file operation staging behavior.
 *
 * @example
 * mockStageFileChangeWithToken.mockResolvedValue({ id: 'stage-1' });
 */
import express from "express";
import request from "supertest";

const mockStageFileChangeWithToken = jest.fn();
const mockBatchStageFiles = jest.fn();
const mockBroadcast = jest.fn();
const mockDbQuery = jest.fn();
const mockDbClientQuery = jest.fn();
const mockDbClientRelease = jest.fn();
const mockGetClient = jest.fn();
const mockAuthorizeProjectAccess = jest.fn();
const mockCreateAgentSessionWithToken = jest.fn();
const mockInsertAgentMessageWithToken = jest.fn();
const mockGetStagedFileWithToken = jest.fn();
const mockGetRepoFileByPathWithToken = jest.fn();
const mockWriteBatch = jest.fn();
const mockReadCommitted = jest.fn();

jest.mock("../../utils/rpcHelpers", () => ({
    stageFileChangeWithToken: mockStageFileChangeWithToken,
    batchStageFiles: mockBatchStageFiles,
    authorizeProjectAccess: mockAuthorizeProjectAccess,
    createAgentSessionWithToken: mockCreateAgentSessionWithToken,
    insertAgentMessageWithToken: mockInsertAgentMessageWithToken,
    getStagedFileWithToken: mockGetStagedFileWithToken,
    getRepoFileByPathWithToken: mockGetRepoFileByPathWithToken,
}));

jest.mock("../../utils/repoBlobStore", () => ({
    getRepoBlobStore: jest.fn(() => ({
        writeStagedBatch: mockWriteBatch,
        readCommitted: mockReadCommitted,
    })),
}));

jest.mock("../../utils/database", () => ({
    __esModule: true,
    default: {
        query: mockDbQuery,
        getClient: mockGetClient,
    },
}));

jest.mock("../../config/aiModels", () => ({
    buildEndpointUrl: jest.fn(() => "https://example.test/openai/deployments/test/chat/completions"),
    getDefaultModel: jest.fn(() => ({ id: "test-model", deploymentName: "test-model" })),
    getModelConfig: jest.fn(() => ({ id: "test-model", deploymentName: "test-model" })),
}));

jest.mock("../../websocket", () => ({
    broadcast: mockBroadcast,
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    },
}));

beforeEach(() => {
    mockStageFileChangeWithToken.mockReset();
    mockBatchStageFiles.mockReset();
    mockBroadcast.mockReset();
    mockDbQuery.mockReset();
    mockDbClientQuery.mockReset();
    mockDbClientRelease.mockReset();
    mockGetClient.mockReset();
    mockAuthorizeProjectAccess.mockReset();
    mockCreateAgentSessionWithToken.mockReset();
    mockInsertAgentMessageWithToken.mockReset();
    mockGetStagedFileWithToken.mockReset();
    mockGetRepoFileByPathWithToken.mockReset();
    mockWriteBatch.mockReset();
    mockReadCommitted.mockReset();

    mockStageFileChangeWithToken.mockResolvedValue({ id: "stage-1" });
    mockBatchStageFiles.mockResolvedValue({ staged_count: 1, files: ["src/example.ts"] });
    mockAuthorizeProjectAccess.mockResolvedValue("editor");
    mockCreateAgentSessionWithToken.mockResolvedValue({ id: "session-1" });
    mockInsertAgentMessageWithToken.mockResolvedValue({ id: "message-1" });
    mockGetStagedFileWithToken.mockResolvedValue(null);
    mockGetRepoFileByPathWithToken.mockResolvedValue({
        id: "file-1",
        path: "src/example.ts",
    });
    mockReadCommitted.mockResolvedValue(["one", "two", "three", "four", "five"].join("\n"));
    mockWriteBatch.mockResolvedValue(undefined);
    mockDbQuery.mockResolvedValue({ rows: [{ id: "operation-1" }] });
    mockGetClient.mockResolvedValue({
        query: mockDbClientQuery,
        release: mockDbClientRelease,
    });
    global.fetch = jest.fn();
});

import functionsRouter from "../../routes/functions";
import rpcRouter from "../../routes/rpc";

const { batchStageFiles: actualBatchStageFiles } = jest.requireActual("../../utils/rpcHelpers");

describe("AI batch staging behavior", () => {
    it("batches edit_lines changes instead of staging individually", async () => {
        await invokeCodingAgent([
            editOperation(1),
            editOperation(2),
            editOperation(3),
            editOperation(4),
            editOperation(5),
        ]);

        expect(mockStageFileChangeWithToken).not.toHaveBeenCalled();
        expect(mockBatchStageFiles).toHaveBeenCalledTimes(1);
        expect(mockBatchStageFiles).toHaveBeenCalledWith("repo-1", null, [
            expect.objectContaining({ filePath: "src/example.ts", operationType: "modify" }),
        ], "project-1");
    });

    it("batches create_file changes into one call", async () => {
        await invokeCodingAgent([
            createOperation("src/one.ts"),
            createOperation("src/two.ts"),
            createOperation("src/three.ts"),
        ]);

        expect(mockStageFileChangeWithToken).not.toHaveBeenCalled();
        expect(mockBatchStageFiles).toHaveBeenCalledTimes(1);
        expect(mockBatchStageFiles.mock.calls[0][2].map((file: { filePath: string }) => file.filePath)).toEqual([
            "src/one.ts",
            "src/two.ts",
            "src/three.ts",
        ]);
    });

    it("normalizes single-key create_file operations returned by the AI model", async () => {
        await invokeCodingAgent([
            { create_file: "test_file_1.txt", content: "This is test file 1." },
            { create_file: "test_file_2.txt", content: "This is test file 2." },
            { create_file: "test_file_3.txt", content: "This is test file 3." },
            { create_file: "test_file_4.txt", content: "This is test file 4." },
            { create_file: "test_file_5.txt", content: "This is test file 5." },
        ]);

        expect(mockStageFileChangeWithToken).not.toHaveBeenCalled();
        expect(mockBatchStageFiles).toHaveBeenCalledTimes(1);
        expect(mockBatchStageFiles.mock.calls[0][2]).toEqual([
            expect.objectContaining({ filePath: "test_file_1.txt", newContent: "This is test file 1." }),
            expect.objectContaining({ filePath: "test_file_2.txt", newContent: "This is test file 2." }),
            expect.objectContaining({ filePath: "test_file_3.txt", newContent: "This is test file 3." }),
            expect.objectContaining({ filePath: "test_file_4.txt", newContent: "This is test file 4." }),
            expect.objectContaining({ filePath: "test_file_5.txt", newContent: "This is test file 5." }),
        ]);
    });

    it("documents each AI file operation emits an operation-completed broadcast", async () => {
        await invokeCodingAgent([
            createOperation("src/one.ts"),
            createOperation("src/two.ts"),
            createOperation("src/three.ts"),
        ]);

        const completedOperationBroadcasts = mockBroadcast.mock.calls.filter(([channel, event, payload]) =>
            channel === "agent-operations-project-project-1-coding"
            && event === "agent_operation_refresh"
            && payload?.status === "completed"
            && payload?.operationId,
        );
        expect(completedOperationBroadcasts).toHaveLength(3);
    });

    it("emits a single staging broadcast after batch staging", async () => {
        await invokeCodingAgent([
            createOperation("src/one.ts"),
            createOperation("src/two.ts"),
        ]);

        const stagingBroadcasts = mockBroadcast.mock.calls.filter(([channel, event]) =>
            channel === "repo-staging-repo-1" && event === "staging_refresh"
        );
        expect(stagingBroadcasts).toHaveLength(1);
    });

    it("falls back to individual staging when batch staging fails", async () => {
        mockBatchStageFiles.mockRejectedValueOnce(new Error("batch failed"));

        await invokeCodingAgent([
            createOperation("src/one.ts"),
            createOperation("src/two.ts"),
        ]);

        expect(mockBatchStageFiles).toHaveBeenCalledTimes(1);
        expect(mockStageFileChangeWithToken).toHaveBeenCalledTimes(2);
        expect(mockStageFileChangeWithToken.mock.calls.map((call) => call[2])).toEqual(["src/one.ts", "src/two.ts"]);
    });

    it("batchStageFiles writes N files in a single transaction", async () => {
        mockDbQuery.mockResolvedValueOnce({ rows: [{ project_id: "project-1" }] });
        mockDbClientQuery.mockResolvedValue({ rows: [{ project_id: "project-1" }] });

        await actualBatchStageFiles("repo-1", null, [
            { filePath: "src/one.ts", operationType: "create", newContent: "one" },
            { filePath: "src/two.ts", operationType: "modify", newContent: "two" },
        ]);

        expect(mockWriteBatch).toHaveBeenCalledWith("project-1", "repo-1", [
            { filePath: "src/one.ts", operationType: "create", content: "one" },
            { filePath: "src/two.ts", operationType: "modify", content: "two" },
        ]);
        expect(mockDbClientQuery.mock.calls.map((call) => call[0])).toEqual([
            "BEGIN",
            expect.stringContaining("INSERT INTO repo_staging"),
            expect.stringContaining("INSERT INTO repo_staging"),
            "SELECT count(*) FROM repo_staging WHERE repo_id = $1",
            "COMMIT",
        ]);
        expect(mockDbClientRelease).toHaveBeenCalledTimes(1);
    });

    it("partial failure rolls back all files", async () => {
        mockDbQuery.mockResolvedValueOnce({ rows: [{ project_id: "project-1" }] });
        mockDbClientQuery
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error("insert failed"))
            .mockResolvedValueOnce(undefined);

        await expect(actualBatchStageFiles("repo-1", null, [
            { filePath: "src/one.ts", operationType: "create", newContent: "one" },
        ])).rejects.toThrow("insert failed");

        expect(mockDbClientQuery.mock.calls.map((call) => call[0])).toEqual([
            "BEGIN",
            expect.stringContaining("INSERT INTO repo_staging"),
            "ROLLBACK",
        ]);
        expect(mockDbClientRelease).toHaveBeenCalledTimes(1);
    });

    it("batch_stage_files_with_token rejects more than 100 files", async () => {
        const response = await request(app)
            .post("/rpc/batch_stage_files_with_token")
            .send({
                p_repo_id: "repo-1",
                p_project_id: "project-1",
                p_files: Array.from({ length: 101 }, (_, index) => ({
                    file_path: `src/file-${index}.ts`,
                    operation_type: "create",
                    new_content: "content",
                })),
            });

        expect(response.status).toBe(400);
        expect(response.body.error).toContain("maximum batch size of 100");
        expect(mockBatchStageFiles).not.toHaveBeenCalled();
    });
});

const app = express();
app.use(express.json());
app.use("/functions", functionsRouter);
app.use("/rpc", rpcRouter);

const editOperation = (line: number) => ({
    type: "edit_lines",
    params: {
        path: "src/example.ts",
        start_line: line,
        end_line: line,
        new_content: `changed ${line}`,
    },
});

const createOperation = (path: string) => ({
    type: "create_file",
    params: {
        path,
        content: `content for ${path}`,
    },
});

const invokeCodingAgent = async (operations: Array<Record<string, unknown>>) => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(streamingAiResponse({
        reasoning: "characterization test",
        operations,
        status: "completed",
    }));

    const response = await request(app)
        .post("/functions/coding-agent-orchestrator")
        .send({
            projectId: "project-1",
            repoId: "repo-1",
            taskDescription: "characterize AI staging",
            selectedModel: "test-model",
            maxIterations: 1,
        });

    expect(response.status).toBe(200);
};

const streamingAiResponse = (payload: Record<string, unknown>) => {
    const encoder = new TextEncoder();
    const chunk = encoder.encode(`data: ${JSON.stringify({
        choices: [{ delta: { content: JSON.stringify(payload) } }],
    })}\n\ndata: [DONE]\n\n`);
    let sent = false;

    return {
        ok: true,
        status: 200,
        body: {
            getReader: () => ({
                read: async () => {
                    if (sent) return { done: true, value: undefined };
                    sent = true;
                    return { done: false, value: chunk };
                },
                releaseLock: jest.fn(),
            }),
        },
        json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
        text: async () => "",
    };
};