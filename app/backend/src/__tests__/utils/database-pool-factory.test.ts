/**
 * Unit tests for the pool factory in utils/database.ts
 *
 * Validates getPoolForTarget, queryWithPoolTarget, and getPoolClient
 * with the underlying pg Pool fully mocked.
 */

export {};

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

let dbModule: typeof import("../../utils/database");

beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    // Set minimal env vars for Application server
    process.env.POSTGRES_HOST = "localhost";
    process.env.POSTGRES_PORT = "5432";
    process.env.POSTGRES_USER = "test_user";
    process.env.POSTGRES_PASSWORD = "test_pass";
    process.env.POSTGRES_DATABASE = "pronghorn";
    process.env.POSTGRES_SSL = "false";

    // Clean Generated Applications env vars between tests
    delete process.env.POSTGRES_GENAPPS_HOST;
    delete process.env.POSTGRES_GENAPPS_PORT;
    delete process.env.POSTGRES_GENAPPS_USER;
    delete process.env.POSTGRES_GENAPPS_PASSWORD;
    delete process.env.POSTGRES_GENAPPS_SSL;

    // Re-require to reset module-level state
    dbModule = require("../../utils/database");
});

describe("Pool Factory", () => {
    describe("getPoolForTarget", () => {
        it("creates a pool for a given database target", async () => {
            const { Pool } = require("pg");
            mockPoolQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 });

            // Initialize main pool first so activePort is set
            await dbModule.getPoolForTarget({ database: "proj_abc123" });

            expect(Pool).toHaveBeenCalledWith(
                expect.objectContaining({
                    database: "proj_abc123",
                    host: "localhost",
                })
            );
        });

        it("reuses cached pool for same database target", async () => {
            const { Pool } = require("pg");

            const pool1 = await dbModule.getPoolForTarget({ database: "proj_abc123" });
            const pool2 = await dbModule.getPoolForTarget({ database: "proj_abc123" });

            // Pool constructor should be called only once for the factory target
            // (main pool constructor is separate)
            const factoryCalls = (Pool as jest.Mock).mock.calls.filter(
                (call: any[]) => call[0]?.database === "proj_abc123"
            );
            expect(factoryCalls).toHaveLength(1);
            expect(pool1).toBe(pool2);
        });

        it("creates separate pools for different database targets", async () => {
            const { Pool } = require("pg");

            await dbModule.getPoolForTarget({ database: "proj_aaa" });
            await dbModule.getPoolForTarget({ database: "proj_bbb" });

            const factoryCallDbs = (Pool as jest.Mock).mock.calls
                .map((call: any[]) => call[0]?.database)
                .filter((db: string) => db?.startsWith("proj_"));

            expect(factoryCallDbs).toContain("proj_aaa");
            expect(factoryCallDbs).toContain("proj_bbb");
        });

        it("throws when database is empty", async () => {
            await expect(
                dbModule.getPoolForTarget({ database: "" })
            ).rejects.toThrow("PoolTarget.database is required");
        });

        it("throws when target is null/undefined", async () => {
            await expect(
                dbModule.getPoolForTarget(null as any)
            ).rejects.toThrow("PoolTarget.database is required");
        });
    });

    describe("queryWithPoolTarget", () => {
        it("executes a query against the target database pool", async () => {
            const mockResult = { rows: [{ id: 1 }], rowCount: 1 };
            mockPoolQuery.mockReset();
            mockPoolQuery.mockResolvedValue(mockResult);

            const result = await dbModule.queryWithPoolTarget(
                { database: "proj_test" },
                "SELECT * FROM users WHERE id = $1",
                [1]
            );

            expect(mockPoolQuery).toHaveBeenCalledWith("SELECT * FROM users WHERE id = $1", [1]);
            expect(result.rows).toEqual(mockResult.rows);
            expect(result.rowCount).toBe(1);
        });

        it("throws when query text is empty", async () => {
            await expect(
                dbModule.queryWithPoolTarget({ database: "proj_test" }, "", [])
            ).rejects.toThrow("Query text is required.");
        });
    });

    describe("getPoolClient", () => {
        it("returns a client from the target pool", async () => {
            const mockClient = { query: jest.fn(), release: jest.fn() };
            mockPoolConnect.mockResolvedValueOnce(mockClient);

            const client = await dbModule.getPoolClient({ database: "proj_test" });

            expect(mockPoolConnect).toHaveBeenCalled();
            expect(client).toBe(mockClient);
        });
    });

    describe("Dual-server routing (server: genapps)", () => {
        it("creates a pool with POSTGRES_GENAPPS_* env vars when server is genapps", async () => {
            process.env.POSTGRES_GENAPPS_HOST = "genapps-host";
            process.env.POSTGRES_GENAPPS_PORT = "5433";
            process.env.POSTGRES_GENAPPS_USER = "genapps_user";
            process.env.POSTGRES_GENAPPS_PASSWORD = "genapps_pass";
            process.env.POSTGRES_GENAPPS_SSL = "false";

            // Re-require to pick up env changes
            jest.resetModules();
            dbModule = require("../../utils/database");
            const { Pool } = require("pg");

            await dbModule.getPoolForTarget({ database: "proj_abc", server: "genapps" });

            expect(Pool).toHaveBeenCalledWith(
                expect.objectContaining({
                    database: "proj_abc",
                    host: "genapps-host",
                    port: 5433,
                    user: "genapps_user",
                    password: "genapps_pass",
                })
            );
        });

        it("falls back to POSTGRES_* vars when POSTGRES_GENAPPS_* are not set", async () => {
            const { Pool } = require("pg");

            // No POSTGRES_GENAPPS_* vars set — should fall back to POSTGRES_*
            await dbModule.getPoolForTarget({ database: "proj_fallback", server: "genapps" });

            expect(Pool).toHaveBeenCalledWith(
                expect.objectContaining({
                    database: "proj_fallback",
                    host: "localhost",
                    user: "test_user",
                    password: "test_pass",
                })
            );
        });

        it("uses POSTGRES_GENAPPS_SSL for SSL configuration", async () => {
            process.env.POSTGRES_GENAPPS_HOST = "ssl-host";
            process.env.POSTGRES_GENAPPS_SSL = "true";

            jest.resetModules();
            dbModule = require("../../utils/database");
            const { Pool } = require("pg");

            await dbModule.getPoolForTarget({ database: "proj_ssl", server: "genapps" });

            expect(Pool).toHaveBeenCalledWith(
                expect.objectContaining({
                    database: "proj_ssl",
                    host: "ssl-host",
                    ssl: { rejectUnauthorized: false },
                })
            );
        });

        it("falls back POSTGRES_SSL when POSTGRES_GENAPPS_SSL is unset", async () => {
            process.env.POSTGRES_SSL = "true";
            // POSTGRES_GENAPPS_SSL is not set — should fall back to POSTGRES_SSL

            jest.resetModules();
            dbModule = require("../../utils/database");
            const { Pool } = require("pg");

            await dbModule.getPoolForTarget({ database: "proj_ssl_fb", server: "genapps" });

            expect(Pool).toHaveBeenCalledWith(
                expect.objectContaining({
                    database: "proj_ssl_fb",
                    ssl: { rejectUnauthorized: false },
                })
            );
        });

        it("caches pools separately for app and genapps servers", async () => {
            process.env.POSTGRES_GENAPPS_HOST = "genapps-host";

            jest.resetModules();
            dbModule = require("../../utils/database");
            const { Pool } = require("pg");

            const appPool = await dbModule.getPoolForTarget({ database: "proj_x", server: "app" });
            const genappsPool = await dbModule.getPoolForTarget({ database: "proj_x", server: "genapps" });

            // Same database name on different servers should create separate pools
            expect(appPool).not.toBe(genappsPool);

            const factoryCalls = (Pool as jest.Mock).mock.calls.filter(
                (call: any[]) => call[0]?.database === "proj_x"
            );
            expect(factoryCalls).toHaveLength(2);
        });

        it("reuses cached pool for same server + database combination", async () => {
            const { Pool } = require("pg");

            const pool1 = await dbModule.getPoolForTarget({ database: "proj_y", server: "genapps" });
            const pool2 = await dbModule.getPoolForTarget({ database: "proj_y", server: "genapps" });

            expect(pool1).toBe(pool2);

            const factoryCalls = (Pool as jest.Mock).mock.calls.filter(
                (call: any[]) => call[0]?.database === "proj_y"
            );
            expect(factoryCalls).toHaveLength(1);
        });

        it("defaults to app server when server is omitted", async () => {
            const pool1 = await dbModule.getPoolForTarget({ database: "proj_z" });
            const pool2 = await dbModule.getPoolForTarget({ database: "proj_z", server: "app" });

            // Omitting server and specifying 'app' should return the same cached pool
            expect(pool1).toBe(pool2);
        });

        it("queryWithPoolTarget passes server to getPoolForTarget", async () => {
            const mockResult = { rows: [{ id: 1 }], rowCount: 1 };
            mockPoolQuery.mockReset();
            mockPoolQuery.mockResolvedValue(mockResult);

            process.env.POSTGRES_GENAPPS_HOST = "genapps-query-host";

            jest.resetModules();
            dbModule = require("../../utils/database");
            const { Pool } = require("pg");

            const result = await dbModule.queryWithPoolTarget(
                { database: "proj_q", server: "genapps" },
                "SELECT 1"
            );

            expect(result.rows).toEqual(mockResult.rows);

            const genappsCalls = (Pool as jest.Mock).mock.calls.filter(
                (call: any[]) => call[0]?.database === "proj_q" && call[0]?.host === "genapps-query-host"
            );
            expect(genappsCalls).toHaveLength(1);
        });

        it("getPoolClient uses genapps server when specified", async () => {
            const mockClient = { query: jest.fn(), release: jest.fn() };
            mockPoolConnect.mockResolvedValueOnce(mockClient);

            process.env.POSTGRES_GENAPPS_HOST = "genapps-client-host";

            jest.resetModules();
            dbModule = require("../../utils/database");

            const client = await dbModule.getPoolClient({ database: "postgres", server: "genapps" });

            expect(client).toBe(mockClient);

            const { Pool } = require("pg");
            const genappsCalls = (Pool as jest.Mock).mock.calls.filter(
                (call: any[]) => call[0]?.database === "postgres" && call[0]?.host === "genapps-client-host"
            );
            expect(genappsCalls).toHaveLength(1);
        });
    });
});
