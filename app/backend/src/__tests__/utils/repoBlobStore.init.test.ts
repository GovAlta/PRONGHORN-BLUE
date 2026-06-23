const mockCredential = { getToken: jest.fn() };
const mockBlobServiceClient = jest.fn();

jest.mock("@azure/storage-blob", () => ({
    BlobServiceClient: mockBlobServiceClient,
}));

jest.mock("@azure/identity", () => ({
    DefaultAzureCredential: jest.fn(() => mockCredential),
}));

import {
    getRepoBlobStore,
    initRepoBlobStore,
    resetRepoBlobStoreForTests,
} from "../../utils/repoBlobStore";

describe("RepoBlobStore initialization", () => {
    beforeEach(() => {
        mockBlobServiceClient.mockReset();
        mockCredential.getToken.mockReset();
        resetRepoBlobStoreForTests();
        delete process.env.AZURE_STORAGE_ACCOUNT_NAME;
        delete process.env.REPO_FILES_BLOB_CONTAINER;
    });

    it("fails fast when AZURE_STORAGE_ACCOUNT_NAME is missing", () => {
        expect(() => initRepoBlobStore()).toThrow("AZURE_STORAGE_ACCOUNT_NAME is required");
    });

    it("surfaces blob client initialization errors", () => {
        process.env.AZURE_STORAGE_ACCOUNT_NAME = "repofilesaccount";
        mockBlobServiceClient.mockImplementationOnce(() => {
            throw new Error("Blob client initialization failed");
        });

        expect(() => initRepoBlobStore()).toThrow("Blob client initialization failed");
    });

    it("initializes once and returns the same store on repeated calls", () => {
        process.env.AZURE_STORAGE_ACCOUNT_NAME = "repofilesaccount";
        process.env.REPO_FILES_BLOB_CONTAINER = "generated-apps-files";
        mockBlobServiceClient.mockReturnValue({
            getContainerClient: jest.fn(),
        });

        const firstStore = initRepoBlobStore();
        const secondStore = initRepoBlobStore();

        expect(secondStore).toBe(firstStore);
        expect(getRepoBlobStore()).toBe(firstStore);
        expect(mockBlobServiceClient).toHaveBeenCalledTimes(1);
        expect(mockBlobServiceClient).toHaveBeenCalledWith(
            "https://repofilesaccount.blob.core.windows.net",
            mockCredential,
        );
    });

    it("throws when accessing the store before initialization", () => {
        expect(() => getRepoBlobStore()).toThrow("Blob staging store has not been initialized");
    });
});
