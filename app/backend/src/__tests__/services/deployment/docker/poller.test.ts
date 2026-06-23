/**
 * Tests for the docker deployment poller (T014, US1).
 *
 * Happy-path tick only; stall-window, conclusion-failure, and run-id resolution
 * branches land under US4.
 */

const mockQuery = jest.fn();
jest.mock("../../../../utils/database", () => ({
  __esModule: true,
  default: { query: mockQuery },
}));

const mockLoggerDebug = jest.fn();
jest.mock("../../../../utils/logger", () => ({
  __esModule: true,
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: (...args: any[]) => (mockLoggerDebug as any)(...args),
  },
}));

const mockResolveGitHubToken = jest.fn();
jest.mock("../../../../utils/githubAuth", () => ({
  __esModule: true,
  resolveGitHubToken: (...args: unknown[]) => mockResolveGitHubToken(...args),
}));

const mockBroadcast = jest.fn();
jest.mock("../../../../websocket", () => ({
  __esModule: true,
  broadcast: (...args: unknown[]) => mockBroadcast(...args),
}));

const mockPollWorkflowStatus = jest.fn();
const mockFindWorkflowRunByAppId = jest.fn();
jest.mock(
  "../../../../services/deployment/docker/genappWorkflowClient",
  () => ({
    __esModule: true,
    pollWorkflowStatus: (...args: unknown[]) => mockPollWorkflowStatus(...args),
    findWorkflowRunByAppId: (...args: unknown[]) =>
      mockFindWorkflowRunByAppId(...args),
    dispatchGenappWorkflow: jest.fn(),
    pushTerraformTemplates: jest.fn(),
  }),
);

import { tickDockerDeploymentPoller } from "../../../../services/deployment/docker/poller";

const transitionalRow = {
  id: "dep-1",
  project_id: "proj-1",
  workflow_run_id: 42,
  azure_container_app_name: "dev-myapp-12345678",
  azure_resource_group: "rg-genapp-myapp-12345678-dev",
  dispatched_by_user_id: "user-1",
  dispatched_at: new Date().toISOString(),
  dispatched_action: "deploy",
  status: "building",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveGitHubToken.mockResolvedValue({
    token: "ghs",
    source: "github_app",
  });
});

