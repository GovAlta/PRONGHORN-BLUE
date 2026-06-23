/**
 * Unit tests for rpcHelpers utility functions
 */

// Mock the database module before importing rpcHelpers
const mockQuery = jest.fn();
jest.mock("../../utils/database", () => ({
  __esModule: true,
  default: {
    query: mockQuery,
  },
}));

jest.mock("../../utils/logger", () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

import {
  getProjectWithToken,
  getProjectReposWithToken,
  getDatabaseWithToken,
  getRequirementsWithToken,
  getCanvasNodesWithToken,
  getCanvasEdgesWithToken,
  insertRequirementWithToken,
  updateRequirementWithToken,
  getRepoFilesWithToken,
  getStagedChangesWithToken,
  authorizeProjectAccess,
  requireRole,
  validateProjectAccess,
  getProjectInventoryWithToken,
  getProjectCategoryWithToken,
} from "../../utils/rpcHelpers";

beforeEach(() => {
  mockQuery.mockReset();
});

describe("getProjectWithToken", () => {
  it("fetches project by id when no token is provided", async () => {
    const project = { id: "p1", name: "Test" };
    mockQuery.mockResolvedValue({ rows: [project] });

    const result = await getProjectWithToken("p1");

    expect(result).toEqual(project);
    expect(mockQuery).toHaveBeenCalledWith("SELECT * FROM projects WHERE id = $1", ["p1"]);
  });

  it("validates share token and returns project when token matches", async () => {
    const project = { id: "p1", name: "Shared" };
    mockQuery
      .mockResolvedValueOnce({ rows: [project] })   // SELECT with token
      .mockResolvedValueOnce({ rows: [] });          // UPDATE last_used_at

    const result = await getProjectWithToken("p1", "valid-token");

    expect(result).toEqual(project);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("returns null when token does not match", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await getProjectWithToken("p1", "bad-token");

    expect(result).toBeNull();
  });

  it("returns null when project does not exist", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await getProjectWithToken("nonexistent");

    expect(result).toBeNull();
  });
});

describe("getProjectReposWithToken", () => {
  it("returns repos ordered by is_prime DESC", async () => {
    const repos = [{ id: "r1", is_prime: true }, { id: "r2", is_prime: false }];
    mockQuery.mockResolvedValue({ rows: repos });

    const result = await getProjectReposWithToken("p1");

    expect(result).toEqual(repos);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("ORDER BY is_prime DESC"),
      ["p1"],
    );
  });
});

describe("getDatabaseWithToken", () => {
  it("returns database record by id", async () => {
    const db = { id: "d1", name: "mydb" };
    mockQuery.mockResolvedValue({ rows: [db] });

    const result = await getDatabaseWithToken("d1");

    expect(result).toEqual(db);
  });

  it("returns null when not found", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await getDatabaseWithToken("nonexistent");

    expect(result).toBeNull();
  });
});

describe("getRequirementsWithToken", () => {
  it("returns requirements ordered by order_index", async () => {
    const reqs = [
      { id: "r1", order_index: 0 },
      { id: "r2", order_index: 1 },
    ];
    mockQuery.mockResolvedValue({ rows: reqs });

    const result = await getRequirementsWithToken("p1");

    expect(result).toEqual(reqs);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("ORDER BY order_index ASC"),
      ["p1"],
    );
  });
});

describe("getCanvasNodesWithToken / getCanvasEdgesWithToken", () => {
  it("returns canvas nodes for a project", async () => {
    const nodes = [{ id: "n1", type: "TASK" }];
    mockQuery.mockResolvedValue({ rows: nodes });

    expect(await getCanvasNodesWithToken("p1")).toEqual(nodes);
  });

  it("returns canvas edges for a project", async () => {
    const edges = [{ id: "e1", source: "n1", target: "n2" }];
    mockQuery.mockResolvedValue({ rows: edges });

    expect(await getCanvasEdgesWithToken("p1")).toEqual(edges);
  });
});

describe("insertRequirementWithToken", () => {
  it("inserts a top-level requirement with correct order_index", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ next_order: 3 }] })   // order query
      .mockResolvedValueOnce({ rows: [{ id: "req-new", title: "New Req" }] }); // insert

    const result = await insertRequirementWithToken("p1", null, null, "FUNCTIONAL", "New Req");

    expect(result).toEqual(expect.objectContaining({ id: "req-new", title: "New Req" }));
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("inserts a child requirement when parentId is provided", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ next_order: 0 }] })
      .mockResolvedValueOnce({ rows: [{ id: "child", title: "Child" }] });

    const result = await insertRequirementWithToken("p1", null, "parent-1", "TASK", "Child");

    expect(result?.title).toBe("Child");
    // Order query should include parent_id
    expect(mockQuery.mock.calls[0][1]).toContain("parent-1");
  });
});

