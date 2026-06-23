/**
 * Generated App Deployment Utilities
 *
 * Handles GitHub Actions workflow dispatch, status polling, and
 * Terraform template push for user-generated app deployments.
 *
 * Relocated from `utils/genappDeploy.ts` into the docker deployment
 * module per spec 006 research D-11.
 *
 * @example
 *   import { dispatchGenappWorkflow, pollWorkflowStatus } from '../services/deployment/docker/genappWorkflowClient';
 *   const runId = await dispatchGenappWorkflow({ ... });
 */
import { logger } from "../../../utils/logger";
import {
  getInstallationToken,
  isGitHubAppConfigured,
} from "../../../utils/githubAppAuth";
import {
  getAzureTokenForScope,
  AzureScope,
} from "../../../utils/azureCredential";
import type { DeploymentStatus, DockerDeploymentAction } from "./types";

export type { DeploymentStatus } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parameters for dispatching the genapp-deploy workflow */
export interface GenappWorkflowParams {
  appId: string;
  appName: string;
  resourceGroup: string;
  repoUrl: string;
  branch: string;
  dockerfilePath: string;
  environment: string;
  action: DockerDeploymentAction;
  /**
   * Name of the per-deployment Azure Key Vault holding env-var / secret VALUES.
   * Terraform reads the values from this vault — they are NEVER passed inline.
   */
  keyVaultName: string;
  /** Shared platform resource group that contains the per-deployment vault. */
  keyVaultResourceGroup: string;
  port: number;
  /**
   * @deprecated No longer used. Workflow dispatch authenticates with the GitHub
   * App installation token; retained for call-site compatibility.
   */
  githubToken?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Owner / repo / branch hosting the `genapp-deploy.yml` workflow. This is
// INDEPENDENT of `GITHUB_ORG`, which identifies the *user's* org for their
// per-deployment repos. Mixing the two would route workflow dispatches to a
// non-existent repo (404). The ref must be a branch that actually contains
// the workflow file (GitHub looks up the workflow at the ref, not just at
// the default branch).
const PRONGHORN_WORKFLOW_OWNER =
  process.env.PRONGHORN_WORKFLOW_OWNER || "pronghorn-blue-msft";
const PRONGHORN_REPO_NAME = process.env.PRONGHORN_WORKFLOW_REPO || "pronghorn";
const PRONGHORN_WORKFLOW_REF = process.env.PRONGHORN_WORKFLOW_REF || "main";
const DOCKER_DEPLOY_WORKFLOW_FILE =
  process.env.DOCKER_DEPLOY_WORKFLOW_FILE || "genapp-deploy.yml";

// ---------------------------------------------------------------------------
// Workflow Dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch the genapp-deploy.yml workflow via GitHub API.
 * Returns the workflow run ID for subsequent status polling.
 *
 * @param params - Workflow parameters
 * @returns Workflow run ID (0 if unable to determine)
 */
export async function dispatchGenappWorkflow(
  params: GenappWorkflowParams,
): Promise<number> {
  // Workflow dispatch on the platform repo uses the GitHub App installation token.
  if (!isGitHubAppConfigured()) {
    throw new Error(
      "GitHub App is not configured. Set GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, and GITHUB_APP_PRIVATE_KEY to enable workflow dispatch.",
    );
  }
  const token = await getInstallationToken();
  logger.info(
    "[genapp] Using GitHub App installation token for workflow dispatch",
  );

  const dispatchUrl = `https://api.github.com/repos/${PRONGHORN_WORKFLOW_OWNER}/${PRONGHORN_REPO_NAME}/actions/workflows/${DOCKER_DEPLOY_WORKFLOW_FILE}/dispatches`;

  logger.info(
    `[genapp] Dispatching workflow: action=${params.action} app=${params.appName} url=${dispatchUrl} ref=${PRONGHORN_WORKFLOW_REF}`,
  );

  const dispatchRes = await fetch(dispatchUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ref: PRONGHORN_WORKFLOW_REF,
      inputs: {
        app_id: params.appId,
        app_name: params.appName,
        resource_group: params.resourceGroup,
        repo_url: params.repoUrl,
        branch: params.branch,
        dockerfile_path: params.dockerfilePath,
        environment: params.environment,
        action: params.action,
        key_vault_name: params.keyVaultName,
        key_vault_resource_group: params.keyVaultResourceGroup,
        port: String(params.port || 80),
      },
    }),
  });

  if (!dispatchRes.ok) {
    const errText = await dispatchRes.text();
    const dispatchScopes =
      dispatchRes.headers.get("x-oauth-scopes") || "(none)";
    const acceptedScopes =
      dispatchRes.headers.get("x-accepted-oauth-scopes") || "(unspecified)";
    logger.error(
      `[genapp] Dispatch failed: status=${dispatchRes.status} url=${dispatchUrl} ref=${PRONGHORN_WORKFLOW_REF} token-scopes=${dispatchScopes} accepted-scopes=${acceptedScopes} body=${errText}`,
    );
    throw new Error(
      `Workflow dispatch failed: ${dispatchRes.status} ${errText}`,
    );
  }

  // GitHub doesn't return run ID from dispatch — poll for the most recent run matching this app_id
  await new Promise((resolve) => setTimeout(resolve, 3000));
  return await findWorkflowRunByAppId(params.appId);
}