describe("tickDockerDeploymentPoller — happy path (US1 AS2)", () => {
  it("acquires per-row advisory lock, polls, UPDATEs only on change, and broadcasts once", async () => {
    // 1: SELECT transitional rows
    // 2: BEGIN  (per-row transaction)
    // 3: pg_try_advisory_xact_lock → got=true
    // 4: UPDATE row → status='running' + url
    // 5: COMMIT
    mockQuery
      .mockResolvedValueOnce({ rows: [transitionalRow] }) // SELECT
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ got: true }] }) // advisory lock
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    mockPollWorkflowStatus.mockResolvedValueOnce({
      status: "running",
      conclusion: "success",
      url: "https://app.example.com",
    });

    await tickDockerDeploymentPoller();

    // Initial SELECT
    const selectSql = String(mockQuery.mock.calls[0][0]);
    expect(selectSql).toMatch(/SELECT/i);
    expect(selectSql).toMatch(/project_deployments/);
    expect(selectSql).toMatch(/'pending'/);
    expect(selectSql).toMatch(/'building'/);
    expect(selectSql).toMatch(/'deploying'/);

    // Advisory lock used pg_try_advisory_xact_lock
    const lockCall = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes("pg_try_advisory_xact_lock"),
    );
    expect(lockCall).toBeDefined();

    // pollWorkflowStatus was invoked with the row's run id + names (token is
    // minted internally from the GitHub App, not passed by the poller)
    expect(mockPollWorkflowStatus).toHaveBeenCalledTimes(1);
    const pollArgs = mockPollWorkflowStatus.mock.calls[0];
    expect(pollArgs[0]).toBe(42);
    expect(pollArgs[1]).toEqual({
      containerAppName: "dev-myapp-12345678",
      resourceGroup: "rg-genapp-myapp-12345678-dev",
    });
    expect(pollArgs[2]).toBeUndefined();

    // The UPDATE persists the new status and url
    const updateCall = mockQuery.mock.calls.find((c) => {
      const sql = String(c[0]);
      return (
        sql.includes("UPDATE project_deployments") && sql.includes("status")
      );
    });
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toEqual(
      expect.arrayContaining(["running", "https://app.example.com", "dep-1"]),
    );

    // Exactly one broadcast on the project's channel with action='status_updated'
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).toHaveBeenCalledWith(
      "deployments-proj-1",
      "deployment_refresh",
      expect.objectContaining({
        action: "status_updated",
        deploymentId: "dep-1",
        status: "running",
        url: "https://app.example.com",
      }),
    );
  });

  it("does not UPDATE or broadcast when the observed status is unchanged from the row's current status", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [transitionalRow] })
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ got: true }] }) // lock
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    mockPollWorkflowStatus.mockResolvedValueOnce({
      status: "building",
      conclusion: null,
      url: null,
    });

    await tickDockerDeploymentPoller();

    const updateCall = mockQuery.mock.calls.find((c) => {
      const sql = String(c[0]);
      return (
        sql.includes("UPDATE project_deployments") && sql.includes("status")
      );
    });
    expect(updateCall).toBeUndefined();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("skips the row and emits no UPDATE/broadcast when the advisory lock is held by another replica", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [transitionalRow] }) // SELECT
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ got: false }] }) // advisory lock denied
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    await tickDockerDeploymentPoller();

    expect(mockPollWorkflowStatus).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();

    // No UPDATE attempted under the skipped lock path
    const updateAttempt = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes("UPDATE project_deployments"),
    );
    expect(updateAttempt).toBeUndefined();
  });

  it("does nothing when the SELECT returns zero transitional rows", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await tickDockerDeploymentPoller();

    expect(mockPollWorkflowStatus).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
    // Only the SELECT happened — no BEGIN/COMMIT
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe("tickDockerDeploymentPoller — destroy convergence (US2, T025)", () => {
  const destroyRow = {
    ...transitionalRow,
    dispatched_action: "destroy",
  };

  it("transitions a destroy row to 'deleted' (not 'running') when the workflow concludes success", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [destroyRow] }) // SELECT
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ got: true }] }) // advisory lock
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    // Note: pollWorkflowStatus maps completed+success → 'running'; the
    // poller must override that mapping when the row was dispatched
    // for destroy.
    mockPollWorkflowStatus.mockResolvedValueOnce({
      status: "running",
      conclusion: "success",
      url: "https://ignored.example.com",
    });

    await tickDockerDeploymentPoller();

    const updateCall = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes("UPDATE project_deployments"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toEqual(
      expect.arrayContaining(["deleted", "dep-1"]),
    );
    // The destroy success path MUST NOT carry a url through.
    expect(updateCall![1]).not.toEqual(
      expect.arrayContaining(["https://ignored.example.com"]),
    );

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).toHaveBeenCalledWith(
      "deployments-proj-1",
      "deployment_refresh",
      expect.objectContaining({
        action: "status_updated",
        deploymentId: "dep-1",
        status: "deleted",
      }),
    );
  });

  it("leaves a deploy/create row untouched by the destroy override (status='running' still wins)", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ ...transitionalRow, dispatched_action: "deploy" }],
      })
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ got: true }] }) // lock
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    mockPollWorkflowStatus.mockResolvedValueOnce({
      status: "running",
      conclusion: "success",
      url: "https://app.example.com",
    });

    await tickDockerDeploymentPoller();

    const updateCall = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes("UPDATE project_deployments"),
    );
    expect(updateCall![1]).toEqual(
      expect.arrayContaining(["running", "https://app.example.com", "dep-1"]),
    );
  });
});

