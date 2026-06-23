/**
 * Unit test scaffold for staging observability behavior.
 *
 * @example
 * mockLoggerInfo.mockClear();
 */
import express from "express";
import request from "supertest";

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockGetClient = jest.fn();
const mockLoggerInfo = jest.fn();
const mockBroadcast = jest.fn();
const mockWriteContent = jest.fn();
const mockWriteBatch = jest.fn();

jest.mock("../../utils/database", () => ({
    __esModule: true,
    default: {
        query: mockQuery,
        getClient: mockGetClient,
    },
}));

jest.mock("../../websocket", () => ({
    broadcast: mockBroadcast,
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        error: jest.fn(),
        warn: jest.fn(),
        info: mockLoggerInfo,
        debug: jest.fn(),
    },
}));

const mockReadStaged = jest.fn();
const mockWriteCommitted = jest.fn();
const mockDeleteStaged = jest.fn();

jest.mock("../../utils/repoBlobStore", () => ({
    getRepoBlobStore: jest.fn(() => ({
        writeStaged: mockWriteContent,
        writeStagedBatch: mockWriteBatch,
        readStaged: mockReadStaged,
        writeCommitted: mockWriteCommitted,
        deleteStaged: mockDeleteStaged,
        deleteCommitted: jest.fn(),
        readCommitted: jest.fn(),
    })),
}));

beforeEach(() => {
    mockQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
    mockGetClient.mockReset();
    mockLoggerInfo.mockReset();
    mockBroadcast.mockReset();
    mockWriteContent.mockReset();
    mockReadStaged.mockReset();
    mockWriteCommitted.mockReset();
    mockDeleteStaged.mockReset();
    mockWriteBatch.mockReset();

    mockGetClient.mockResolvedValue({
        query: mockClientQuery,
        release: mockClientRelease,
    });
});

import {
    batchStageFiles,
    stageFileChangeWithToken,
} from "../../utils/rpcHelpers";
import rpcRouter from "../../routes/rpc";

const app = express();
app.use(express.json());
app.use("/rpc", rpcRouter);

describe("staging observability behavior", () => {
    it("logs stageFileChangeWithToken timing", async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ project_id: "project-1" }] })
            .mockResolvedValueOnce({ rows: [{ id: "stage-1" }] })
            .mockResolvedValueOnce({ rows: [{ count: "3" }] });

        await stageFileChangeWithToken("repo-1", null, "src/example.ts", "edit", "old", "new", null);

        expect(mockLoggerInfo).toHaveBeenCalledWith(expect.objectContaining({
            event: "stage_complete",
            stage_duration_ms: expect.any(Number),
        }));
    });

    it("logs commit_staged_with_token timing and file count", async () => {
        mockReadStaged.mockResolvedValueOnce("new");
        mockWriteCommitted.mockResolvedValueOnce(undefined);
        mockDeleteStaged.mockResolvedValueOnce(undefined);
        mockClientQuery
            .mockResolvedValueOnce({ rows: [{ project_id: "project-1" }] })
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce({ rows: [{ file_path: "src/example.ts", operation_type: "modify", new_content: "new" }] })
            .mockResolvedValueOnce({ rows: [{ id: "commit-1" }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce(undefined);

        const response = await request(app)
            .post("/rpc/commit_staged_with_token")
            .send({
                p_repo_id: "repo-1",
                p_commit_message: "Commit staged changes",
                p_branch: "main",
            });

        expect(response.status).toBe(200);
        expect(mockLoggerInfo).toHaveBeenCalledWith(expect.objectContaining({
            event: "commit_complete",
            commit_duration_ms: expect.any(Number),
            commit_files_count: 1,
            success: true,
        }));
    });

    it("logs stage file path and operation type", async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ project_id: "project-1" }] })
            .mockResolvedValueOnce({ rows: [{ id: "stage-1" }] })
            .mockResolvedValueOnce({ rows: [{ count: "3" }] });

        await stageFileChangeWithToken("repo-1", null, "src/example.ts", "modify", null, "new", null);

        expect(mockLoggerInfo).toHaveBeenCalledWith(expect.objectContaining({
            event: "stage_complete",
            stage_duration_ms: expect.any(Number),
            file_path: "src/example.ts",
            operation_type: "modify",
        }));
    });

    it("broadcasts staging_refresh once after stage_file_change_with_token succeeds", async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ project_id: "project-1" }] })
            .mockResolvedValueOnce({ rows: [{ id: "stage-1", project_id: "project-1" }] })
            .mockResolvedValueOnce({ rows: [{ count: "1" }] })
            .mockResolvedValueOnce({ rows: [{ project_id: "project-1" }] });

        const response = await request(app)
            .post("/rpc/stage_file_change_with_token")
            .send({
                p_repo_id: "repo-1",
                p_file_path: "src/example.ts",
                p_operation_type: "edit",
                p_old_content: "old",
                p_new_content: "new",
            });

        expect(response.status).toBe(200);
        expect(mockBroadcast).toHaveBeenCalledTimes(1);
        expect(mockBroadcast).toHaveBeenCalledWith(
            "repo-staging-repo-1",
            "staging_refresh",
            { projectId: "project-1", repoId: "repo-1" },
        );
    });

    it("logs batch stage timing and staged count", async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ project_id: "project-1" }] });
        mockClientQuery
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce({ rows: [{ id: "stage-1" }] })
            .mockResolvedValueOnce({ rows: [{ id: "stage-2" }] })
            .mockResolvedValueOnce({ rows: [{ count: "2" }] })
            .mockResolvedValueOnce(undefined);

        await batchStageFiles("repo-1", null, [
            { filePath: "src/one.ts", operationType: "create", newContent: "one" },
            { filePath: "src/two.ts", operationType: "modify", newContent: "two" },
        ]);

        expect(mockLoggerInfo).toHaveBeenCalledWith(expect.objectContaining({
            event: "batch_stage_complete",
            stage_duration_ms: expect.any(Number),
            staged_count: 2,
        }));
    });

    it("logs staging row count for the affected repo", async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ project_id: "project-1" }] })
            .mockResolvedValueOnce({ rows: [{ id: "stage-1" }] })
            .mockResolvedValueOnce({ rows: [{ count: "7" }] });

        await stageFileChangeWithToken("repo-1", null, "src/example.ts", "modify", null, "new", null);

        expect(mockQuery).toHaveBeenCalledWith("SELECT count(*) FROM repo_staging WHERE repo_id = $1", ["repo-1"]);
        expect(mockLoggerInfo).toHaveBeenCalledWith(expect.objectContaining({
            event: "stage_complete",
            staging_row_count: expect.any(Number),
        }));
    });
});