/**
 * Find the most recent workflow run matching a specific app_id input.
 * Filters runs created in the last 60 seconds to avoid matching stale runs.
 *
 * Exported so the poller can resolve a run id when dispatch returned `0`.
 */
export async function findWorkflowRunByAppId(appId: string): Promise<number> {
  if (!isGitHubAppConfigured()) return 0;
  const token = await getInstallationToken();

  const since = new Date(Date.now() - 60_000).toISOString();
  const runsUrl = `https://api.github.com/repos/${PRONGHORN_WORKFLOW_OWNER}/${PRONGHORN_REPO_NAME}/actions/workflows/${DOCKER_DEPLOY_WORKFLOW_FILE}/runs?per_page=5&created=>${since}`;

  const res = await fetch(runsUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (res.ok) {
    const data = (await res.json()) as any;
    // Try to find the run for this specific app_id by checking workflow run inputs
    // GitHub runs API doesn't expose inputs directly, so we also check jobs
    // For now, return the most recent run as best effort
    if (data.workflow_runs?.length > 0) {
      return data.workflow_runs[0].id;
    }
  }

  logger.warn(`[genapp] Could not determine workflow run ID for app ${appId}`);
  return 0;
}

// ---------------------------------------------------------------------------
// Status Polling
// ---------------------------------------------------------------------------

/**
 * Poll a GitHub Actions workflow run and map its status to a deployment status.
 * When the workflow completes successfully, fetches the container app FQDN
 * from Azure to populate the deployment URL.
 *
 * @param workflowRunId - The GitHub Actions run ID
 * @param deploymentContext - Optional context for FQDN retrieval
 * @returns Mapped deployment status, conclusion, and optional FQDN
 */
export async function pollWorkflowStatus(
  workflowRunId: number,
  deploymentContext?: {
    containerAppName?: string;
    resourceGroup?: string;
  },
): Promise<{
  status: DeploymentStatus;
  conclusion: string | null;
  url: string | null;
  runUrl: string | null;
}> {
  // Polling the platform repo uses the GitHub App installation token.
  if (!isGitHubAppConfigured() || !workflowRunId) {
    return { status: "failed", conclusion: null, url: null, runUrl: null };
  }
  const token = await getInstallationToken();

  const runApiUrl = `https://api.github.com/repos/${PRONGHORN_WORKFLOW_OWNER}/${PRONGHORN_REPO_NAME}/actions/runs/${workflowRunId}`;

  const res = await fetch(runApiUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!res.ok) {
    logger.warn(
      `[genapp] Failed to poll workflow run ${workflowRunId}: ${res.status}`,
    );
    return { status: "failed", conclusion: null, url: null, runUrl: null };
  }

  const run = (await res.json()) as any;
  const runUrl: string | null = (run.html_url as string | undefined) ?? null;

  let status: DeploymentStatus;
  switch (run.status) {
    case "queued":
    case "waiting":
    case "pending":
      status = "pending";
      break;
    case "in_progress":
      status = "building";
      break;
    case "completed":
      status = run.conclusion === "success" ? "running" : "failed";
      break;
    default:
      status = "failed";
  }

  // When workflow succeeds, fetch the container app FQDN from Azure
  let url: string | null = null;
  if (
    status === "running" &&
    deploymentContext?.containerAppName &&
    deploymentContext?.resourceGroup
  ) {
    try {
      url = await fetchContainerAppFqdn(
        deploymentContext.containerAppName,
        deploymentContext.resourceGroup,
      );
    } catch (fqdnErr: any) {
      logger.warn(`[genapp] FQDN fetch failed: ${fqdnErr.message}`);
    }
  }

  return { status, conclusion: run.conclusion, url, runUrl };
}

/**
 * Fetch the FQDN of a container app from Azure REST API.
 */
async function fetchContainerAppFqdn(
  appName: string,
  resourceGroup: string,
): Promise<string | null> {
  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
  if (!subscriptionId) return null;

  const azureToken = await getAzureTokenForScope(AzureScope.ARM);
  if (!azureToken) return null;

  const url = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.App/containerApps/${appName}?api-version=2024-03-01`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${azureToken}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) return null;

  const data = (await res.json()) as any;
  const fqdn = data.properties?.configuration?.ingress?.fqdn;
  return fqdn ? `https://${fqdn}` : null;
}