describe("updateRequirementWithToken", () => {
  it("updates requirement title and content", async () => {
    const updated = { id: "r1", title: "Updated", content: "New content" };
    mockQuery.mockResolvedValue({ rows: [updated] });

    const result = await updateRequirementWithToken("r1", null, "Updated", "New content");

    expect(result).toEqual(updated);
  });

  it("returns null when requirement not found", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await updateRequirementWithToken("nonexistent", null, "X");

    expect(result).toBeNull();
  });
});

describe("getRepoFilesWithToken", () => {
  it("returns all files when no filter is specified", async () => {
    const files = [{ id: "f1", path: "src/main.ts" }];
    mockQuery.mockResolvedValue({ rows: files });

    const result = await getRepoFilesWithToken("r1");

    expect(result).toEqual(files);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("ORDER BY path"),
      ["r1"],
    );
  });

  it("filters by file paths when provided", async () => {
    const files = [{ id: "f1", path: "src/main.ts" }];
    mockQuery.mockResolvedValue({ rows: files });

    const result = await getRepoFilesWithToken("r1", null, ["src/main.ts"]);

    expect(result).toEqual(files);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("ANY($2)"),
      ["r1", ["src/main.ts"]],
    );
  });
});

describe("getStagedChangesWithToken", () => {
  it("returns staged changes ordered by created_at", async () => {
    const staged = [{ id: "s1", file_path: "a.ts" }];
    mockQuery.mockResolvedValue({ rows: staged });

    const result = await getStagedChangesWithToken("r1");

    expect(result).toEqual(staged);
  });
});

describe("authorizeProjectAccess", () => {
  it("returns role from token when valid", async () => {
    mockQuery.mockResolvedValue({ rows: [{ role: "editor" }] });

    const role = await authorizeProjectAccess("p1", "valid-token");

    expect(role).toBe("editor");
  });

  it("returns owner when project exists but no token", async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: "p1" }] });

    const role = await authorizeProjectAccess("p1");

    expect(role).toBe("owner");
  });

  it("throws when project does not exist and no valid token", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await expect(authorizeProjectAccess("nonexistent")).rejects.toThrow("Access denied");
  });
});

describe("requireRole", () => {
  it("returns role when it meets the minimum level", async () => {
    mockQuery.mockResolvedValue({ rows: [{ role: "owner" }] });

    const role = await requireRole("p1", "token", "editor");

    expect(role).toBe("owner");
  });

  it("throws when role is below the minimum level", async () => {
    mockQuery.mockResolvedValue({ rows: [{ role: "viewer" }] });

    await expect(requireRole("p1", "token", "editor")).rejects.toThrow("Insufficient permissions");
  });
});

describe("validateProjectAccess", () => {
  it("returns true when access is valid", async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: "p1" }] });

    const result = await validateProjectAccess("p1");

    expect(result).toBe(true);
  });

  it("returns false when access is denied", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await validateProjectAccess("nonexistent");

    expect(result).toBe(false);
  });
});

describe("getProjectInventoryWithToken", () => {
  it("returns count aggregates for a project", async () => {
    const counts = {
      requirements_count: 5,
      canvas_nodes_count: 10,
      artifacts_count: 3,
    };
    mockQuery.mockResolvedValue({ rows: [counts] });

    const result = await getProjectInventoryWithToken("p1");

    expect(result).toEqual(counts);
  });

  it("returns empty object when query returns no rows", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await getProjectInventoryWithToken("p1");

    expect(result).toEqual({});
  });
});

describe("getProjectCategoryWithToken", () => {
  it("returns data for a known category", async () => {
    const reqs = [{ id: "r1", title: "Req 1" }];
    mockQuery.mockResolvedValue({ rows: reqs });

    const result = await getProjectCategoryWithToken("p1", "requirements");

    expect(result).toEqual(reqs);
  });

  it("returns empty array for an unknown category", async () => {
    const result = await getProjectCategoryWithToken("p1", "unknown_category");

    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
