/**
 * Generated App — Illustrative Infrastructure Snapshot
 *
 * Performs a ONE-TIME, best-effort push of the genapp Terraform templates
 * (read from the Pronghorn platform repo) into the user's repository under an
 * `infra/` folder. This copy is purely illustrative so the user can SEE the
 * infrastructure-as-code that provisions their app.
 *
 * IMPORTANT: This snapshot is NOT wired into the actual deployment path. The
 * real deployment continues to run Terraform from the Pronghorn repo's
 * `infra/generated-app-template/` directory via the `genapp-deploy.yml`
 * workflow. Editing the copied files in the user's repo has no deployment
 * effect.
 *
 * @example
 *   import { pushInfraSnapshot } from "./genappInfraSnapshot";
 *   await pushInfraSnapshot({
 *     userToken,
 *     org: "acme",
 *     repo: "my-app",
 *     branch: "main",
 *     appName: "my-app",
 *   });
 */
import { logger } from "../../../utils/logger";
import { gitHubApiHeaders } from "../../../utils/githubAuth";
import {
  getInstallationToken,
  isGitHubAppConfigured,
} from "../../../utils/githubAppAuth";

const LOG_PREFIX = "[genapp:infra-snapshot]";

// Pronghorn platform repo that holds the canonical Terraform templates. These
// mirror the constants in genappWorkflowClient.ts; kept independent so this
// module is self-contained.
const PRONGHORN_OWNER =
  process.env.PRONGHORN_WORKFLOW_OWNER || "pronghorn-blue-msft";
const PRONGHORN_REPO = process.env.PRONGHORN_WORKFLOW_REPO || "pronghorn";
const PRONGHORN_REF = process.env.PRONGHORN_WORKFLOW_REF || "main";

// Source directories (in the Pronghorn repo) to copy verbatim. Paths are
// preserved 1:1 in the user's repo, so they land under `infra/...`.
const SOURCE_PREFIXES = [
  "infra/generated-app-template",
  "infra/modules/generated-app",
];

// Marker file used as an idempotency guard. If it already exists on the
// target branch the snapshot is skipped (the one-time push already ran).
const MARKER_PATH = "infra/README.md";

interface PushInfraSnapshotOptions {
  /** GitHub token with write access to the user's repo. */
  userToken: string;
  /** User repo organization / owner. */
  org: string;
  /** User repo name. */
  repo: string;
  /** Branch to commit the snapshot onto. */
  branch: string;
  /** Display name of the generated app (used in the README). */
  appName: string;
}

interface SourceBlob {
  /** Destination path in the user repo (same as source path). */
  path: string;
  /** Base64-encoded file content (as returned by the GitHub blobs API). */
  base64Content: string;
}

/**
 * Resolve a token capable of reading the Pronghorn platform repo. Prefers the
 * GitHub App installation token; falls back to the supplied user token.
 *
 * @param fallbackToken - User token used when the GitHub App is not configured.
 * @returns A token string for reading the Pronghorn repo.
 */
async function resolvePronghornReadToken(
  fallbackToken: string,
): Promise<string> {
  if (isGitHubAppConfigured()) {
    return await getInstallationToken();
  }
  return fallbackToken;
}

/**
 * Read the Terraform template files from the Pronghorn repo via the GitHub
 * Git Trees API and return them with their base64 content.
 *
 * @param readToken - Token authorized to read the Pronghorn repo.
 * @returns The list of source blobs, or an empty array if none were found.
 */
async function readPronghornTemplates(
  readToken: string,
): Promise<SourceBlob[]> {
  const headers = gitHubApiHeaders(readToken, "Pronghorn-Infra-Snapshot");

  const treeResp = await fetch(
    `https://api.github.com/repos/${PRONGHORN_OWNER}/${PRONGHORN_REPO}/git/trees/${PRONGHORN_REF}?recursive=1`,
    { headers },
  );
  if (!treeResp.ok) {
    throw new Error(
      `failed to read Pronghorn template tree (${treeResp.status})`,
    );
  }

  const treeData = (await treeResp.json()) as {
    tree?: { path: string; type: string; sha: string }[];
  };
  const entries = (treeData.tree ?? []).filter(
    (e) =>
      e.type === "blob" &&
      SOURCE_PREFIXES.some(
        (prefix) => e.path === prefix || e.path.startsWith(`${prefix}/`),
      ),
  );

  if (entries.length === 0) return [];

  const blobs = await Promise.all(
    entries.map(async (e) => {
      const blobResp = await fetch(
        `https://api.github.com/repos/${PRONGHORN_OWNER}/${PRONGHORN_REPO}/git/blobs/${e.sha}`,
        { headers },
      );
      if (!blobResp.ok) {
        throw new Error(`failed to read template blob ${e.path}`);
      }
      const blobData = (await blobResp.json()) as { content: string };
      return {
        path: e.path,
        base64Content: blobData.content.replace(/\n/g, ""),
      };
    }),
  );

  return blobs;
}

/**
 * Build the illustrative README placed at the root of the copied `infra/`
 * folder, making the "view only" nature explicit.
 *
 * @param appName - The generated app name.
 * @returns Markdown content for `infra/README.md`.
 */
function buildReadme(appName: string): string {
  return [
    "# Infrastructure (illustrative)",
    "",
    "This folder contains a **read-only snapshot** of the Terraform that",
    `provisions **${appName}** on Azure Container Apps.`,
    "",
    "> [!IMPORTANT]",
    "> This code is provided **for visibility only**. It is **not** executed",
    "> from this repository and editing it here has **no effect** on your",
    "> deployment. The actual infrastructure is applied by the Pronghorn",
    "> platform from its own copy of these templates.",
    "",
    "## Layout",
    "",
    "- `generated-app-template/` — root Terraform configuration.",
    "- `modules/generated-app/` — reusable modules (resource group, container app).",
    "",
  ].join("\n");
}