describe("tickDockerDeploymentPoller — failure surfacing (US4, T032)", () => {
  it("transitions a row past the stall window to 'failed' with last_failure_cause='stall-window-exceeded' (FR-007)", async () => {
    const oldDispatch = new Date(Date.now() - 31 * 60 * 1000).toISOString(); // 31m ago > 30m default
    const stalledRow = {
      ...transitionalRow,
      dispatched_at: oldDispatch,
    };

    mockQuery
      .mockResolvedValueOnce({ rows: [stalledRow] }) // SELECT
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ got: true }] }) // lock
      .mockResolvedValueOnce({ rows: [] }) // UPDATE → failed
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    await tickDockerDeploymentPoller();

    // pollWorkflowStatus must NOT be called once we detect stall.
    expect(mockPollWorkflowStatus).not.toHaveBeenCalled();

    const stallUpdate = mockQuery.mock.calls.find((c) => {
      const sql = String(c[0]);
      const params = (c[1] as unknown[]) ?? [];
      return (
        sql.includes("UPDATE project_deployments") &&
        sql.includes("last_failure_cause") &&
        params.includes("stall-window-exceeded")
      );
    });
    expect(stallUpdate).toBeDefined();
    expect(stallUpdate![1] as unknown[]).toEqual(
      expect.arrayContaining(["failed", "stall-window-exceeded", "dep-1"]),
    );

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).toHaveBeenCalledWith(
      "deployments-proj-1",
      "deployment_refresh",
      expect.objectContaining({
        action: "status_updated",
        status: "failed",
        lastFailureCause: "stall-window-exceeded",
      }),
    );
  });

  it("transitions a deploy row whose workflow conclusion is 'failure' to status='failed' with last_failure_cause='workflow-conclusion-failure' AND workflow_run_url (FR-008)", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [transitionalRow] })
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ got: true }] }) // lock
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    mockPollWorkflowStatus.mockResolvedValueOnce({
      status: "failed",
      conclusion: "failure",
      url: null,
      runUrl: "https://github.com/o/r/actions/runs/42",
    });

    await tickDockerDeploymentPoller();

    const failedUpdate = mockQuery.mock.calls.find((c) => {
      const sql = String(c[0]);
      const params = (c[1] as unknown[]) ?? [];
      return (
        sql.includes("UPDATE project_deployments") &&
        sql.includes("last_failure_cause") &&
        params.includes("workflow-conclusion-failure")
      );
    });
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate![1] as unknown[]).toEqual(
      expect.arrayContaining([
        "failed",
        "workflow-conclusion-failure",
        "https://github.com/o/r/actions/runs/42",
        "dep-1",
      ]),
    );

    expect(mockBroadcast).toHaveBeenCalledWith(
      "deployments-proj-1",
      "deployment_refresh",
      expect.objectContaining({
        status: "failed",
        lastFailureCause: "workflow-conclusion-failure",
        workflowRunUrl: "https://github.com/o/r/actions/runs/42",
      }),
    );
  });

  it("resolves the workflow_run_id via findWorkflowRunByAppId when missing AND dispatched_at is within the last 60s (D-2)", async () => {
    const recentDispatch = new Date(Date.now() - 10_000).toISOString(); // 10s ago
    const rowMissingRunId = {
      ...transitionalRow,
      workflow_run_id: null,
      dispatched_at: recentDispatch,
    };

    mockQuery
      .mockResolvedValueOnce({ rows: [rowMissingRunId] }) // SELECT
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ got: true }] }) // lock
      .mockResolvedValueOnce({ rows: [] }) // UPDATE workflow_run_id
      .mockResolvedValueOnce({ rows: [] }); // COMMIT (status unchanged → no post-poll UPDATE)

    mockFindWorkflowRunByAppId.mockResolvedValueOnce(777);
    mockPollWorkflowStatus.mockResolvedValueOnce({
      status: "building",
      conclusion: null,
      url: null,
      runUrl: null,
    });

    await tickDockerDeploymentPoller();

    expect(mockFindWorkflowRunByAppId).toHaveBeenCalledWith("dep-1");

    // The poller persists the resolved run id.
    const persistRunId = mockQuery.mock.calls.find((c) => {
      const sql = String(c[0]);
      const params = (c[1] as unknown[]) ?? [];
      return (
        sql.includes("UPDATE project_deployments") &&
        /SET\s+workflow_run_id\s*=\s*\$1/.test(sql) &&
        params.includes(777)
      );
    });
    expect(persistRunId).toBeDefined();
  });
});

