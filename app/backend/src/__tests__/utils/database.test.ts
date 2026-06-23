/**
 * Unit tests for the database utility module
 *
 * These tests validate the public API surface exported by utils/database.ts
 * with the underlying pg Pool fully mocked.
 */

export {};

// Collect pool constructor calls and expose mock helpers
const mockPoolQuery = jest.fn();
const mockPoolConnect = jest.fn();
const mockPoolEnd = jest.fn().mockResolvedValue(undefined);
const mockPoolOn = jest.fn();

jest.mock("pg", () => {
  return {
    Pool: jest.fn().mockImplementation(() => ({
      query: mockPoolQuery,
      connect: mockPoolConnect,
      end: mockPoolEnd,
      on: mockPoolOn,
    })),
  };
});

jest.mock("../../utils/logger", () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

// Use a fresh require for each test suite to reset module-level state
let dbModule: typeof import("../../utils/database");

beforeEach(() => {
  jest.clearAllMocks();
  // Re-require to reset module-level pool/activePort variables
  jest.resetModules();

  // Re-setup mocks after resetModules
  jest.doMock("pg", () => ({
    Pool: jest.fn().mockImplementation(() => ({
      query: mockPoolQuery,
      connect: mockPoolConnect,
      end: mockPoolEnd,
      on: mockPoolOn,
    })),
  }));

  jest.doMock("../../utils/logger", () => ({
    logger: {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    },
  }));

  dbModule = require("../../utils/database");
});

describe("query", () => {
  it("executes a SQL query and returns the result", async () => {
    const expectedResult = { rows: [{ id: 1 }], rowCount: 1 };
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }) // SELECT 1 (pool init)
      .mockResolvedValueOnce(expectedResult);

    const result = await dbModule.query("SELECT * FROM projects WHERE id = $1", ["p1"]);

    expect(result).toEqual(expectedResult);
  });

  it("throws when query text is empty", async () => {
    await expect(dbModule.query("")).rejects.toThrow("Query text is required.");
  });

  it("throws when query text is only whitespace", async () => {
    await expect(dbModule.query("   ")).rejects.toThrow("Query text is required.");
  });
});

describe("transaction", () => {
  it("commits on success", async () => {
    const mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }); // pool init
    mockPoolConnect.mockResolvedValue(mockClient);

    const result = await dbModule.transaction(async (client) => {
      await client.query("INSERT INTO test VALUES ($1)", [1]);
      return "done";
    });

    expect(result).toBe("done");
    expect(mockClient.query).toHaveBeenCalledWith("BEGIN");
    expect(mockClient.query).toHaveBeenCalledWith("COMMIT");
    expect(mockClient.release).toHaveBeenCalled();
  });

  it("rolls back on error and re-throws", async () => {
    const mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });
    mockPoolConnect.mockResolvedValue(mockClient);

    await expect(
      dbModule.transaction(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");

    expect(mockClient.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mockClient.release).toHaveBeenCalled();
  });

  it("throws when callback is not a function", async () => {
    await expect(dbModule.transaction(null as any)).rejects.toThrow("Transaction callback is required.");
  });
});

describe("healthCheck", () => {
  it("returns true when SELECT 1 succeeds", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ "?column?": 1 }] });

    const result = await dbModule.healthCheck();

    expect(result).toBe(true);
  });

  it("returns false when the query fails", async () => {
    // First call succeeds (pool init), second fails (health check)
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }] })
      .mockRejectedValueOnce(new Error("db down"));

    const result = await dbModule.healthCheck();

    expect(result).toBe(false);
  });
});

describe("getActiveDbPort", () => {
  it("returns null before any connection is established", () => {
    expect(dbModule.getActiveDbPort()).toBeNull();
  });

  it("returns the port after a successful connection", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ "?column?": 1 }] });

    await dbModule.query("SELECT 1");

    // Port should now be set (5432 is the first candidate)
    expect(dbModule.getActiveDbPort()).toBe(5432);
  });
});

describe("close", () => {
  it("ends the pool and resets active port", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ "?column?": 1 }] });

    // Initialize the pool
    await dbModule.query("SELECT 1");
    expect(dbModule.getActiveDbPort()).toBe(5432);

    await dbModule.close();

    expect(dbModule.getActiveDbPort()).toBeNull();
    expect(mockPoolEnd).toHaveBeenCalled();
  });
});
