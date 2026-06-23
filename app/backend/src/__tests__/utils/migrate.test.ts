/**
 * Unit tests for the MigrationRunner utility
 */
import { MigrationRunner } from "../../utils/migrate";

// Mock pg Pool
const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn().mockResolvedValue({
  query: mockQuery,
  release: mockRelease,
});
const mockEnd = jest.fn().mockResolvedValue(undefined);

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    end: mockEnd,
  })),
}));

// Mock fs
jest.mock("fs", () => ({
  existsSync: jest.fn().mockReturnValue(true),
  readdirSync: jest.fn().mockReturnValue(["001_init.sql", "002_seed.sql"]),
  readFileSync: jest.fn().mockReturnValue("SELECT 1;"),
}));

// Suppress console output
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
beforeAll(() => {
  console.log = jest.fn();
  console.warn = jest.fn();
  console.error = jest.fn();
});
afterAll(() => {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
});

beforeEach(() => {
  jest.clearAllMocks();
  // Default: SELECT 1 succeeds for connection test
  mockQuery.mockResolvedValue({ rows: [] });
});

describe("MigrationRunner", () => {
  describe("constructor", () => {
    it("should use defaults when no options provided", () => {
      const runner = new MigrationRunner();
      expect(runner).toBeDefined();
    });

    it("should accept custom options", () => {
      const runner = new MigrationRunner({
        host: "custom-host",
        port: 5433,
        database: "custom-db",
      });
      expect(runner).toBeDefined();
    });
  });

  describe("connect", () => {
    it("should connect to the database", async () => {
      const runner = new MigrationRunner();
      await runner.connect();
      expect(mockConnect).toHaveBeenCalled();
      expect(mockQuery).toHaveBeenCalledWith("SELECT 1");
      expect(mockRelease).toHaveBeenCalled();
    });
  });

  describe("disconnect", () => {
    it("should close the pool", async () => {
      const runner = new MigrationRunner();
      await runner.connect();
      await runner.disconnect();
      expect(mockEnd).toHaveBeenCalled();
    });

    it("should be a no-op when not connected", async () => {
      const runner = new MigrationRunner();
      await runner.disconnect();
      expect(mockEnd).not.toHaveBeenCalled();
    });
  });

  describe("runMigrations", () => {
    it("should execute pending migrations", async () => {
      // getExecutedMigrations returns none executed
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // SELECT 1 (connect)
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // CREATE TABLE _migrations
        .mockResolvedValueOnce({ rows: [] }) // SELECT executed migrations
        .mockResolvedValueOnce({ rows: [] }) // Execute 001_init.sql
        .mockResolvedValueOnce({ rows: [] }) // Record migration 001
        .mockResolvedValueOnce({ rows: [] }) // Execute 002_seed.sql
        .mockResolvedValueOnce({ rows: [] }) // Record migration 002
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const runner = new MigrationRunner();
      const result = await runner.runMigrations();
      expect(result.success).toBe(true);
      expect(result.filesExecuted).toEqual(["001_init.sql", "002_seed.sql"]);
      expect(result.errors).toEqual([]);
    });

    it("should skip already executed migrations", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // SELECT 1 (connect)
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // CREATE TABLE _migrations
        .mockResolvedValueOnce({ rows: [{ filename: "001_init.sql" }] }) // Already executed
        .mockResolvedValueOnce({ rows: [] }) // Execute 002_seed.sql
        .mockResolvedValueOnce({ rows: [] }) // Record migration 002
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const runner = new MigrationRunner();
      const result = await runner.runMigrations();
      expect(result.success).toBe(true);
      expect(result.filesExecuted).toEqual(["002_seed.sql"]);
    });

    it("should rollback on error", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // SELECT 1 (connect)
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // CREATE TABLE _migrations
        .mockResolvedValueOnce({ rows: [] }) // SELECT executed migrations
        .mockRejectedValueOnce(new Error("SQL syntax error")) // Execute 001 fails
        .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

      const runner = new MigrationRunner();
      const result = await runner.runMigrations();
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("getStatus", () => {
    it("should return pending and executed migrations", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // SELECT 1 (connect)
        .mockResolvedValueOnce({ rows: [] }) // CREATE TABLE _migrations
        .mockResolvedValueOnce({
          rows: [{ filename: "001_init.sql", executed_at: new Date(), execution_time_ms: 100 }],
        }); // SELECT executed

      const runner = new MigrationRunner();
      const status = await runner.getStatus();
      expect(status.executed).toHaveLength(1);
      expect(status.pending).toEqual(["002_seed.sql"]);
    });
  });
});