describe("tickDockerDeploymentPoller — multi-replica advisory-lock skip (US5, T039)", () => {
  it("processes the row exactly once across two concurrent ticks (one acquires the lock, the other skips)", async () => {
    // Tick A: SELECT, BEGIN, lock=true, UPDATE, COMMIT
    // Tick B: SELECT, BEGIN, lock=false, COMMIT (no UPDATE, no broadcast)
    mockQuery
      // Tick A
      .mockResolvedValueOnce({ rows: [transitionalRow] }) // SELECT
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ got: true }] }) // lock acquired
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // COMMIT
      // Tick B
      .mockResolvedValueOnce({ rows: [transitionalRow] }) // SELECT
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ got: false }] }) // lock denied
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    mockPollWorkflowStatus.mockResolvedValueOnce({
      status: "running",
      conclusion: "success",
      url: "https://app.example.com",
      runUrl: null,
    });

    await tickDockerDeploymentPoller(); // Tick A
    await tickDockerDeploymentPoller(); // Tick B

    // Exactly one status-flip UPDATE total
    const statusUpdates = mockQuery.mock.calls.filter((c) => {
      const sql = String(c[0]);
      return (
        sql.includes("UPDATE project_deployments") && sql.includes("status")
      );
    });
    expect(statusUpdates).toHaveLength(1);

    // Exactly one broadcast total (SC-008 / FR-017)
    expect(mockBroadcast).toHaveBeenCalledTimes(1);

    // Tick B logged the skip at debug level
    const skipLog = mockLoggerDebug.mock.calls.find((args) =>
      String(args[0] ?? "").includes("skipped (lock not acquired)"),
    );
    expect(skipLog).toBeDefined();
    expect(String(skipLog![0])).toContain("dep-1");
  });
});

describe("tickDockerDeploymentPoller — destroy-failure attribution (US6, T043)", () => {
  it("marks a destroy row failed with last_failure_cause='workflow-conclusion-failure-destroy' AND workflow_run_url when the destroy workflow concludes failure", async () => {
    const destroyRow = {
      ...transitionalRow,
      dispatched_action: "destroy",
    };

    mockQuery
      .mockResolvedValueOnce({ rows: [destroyRow] }) // SELECT
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ got: true }] }) // lock
      .mockResolvedValueOnce({ rows: [] }) // UPDATE → failed
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    mockPollWorkflowStatus.mockResolvedValueOnce({
      status: "failed",
      conclusion: "failure",
      url: null,
      runUrl: "https://github.com/o/r/actions/runs/42",
    });

    await tickDockerDeploymentPoller();

    const failedUpdate = mockQuery.mock.calls.find((c) => {
      const sql = String(c[0]);
      const params = (c[1] as unknown[]) ?? [];
      return (
        sql.includes("UPDATE project_deployments") &&
        sql.includes("last_failure_cause") &&
        params.includes("workflow-conclusion-failure-destroy")
      );
    });
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate![1] as unknown[]).toEqual(
      expect.arrayContaining([
        "failed",
        "workflow-conclusion-failure-destroy",
        "https://github.com/o/r/actions/runs/42",
        "dep-1",
      ]),
    );

    expect(mockBroadcast).toHaveBeenCalledWith(
      "deployments-proj-1",
      "deployment_refresh",
      expect.objectContaining({
        status: "failed",
        lastFailureCause: "workflow-conclusion-failure-destroy",
        workflowRunUrl: "https://github.com/o/r/actions/runs/42",
      }),
    );
  });
});
