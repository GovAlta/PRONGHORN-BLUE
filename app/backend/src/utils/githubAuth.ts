/**
 * GitHub token resolution and GitHub API helper utilities.
 *
 * Repository operations authenticate using the GitHub App installation token
 * (see {@link ./githubAppAuth}). This module centralizes the token-resolution
 * fallback chain and request helper functions used by GitHub integrations.
 *
 * Token resolution order (first non-null wins):
 * 1. Per-repo PAT from repo_pats (when repoId is provided and not a default repo)
 * 2. GitHub App installation token (when the App is configured)
 * 3. System token from env vars: GITHUB_PAT, then GITHUB_TOKEN
 *
 * @example
 * const resolved = await resolveGitHubToken();
 * if (!resolved) throw new Error('No GitHub token available');
 * const headers = gitHubApiHeaders(resolved.token);
 */
import db from "./database";
import { logger } from "./logger";
import { getInstallationToken, isGitHubAppConfigured } from "./githubAppAuth";

// ═══════════════════════════════════════════════════════════════════════════════
// Centralized GitHub Token Resolution & API Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolved GitHub token details returned by resolveGitHubToken.
 */
export interface ResolvedGitHubToken {
  /** The GitHub access token (PAT or App installation token). */
  token: string;
  /** Where the token came from — useful for logging/debugging. */
  source: "repo_pat" | "github_app" | "system_env";
}

/**
 * Resolves the best available GitHub token using a deterministic fallback chain.
 *
 * Resolution order:
 * 1. Per-repo PAT from repo_pats (when repoId is provided and repo is not default)
 * 2. GitHub App installation token (when the App is configured)
 * 3. System token from env vars: GITHUB_PAT, then GITHUB_TOKEN
 *
 * @param opts Resolution inputs.
 * @param opts.repoId Repository UUID used for per-repo PAT lookup.
 * @param opts.isDefaultRepo When true, skips repo_pats lookup.
 * @returns Resolved token payload or null when no token source is available.
 *
 * @example
 * const resolved = await resolveGitHubToken({ repoId });
 * if (!resolved) throw new Error('No GitHub token available');
 */
export async function resolveGitHubToken(
  opts: {
    /** @deprecated Retained for call-site compatibility; no longer used for resolution. */
    userId?: string;
    repoId?: string;
    isDefaultRepo?: boolean;
  } = {},
): Promise<ResolvedGitHubToken | null> {
  const { repoId, isDefaultRepo } = opts;

  // 1. Per-repo PAT (skip for default repos — those use the App/system token)
  if (repoId && !isDefaultRepo) {
    try {
      const result = await db.query(
        "SELECT pat FROM repo_pats WHERE repo_id = $1 LIMIT 1",
        [repoId],
      );
      const pat = result.rows[0]?.pat;
      if (pat) {
        return { token: pat, source: "repo_pat" };
      }
    } catch (err: any) {
      logger.warn(
        `[github] Failed to look up repo_pats for repo ${repoId}: ${err.message}`,
      );
    }
  }

  // 2. GitHub App installation token
  if (isGitHubAppConfigured()) {
    try {
      const token = await getInstallationToken();
      return { token, source: "github_app" };
    } catch (err: any) {
      logger.warn(
        `[github] Failed to obtain GitHub App installation token: ${err.message}`,
      );
    }
  }

  // 3. System-level PAT from environment
  const systemPat = process.env.GITHUB_PAT || process.env.GITHUB_TOKEN;
  if (systemPat) {
    return { token: systemPat, source: "system_env" };
  }

  return null;
}

/**
 * Builds standard headers for authenticated GitHub REST API requests.
 *
 * @param token GitHub access token (PAT or OAuth token).
 * @param userAgent Optional User-Agent header value. Defaults to Pronghorn.
 * @returns Header object suitable for fetch RequestInit.headers.
 *
 * @example
 * const headers = gitHubApiHeaders(token);
 * const response = await fetch('https://api.github.com/user', { headers });
 */
export function gitHubApiHeaders(
  token: string,
  userAgent = "Pronghorn",
): Record<string, string> {
  return {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
    "Content-Type": "application/json",
    "User-Agent": userAgent,
  };
}

/**
 * Builds a GitHub HTTPS clone URL, optionally embedding a token.
 *
 * If token is omitted, the returned URL is unauthenticated.
 *
 * @param org GitHub organization or username.
 * @param repo Repository name.
 * @param branch Branch name appended as URL fragment.
 * @param token Optional GitHub token to embed in the URL.
 * @returns URL in the shape https://[token@]github.com/org/repo.git#branch.
 *
 * @example
 * const cloneUrl = gitHubCloneUrl('myorg', 'myrepo', 'main', token);
 */
export function gitHubCloneUrl(
  org: string,
  repo: string,
  branch: string,
  token?: string | null,
): string {
  const auth = token ? `${token}@` : "";
  return `https://${auth}github.com/${org}/${repo}.git#${branch}`;
}

/**
 * Executes an authenticated request against the GitHub REST API.
 *
 * @param path GitHub API path beginning with / (base URL is added automatically).
 * @param token GitHub access token used to build auth headers.
 * @param options Optional request overrides (HTTP method, body, userAgent).
 * @returns The raw fetch Response from GitHub.
 *
 * @example
 * const response = await gitHubApiFetch('/repos/org/repo', token);
 * if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
 */
export async function gitHubApiFetch(
  path: string,
  token: string,
  options: { method?: string; body?: any; userAgent?: string } = {},
): Promise<Response> {
  const { method = "GET", body, userAgent } = options;
  const url = `https://api.github.com${path}`;
  const headers = gitHubApiHeaders(token, userAgent);

  const fetchOpts: RequestInit = { method, headers };
  if (body) {
    fetchOpts.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  return fetch(url, fetchOpts);
}
