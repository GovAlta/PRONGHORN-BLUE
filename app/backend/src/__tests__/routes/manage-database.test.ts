/**
 * Unit tests for manage-database function route connection selection.
 */
import express from "express";
import "express-async-errors";
import request from "supertest";
import functionsRouter from "../../routes/functions";
import { errorHandler } from "../../middleware/errorHandler";
import db, { getPoolClient } from "../../utils/database";
import * as rpc from "../../utils/rpcHelpers";
import { Client as PgClient } from "pg";

const mockDbQuery = db.query as jest.Mock;
const mockGetPoolClient = getPoolClient as jest.Mock;
const mockGetDatabaseWithToken = rpc.getDatabaseWithToken as jest.Mock;
const mockGetDbConnectionStringWithToken =
  rpc.getDbConnectionStringWithToken as jest.Mock;
const mockUpdateDbConnectionStatusWithToken =
  rpc.updateDbConnectionStatusWithToken as jest.Mock;
const mockPgClient = PgClient as unknown as jest.Mock;

jest.mock("../../utils/database", () => {
  const mockQuery = jest.fn();
  const mockGetPoolClient = jest.fn();
  return {
    __esModule: true,
    default: {
      query: mockQuery,
      healthCheck: jest.fn(),
      getActiveDbPort: jest.fn().mockReturnValue(5432),
      close: jest.fn(),
    },
    query: mockQuery,
    getPoolClient: mockGetPoolClient,
    queryWithPoolTarget: jest.fn(),
    getPoolForTarget: jest.fn(),
    getClient: jest.fn(),
    getActiveDbPort: jest.fn().mockReturnValue(5432),
    close: jest.fn(),
  };
});

jest.mock("../../utils/rpcHelpers", () => ({
  getDatabaseWithToken: jest.fn(),
  getDbConnectionStringWithToken: jest.fn(),
  updateDbConnectionStatusWithToken: jest.fn(),
}));

jest.mock("../../utils/logger", () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../../websocket", () => ({
  broadcast: jest.fn(),
}));

jest.mock("../../utils/githubAuth", () => ({
  resolveGitHubToken: jest.fn(),
  gitHubApiHeaders: jest.fn(),
  gitHubCloneUrl: jest.fn(),
  gitHubApiFetch: jest.fn(),
}));

jest.mock("../../utils/azureCredential", () => ({
  getAzureTokenForScope: jest.fn(),
  AzureScope: { ARM: "https://management.azure.com/.default" },
}));

const mockGetConnectionStringSecret = jest.fn();
jest.mock("../../services/deployment/docker/genappKeyVault", () => ({
  __esModule: true,
  getConnectionStringSecret: (...args: any[]) =>
    mockGetConnectionStringSecret(...args),
  setConnectionStringSecret: jest.fn(),
  deleteConnectionStringSecret: jest.fn(),
  ensureGenappKeyVault: jest.fn(),
  getGenappSecrets: jest.fn(),
  setGenappSecrets: jest.fn(),
}));

jest.mock("pg", () => ({
  Client: jest.fn(),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/functions", functionsRouter);
  app.use(errorHandler);
  return app;
}

function createPgClientMock(queryResult: any = { rows: [], fields: [] }) {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue(queryResult),
    end: jest.fn().mockResolvedValue(undefined),
  };
}

describe("POST /api/functions/manage-database", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses the GenApps pool factory for provisioned project databases", async () => {
    const poolClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    mockGetDatabaseWithToken.mockResolvedValue({
      id: "db-1111",
      project_id: "project-1",
      name: "Database Name",
      database_internal_name: "database_name",
      connection_string: null,
      has_connection_info: true,
      status: "available",
    });
    mockGetPoolClient.mockResolvedValue(poolClient);

    const res = await request(createApp())
      .post("/api/functions/manage-database")
      .send({
        action: "get_schema",
        databaseId: "db-1111",
        shareToken: "token-1",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { schemas: [] } });
    expect(mockGetPoolClient).toHaveBeenCalledWith({
      database: "database_name",
      server: "genapps",
    });
    expect(poolClient.release).toHaveBeenCalledTimes(1);
    expect(mockPgClient).not.toHaveBeenCalled();
  });

  it("looks up fallback connection rows with the display-derived database name", async () => {
    const pgClient = createPgClientMock({
      rows: [{ ok: 1 }],
      fields: [{ name: "ok" }],
    });
    mockPgClient.mockImplementation(() => pgClient);
    mockGetDatabaseWithToken.mockResolvedValue({
      id: "db-1111-2222",
      project_id: "project-1",
      name: "Sample API-9z8y",
      database_internal_name: null,
      connection_string: null,
      has_connection_info: false,
      status: "pending",
    });
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: "conn-9z8y", project_id: "project-1" }],
    });
    mockGetConnectionStringSecret.mockResolvedValue(
      "postgresql://user:pass@localhost:5432/sample_api_9z8y",
    );

    const res = await request(createApp())
      .post("/api/functions/manage-database")
      .send({
        action: "execute_sql",
        databaseId: "db-1111-2222",
        sql: "SELECT 1",
      });

    expect(res.status).toBe(200);
    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining("FROM project_database_connections"),
      ["project-1", "sample_api_9z8y"],
    );
    expect(mockGetPoolClient).not.toHaveBeenCalled();
    expect(pgClient.connect).toHaveBeenCalledTimes(1);
    expect(pgClient.query).toHaveBeenCalledWith("SELECT 1");
    expect(pgClient.end).toHaveBeenCalledTimes(1);
  });

  it("keeps external connection test actions on pg Client and updates connection status", async () => {
    const pgClient = createPgClientMock();
    mockPgClient.mockImplementation(() => pgClient);
    mockGetDbConnectionStringWithToken.mockResolvedValue(
      "postgresql://user:pass@localhost:5432/external_db?sslmode=require",
    );
    mockUpdateDbConnectionStatusWithToken.mockResolvedValue(undefined);

    const res = await request(createApp())
      .post("/api/functions/manage-database")
      .send({
        action: "test_connection",
        connectionId: "conn-1",
        shareToken: "token-1",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockGetPoolClient).not.toHaveBeenCalled();
    expect(mockPgClient).toHaveBeenCalledWith({
      connectionString:
        "postgresql://user:pass@localhost:5432/external_db?sslmode=require",
      ssl: { rejectUnauthorized: false },
    });
    expect(mockUpdateDbConnectionStatusWithToken).toHaveBeenCalledWith(
      "conn-1",
      "token-1",
      "connected",
      null,
    );
  });
});
