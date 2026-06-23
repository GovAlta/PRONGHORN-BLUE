/**
 * GitHub App authentication for server-to-server operations.
 *
 * Generates short-lived installation access tokens for the `phb-user-app-deploy`
 * GitHub App. These tokens are used exclusively for workflow dispatch and status
 * polling on the platform repo — user-facing repo operations continue to use the
 * OAuth token from {@link ./githubAuth}.
 *
 * Token lifecycle:
 * 1. Sign a JWT with the App's private key (10-minute expiry per GitHub spec).
 * 2. Exchange the JWT for an installation access token (1-hour expiry).
 * 3. Cache the token in-memory until 5 minutes before expiry.
 *
 * @example
 *   import { getInstallationToken } from '../utils/githubAppAuth';
 *   const token = await getInstallationToken();
 *   // Use token for workflow dispatch / status polling
 */
import jwt from "jsonwebtoken";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const GITHUB_APP_ID = process.env.GITHUB_APP_ID || "";
const GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID || "";
const GITHUB_APP_PRIVATE_KEY = (
  process.env.GITHUB_APP_PRIVATE_KEY || ""
).replace(/\\n/g, "\n"); // Handle escaped newlines from env vars / Key Vault

// ---------------------------------------------------------------------------
// In-memory token cache
// ---------------------------------------------------------------------------

let cachedToken: string | null = null;
let cachedTokenExpiresAt = 0;

/** Buffer before expiry to trigger a refresh (5 minutes in ms). */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true when all required GitHub App env vars are configured.
 * Callers should check this before attempting to generate tokens.
 */
export function isGitHubAppConfigured(): boolean {
  return !!(
    GITHUB_APP_ID &&
    GITHUB_APP_INSTALLATION_ID &&
    GITHUB_APP_PRIVATE_KEY
  );
}

/**
 * Get a valid GitHub App installation access token.
 * Returns a cached token if still valid, otherwise generates a new one.
 *
 * @throws Error if GitHub App env vars are not configured or token exchange fails.
 * @returns Installation access token string
 */
export async function getInstallationToken(): Promise<string> {
  if (!isGitHubAppConfigured()) {
    throw new Error(
      "GitHub App is not configured. Set GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, and GITHUB_APP_PRIVATE_KEY.",
    );
  }

  if (cachedToken && Date.now() < cachedTokenExpiresAt) {
    return cachedToken;
  }

  const appJwt = createAppJwt();
  const token = await exchangeForInstallationToken(appJwt);
  return token;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Create a short-lived JWT signed with the App's RSA private key.
 * GitHub requires: iss = App ID, exp ≤ 10 minutes, iat = now - 60s (clock drift).
 */
function createAppJwt(): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: GITHUB_APP_ID,
      iat: nowSeconds - 60,
      exp: nowSeconds + 10 * 60,
    },
    GITHUB_APP_PRIVATE_KEY,
    { algorithm: "RS256" },
  );
}

/**
 * Exchange the App JWT for an installation access token via GitHub API.
 * Caches the result in-memory.
 *
 * @see https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
 */
async function exchangeForInstallationToken(appJwt: string): Promise<string> {
  const url = `https://api.github.com/app/installations/${GITHUB_APP_INSTALLATION_ID}/access_tokens`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    logger.error(
      `[github-app] Failed to get installation token: status=${res.status} body=${errText}`,
    );
    throw new Error(
      `GitHub App token exchange failed: ${res.status} ${errText}`,
    );
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  cachedToken = data.token;
  cachedTokenExpiresAt = new Date(data.expires_at).getTime() - EXPIRY_BUFFER_MS;

  logger.info(
    `[github-app] Installation token acquired, expires_at=${data.expires_at}`,
  );

  return cachedToken;
}
