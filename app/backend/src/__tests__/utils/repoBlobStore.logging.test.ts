const loggerInfoMock = jest.fn();
const uploadMock = jest.fn();
const downloadToBufferMock = jest.fn();
const deleteIfExistsMock = jest.fn();
const deleteBlobMock = jest.fn();
const listBlobsFlatMock = jest.fn();

jest.mock("../../utils/logger", () => ({
    logger: {
        info: loggerInfoMock,
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    },
}));

jest.mock("@azure/storage-blob", () => ({
    BlobServiceClient: jest.fn(),
}));

import { RepoBlobStore } from "../../utils/repoBlobStore";

const createStore = () => new RepoBlobStore({
    getContainerClient: () => ({
        getBlockBlobClient: () => ({
            upload: uploadMock,
            downloadToBuffer: downloadToBufferMock,
            deleteIfExists: deleteIfExistsMock,
        }),
        listBlobsFlat: listBlobsFlatMock,
        deleteBlob: deleteBlobMock,
        createIfNotExists: jest.fn().mockResolvedValue({}),
    }),
});

async function* blobList(names: string[]) {
    for (const name of names) {
        yield { name };
    }
}

describe("RepoBlobStore logging", () => {
    beforeEach(() => {
        loggerInfoMock.mockReset();
        uploadMock.mockReset();
        downloadToBufferMock.mockReset();
        deleteIfExistsMock.mockReset();
        deleteBlobMock.mockReset();
        listBlobsFlatMock.mockReset();
    });

    it("emits structured fields for writeStaged", async () => {
        uploadMock.mockResolvedValue({});

        await createStore().writeStaged("proj-1", "repo-1", "src/example.ts", "content");

        expect(loggerInfoMock).toHaveBeenCalledWith("Blob staging operation completed", expect.objectContaining({
            blob_op: "writeStaged",
            repo_id: "repo-1",
            file_path: "src/example.ts",
            bytes: Buffer.byteLength("content"),
            duration_ms: expect.any(Number),
        }));
    });

    it("emits structured fields for readStaged", async () => {
        downloadToBufferMock.mockResolvedValue(Buffer.from("content"));

        await createStore().readStaged("proj-1", "repo-1", "src/example.ts");

        expect(loggerInfoMock).toHaveBeenCalledWith("Blob staging operation completed", expect.objectContaining({
            blob_op: "readStaged",
            repo_id: "repo-1",
            file_path: "src/example.ts",
            bytes: Buffer.byteLength("content"),
            duration_ms: expect.any(Number),
        }));
    });

    it("emits structured fields for deleteStaged", async () => {
        deleteIfExistsMock.mockResolvedValue({ succeeded: true });

        await createStore().deleteStaged("proj-1", "repo-1", "src/example.ts");

        expect(loggerInfoMock).toHaveBeenCalledWith("Blob staging operation completed", expect.objectContaining({
            blob_op: "deleteStaged",
            repo_id: "repo-1",
            file_path: "src/example.ts",
            bytes: 0,
            duration_ms: expect.any(Number),
        }));
    });

    it("emits structured fields for deleteAllStaged", async () => {
        listBlobsFlatMock.mockReturnValue(blobList(["repo-1/staged/src/example.ts"]));
        deleteBlobMock.mockResolvedValue({});

        await createStore().deleteAllStaged("proj-1", "repo-1");

        expect(loggerInfoMock).toHaveBeenCalledWith("Blob staging operation completed", expect.objectContaining({
            blob_op: "deleteAllStaged",
            repo_id: "repo-1",
            file_path: "*",
            bytes: 0,
            duration_ms: expect.any(Number),
        }));
    });
});
