/**
 * resolveAttachedContext — enriches attachedContext artifacts with blob content.
 *
 * When ProjectSelector sends artifacts as context, only metadata (ai_title,
 * ai_summary) is available because document content lives in Azure Blob
 * Storage.  This utility fetches the actual content from blob storage so
 * downstream AI handlers receive full document text.
 *
 * @example
 * const enriched = await resolveAttachedContext(attachedContext, projectId);
 * // enriched.artifacts[0].content === "full document text…"
 *
 * @example
 * // With content truncation
 * const enriched = await resolveAttachedContext(attachedContext, projectId, {
 *   maxArtifactContentLength: 10_000,
 * });
 */

import { getArtifactContent } from "../staging/artifactContentStore";
import { logger } from "./logger";

export interface ResolveOptions {
  /** Maximum character length for each artifact's content.  0 = no limit. */
  maxArtifactContentLength?: number;
}

/**
 * Enrich `attachedContext.artifacts` with document content fetched from blob
 * storage.  Returns a shallow clone of the context with enriched artifacts;
 * the original object is not mutated.
 *
 * @param attachedContext - The raw attached context from the frontend.
 * @param projectId      - Project UUID used to locate blobs.
 * @param options        - Optional configuration.
 * @returns Enriched context, or the original value if nothing to enrich.
 */
export async function resolveAttachedContext(
  attachedContext: any,
  projectId: string,
  options: ResolveOptions = {},
): Promise<any> {
  if (!attachedContext || !projectId) {
    return attachedContext;
  }

  const artifacts = attachedContext.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return attachedContext;
  }

  const maxLen = options.maxArtifactContentLength ?? 0;

  const enriched = await Promise.allSettled(
    artifacts.map(async (artifact: any) => {
      if (!artifact?.id) {
        return artifact;
      }

      // Skip if content is already present (e.g. from a legacy DB row)
      if (artifact.content) {
        return artifact;
      }

      try {
        const content = await getArtifactContent(projectId, artifact.id);
        if (content === null) {
          logger.warn(
            `[resolveAttachedContext] No blob content for artifact ${artifact.id}`,
          );
          return artifact;
        }

        const trimmed =
          maxLen > 0 && content.length > maxLen
            ? content.slice(0, maxLen) + "\n…[truncated]"
            : content;

        return { ...artifact, content: trimmed };
      } catch (err) {
        logger.error(
          `[resolveAttachedContext] Failed to fetch artifact ${artifact.id}:`,
          err,
        );
        return artifact;
      }
    }),
  );

  const resolvedArtifacts = enriched.map((r) =>
    r.status === "fulfilled" ? r.value : (r as any).reason ?? null,
  ).filter(Boolean);

  return { ...attachedContext, artifacts: resolvedArtifacts };
}
