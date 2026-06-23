/**
 * Behaviour-pinning tests for the relocated genapp workflow client.
 *
 * The relocation (`utils/genappDeploy.ts` → `services/deployment/docker/genappWorkflowClient.ts`)
 * is a pure move with type tightening. These tests document the runtime
 * contract so a future refactor can prove it has not drifted.
 */

jest.mock("../../../../utils/azureCredential", () => ({
  __esModule: true,
  AzureScope: { ARM: "arm" },
  getAzureTokenForScope: jest.fn(),
}));

jest.mock("../../../../utils/logger", () => ({
  __esModule: true,
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockIsGitHubAppConfigured = jest.fn();
const mockGetInstallationToken = jest.fn();
jest.mock("../../../../utils/githubAppAuth", () => ({
  __esModule: true,
  isGitHubAppConfigured: (...args: unknown[]) =>
    mockIsGitHubAppConfigured(...args),
  getInstallationToken: (...args: unknown[]) =>
    mockGetInstallationToken(...args),
}));

import {
  dispatchGenappWorkflow,
  findWorkflowRunByAppId,
  pollWorkflowStatus,
} from "../../../../services/deployment/docker/genappWorkflowClient";

const originalFetch = global.fetch;
let fetchMock: jest.Mock;

const makeResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
    headers: {
      get: (_name: string): string | null => null,
    },
  }) as unknown as Response;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  // Default: GitHub App configured and minting an installation token.
  mockIsGitHubAppConfigured.mockReturnValue(true);
  mockGetInstallationToken.mockResolvedValue("ghs_token");
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

describe("dispatchGenappWorkflow", () => {
  it("POSTs to the workflow dispatch URL embedding genapp-deploy.yml and the configured org/repo", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(204, "")); // dispatch
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { workflow_runs: [{ id: 999 }] }),
    ); // findWorkflowRunByAppId

    const runId = await dispatchGenappWorkflow({
      appId: "app-1",
      appName: "myapp",
      resourceGroup: "rg-genapp-myapp-app1-dev",
      repoUrl: "https://github.com/o/r",
      branch: "main",
      dockerfilePath: "Dockerfile",
      environment: "dev",
      action: "create",
      keyVaultName: "kv-ga-0123456789abcdef01",
      keyVaultResourceGroup: "Pronghorn-App",
      port: 3000,
    });

    expect(runId).toBe(999);
    // Pre-dispatch probes (repo, workflow file) then the dispatch POST.
    const dispatchCall = fetchMock.mock.calls.find((c: any[]) =>
      String(c[0]).includes("/actions/workflows/genapp-deploy.yml/dispatches"),
    );
    expect(dispatchCall).toBeDefined();
    const [url, init] = dispatchCall as [string, RequestInit];
    expect(url).toContain("/actions/workflows/genapp-deploy.yml/dispatches");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer ghs_token",
    );
    const parsed = JSON.parse((init.body as string) ?? "{}");
    expect(parsed.ref).toBe("main");
    expect(parsed.inputs.action).toBe("create");
    expect(parsed.inputs.app_id).toBe("app-1");
    expect(parsed.inputs.resource_group).toBe("rg-genapp-myapp-app1-dev");
    expect(parsed.inputs.key_vault_name).toBe("kv-ga-0123456789abcdef01");
    expect(parsed.inputs.key_vault_resource_group).toBe("Pronghorn-App");
    expect(parsed.inputs.env_vars).toBeUndefined();
  });

  it("throws when the GitHub App is not configured", async () => {
    mockIsGitHubAppConfigured.mockReturnValue(false);
    await expect(
      dispatchGenappWorkflow({
        appId: "a",
        appName: "n",
        resourceGroup: "rg",
        repoUrl: "u",
        branch: "main",
        dockerfilePath: "Dockerfile",
        environment: "dev",
        action: "deploy",
        keyVaultName: "kv-ga-0123456789abcdef01",
        keyVaultResourceGroup: "Pronghorn-App",
        port: 8080,
      }),
    ).rejects.toThrow(/GitHub App is not configured/);
  });

  it("throws when dispatch HTTP fails", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(422, "bad inputs"));

    await expect(
      dispatchGenappWorkflow({
        appId: "a",
        appName: "n",
        resourceGroup: "rg",
        repoUrl: "u",
        branch: "main",
        dockerfilePath: "Dockerfile",
        environment: "dev",
        action: "deploy",
        keyVaultName: "kv-ga-0123456789abcdef01",
        keyVaultResourceGroup: "Pronghorn-App",
        port: 8080,
      }),
    ).rejects.toThrow(/Workflow dispatch failed: 422/);
  });
});

describe("findWorkflowRunByAppId", () => {
  it("returns 0 when no run matches", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { workflow_runs: [] }));

    const id = await findWorkflowRunByAppId("app-id");
    expect(id).toBe(0);
  });

  it("returns 0 when the GitHub App is not configured", async () => {
    mockIsGitHubAppConfigured.mockReturnValue(false);
    const id = await findWorkflowRunByAppId("app-id");
    expect(id).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the resolved run id when a run matches the app_id filter window", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        workflow_runs: [{ id: 12345 }, { id: 12344 }],
      }),
    );

    const id = await findWorkflowRunByAppId("app-id");
    expect(id).toBe(12345);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("/actions/workflows/genapp-deploy.yml/runs");
    expect(url).toContain("per_page=5");
    // The dispatch helper uses an unencoded '>' in the created filter (matches
    // the existing behaviour of utils/genappDeploy.ts pre-relocation).
    expect(url).toContain("created=>");
  });

  it("returns 0 when the GitHub list-runs API responds non-200", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(500, "boom"));
    const id = await findWorkflowRunByAppId("app-id");
    expect(id).toBe(0);
  });
});

describe("pollWorkflowStatus", () => {
  const runId = 42;

  it("maps status='queued' to 'pending'", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { status: "queued", conclusion: null }),
    );
    const r = await pollWorkflowStatus(runId, undefined);
    expect(r.status).toBe("pending");
    expect(r.conclusion).toBeNull();
  });

  it("maps status='in_progress' to 'building'", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { status: "in_progress", conclusion: null }),
    );
    const r = await pollWorkflowStatus(runId, undefined);
    expect(r.status).toBe("building");
  });

  it("maps conclusion='success' to 'running'", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { status: "completed", conclusion: "success" }),
    );
    const r = await pollWorkflowStatus(runId, undefined);
    expect(r.status).toBe("running");
    expect(r.conclusion).toBe("success");
  });

  it("maps conclusion='failure' to 'failed'", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { status: "completed", conclusion: "failure" }),
    );
    const r = await pollWorkflowStatus(runId, undefined);
    expect(r.status).toBe("failed");
    expect(r.conclusion).toBe("failure");
  });

  it("returns 'failed' when the GitHub runs API responds non-200", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(404, ""));
    const r = await pollWorkflowStatus(runId, undefined);
    expect(r.status).toBe("failed");
    expect(r.url).toBeNull();
  });

  it("returns 'failed' immediately when the App is unconfigured or no runId is supplied", async () => {
    const r1 = await pollWorkflowStatus(0, undefined);
    expect(r1.status).toBe("failed");
    mockIsGitHubAppConfigured.mockReturnValue(false);
    const r2 = await pollWorkflowStatus(runId, undefined);
    expect(r2.status).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
