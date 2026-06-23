/**
 * Unit tests for the GitHub token resolution fallback chain.
 *
 * Pins the post-OAuth-removal behaviour: the resolution order is
 * per-repo PAT → GitHub App installation token → system env token.
 */

const mockQuery = jest.fn();
jest.mock("../../utils/database", () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}));

jest.mock("../../utils/logger", () => ({
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
jest.mock("../../utils/githubAppAuth", () => ({
  __esModule: true,
  isGitHubAppConfigured: (...args: unknown[]) =>
    mockIsGitHubAppConfigured(...args),
  getInstallationToken: (...args: unknown[]) =>
    mockGetInstallationToken(...args),
}));

import { resolveGitHubToken } from "../../utils/githubAuth";

describe("resolveGitHubToken", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GITHUB_PAT;
    delete process.env.GITHUB_TOKEN;
    mockIsGitHubAppConfigured.mockReturnValue(false);
  });

  it("returns the per-repo PAT first when present for a non-default repo", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ pat: "repo-pat" }] });

    const resolved = await resolveGitHubToken({ repoId: "repo-1" });

    expect(resolved).toEqual({ token: "repo-pat", source: "repo_pat" });
    expect(mockGetInstallationToken).not.toHaveBeenCalled();
  });

  it("skips the repo_pats lookup for default repos", async () => {
    mockIsGitHubAppConfigured.mockReturnValue(true);
    mockGetInstallationToken.mockResolvedValue("ghs_install");

    const resolved = await resolveGitHubToken({
      repoId: "repo-1",
      isDefaultRepo: true,
    });

    expect(mockQuery).not.toHaveBeenCalled();
    expect(resolved).toEqual({ token: "ghs_install", source: "github_app" });
  });

  it("returns the GitHub App installation token when the App is configured", async () => {
    mockIsGitHubAppConfigured.mockReturnValue(true);
    mockGetInstallationToken.mockResolvedValue("ghs_install");

    const resolved = await resolveGitHubToken();

    expect(resolved).toEqual({ token: "ghs_install", source: "github_app" });
  });

  it("falls back to the system env token when the App mint fails", async () => {
    mockIsGitHubAppConfigured.mockReturnValue(true);
    mockGetInstallationToken.mockRejectedValue(new Error("boom"));
    process.env.GITHUB_PAT = "env-pat";

    const resolved = await resolveGitHubToken();

    expect(resolved).toEqual({ token: "env-pat", source: "system_env" });
  });

  it("returns null when no token source is available", async () => {
    const resolved = await resolveGitHubToken();
    expect(resolved).toBeNull();
  });
});