/**
 * One-time, best-effort push of the genapp Terraform templates into the user's
 * repository for illustrative purposes. Never throws — failures are logged and
 * swallowed so the calling deployment action is unaffected.
 *
 * Idempotent: if `infra/README.md` already exists on the target branch the
 * push is skipped.
 *
 * @param opts - Target repo coordinates and tokens.
 * @returns Resolves when the push completes or is safely skipped.
 *
 * @example
 *   await pushInfraSnapshot({
 *     userToken, org: "acme", repo: "my-app", branch: "main", appName: "my-app",
 *   });
 */
export async function pushInfraSnapshot(
  opts: PushInfraSnapshotOptions,
): Promise<void> {
  const { userToken, org, repo, branch, appName } = opts;

  // Guard clauses — bail quietly on missing inputs.
  if (!userToken || !org || !repo || !branch) {
    logger.warn(`${LOG_PREFIX} missing inputs; skipping snapshot push`);
    return;
  }

  try {
    const headers = gitHubApiHeaders(userToken, "Pronghorn-Infra-Snapshot");

    // Idempotency guard: skip if the marker already exists on this branch.
    const markerResp = await fetch(
      `https://api.github.com/repos/${org}/${repo}/contents/${MARKER_PATH}?ref=${branch}`,
      { headers },
    );
    if (markerResp.ok) {
      logger.info(
        `${LOG_PREFIX} snapshot already present in ${org}/${repo}@${branch}; skipping`,
      );
      return;
    }

    // Resolve current branch tip + its tree (used as base so existing files
    // are preserved).
    const refResp = await fetch(
      `https://api.github.com/repos/${org}/${repo}/git/refs/heads/${branch}`,
      { headers },
    );
    if (!refResp.ok) {
      logger.warn(
        `${LOG_PREFIX} branch ${branch} not found in ${org}/${repo} (${refResp.status}); skipping`,
      );
      return;
    }
    const refData = (await refResp.json()) as { object: { sha: string } };
    const currentCommitSha = refData.object.sha;

    const commitResp = await fetch(
      `https://api.github.com/repos/${org}/${repo}/git/commits/${currentCommitSha}`,
      { headers },
    );
    if (!commitResp.ok) {
      logger.warn(
        `${LOG_PREFIX} could not read base commit for ${org}/${repo}; skipping`,
      );
      return;
    }
    const commitData = (await commitResp.json()) as { tree: { sha: string } };
    const baseTreeSha = commitData.tree.sha;

    // Read the canonical templates from the Pronghorn repo.
    const readToken = await resolvePronghornReadToken(userToken);
    const sourceBlobs = await readPronghornTemplates(readToken);
    if (sourceBlobs.length === 0) {
      logger.warn(
        `${LOG_PREFIX} no template files found in ${PRONGHORN_OWNER}/${PRONGHORN_REPO}; skipping`,
      );
      return;
    }

    // Create blobs in the user repo (base64 content for the templates, utf-8
    // for the generated README).
    const treeEntries = await Promise.all([
      ...sourceBlobs.map(async (sb) => {
        const blobResp = await fetch(
          `https://api.github.com/repos/${org}/${repo}/git/blobs`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              content: sb.base64Content,
              encoding: "base64",
            }),
          },
        );
        if (!blobResp.ok) {
          throw new Error(`blob create failed for ${sb.path}`);
        }
        const blobData = (await blobResp.json()) as { sha: string };
        return {
          path: sb.path,
          mode: "100644" as const,
          type: "blob" as const,
          sha: blobData.sha,
        };
      }),
      (async () => {
        const readmeResp = await fetch(
          `https://api.github.com/repos/${org}/${repo}/git/blobs`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              content: buildReadme(appName),
              encoding: "utf-8",
            }),
          },
        );
        if (!readmeResp.ok) {
          throw new Error("blob create failed for infra/README.md");
        }
        const readmeData = (await readmeResp.json()) as { sha: string };
        return {
          path: MARKER_PATH,
          mode: "100644" as const,
          type: "blob" as const,
          sha: readmeData.sha,
        };
      })(),
    ]);

    // Create a tree on top of the existing one (base_tree preserves all other
    // files), then a commit, then advance the branch ref.
    const newTreeResp = await fetch(
      `https://api.github.com/repos/${org}/${repo}/git/trees`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
      },
    );
    if (!newTreeResp.ok) {
      throw new Error(`tree create failed (${newTreeResp.status})`);
    }
    const newTree = (await newTreeResp.json()) as { sha: string };

    const newCommitResp = await fetch(
      `https://api.github.com/repos/${org}/${repo}/git/commits`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          message: "Add illustrative infrastructure snapshot (view only)",
          tree: newTree.sha,
          parents: [currentCommitSha],
        }),
      },
    );
    if (!newCommitResp.ok) {
      throw new Error(`commit create failed (${newCommitResp.status})`);
    }
    const newCommit = (await newCommitResp.json()) as { sha: string };

    const patchResp = await fetch(
      `https://api.github.com/repos/${org}/${repo}/git/refs/heads/${branch}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ sha: newCommit.sha }),
      },
    );
    if (!patchResp.ok) {
      throw new Error(`ref update failed (${patchResp.status})`);
    }

    logger.info(
      `${LOG_PREFIX} pushed ${sourceBlobs.length} template files to ${org}/${repo}@${branch} (${newCommit.sha.substring(0, 8)})`,
    );
  } catch (err) {
    // Best-effort: never let snapshot failures affect the deployment flow.
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`${LOG_PREFIX} snapshot push failed (non-fatal): ${msg}`);
  }
}
