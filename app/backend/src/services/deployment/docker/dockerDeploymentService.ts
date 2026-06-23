/**
 * Entry point for Docker-archetype deployment-service actions.
 *
 * Replaces the in-line `switch (action)` body of `handleDeploymentService`
 * in `app/backend/src/routes/functions.ts` with an action-registry pattern
 * (research D-5). Each per-action handler lives in `./actions/<verb>.ts`
 * and is plugged into the registry as its story lands; until a verb is
 * registered, the call is delegated to a fallback closure supplied by the
 * caller (the legacy `functions.ts` switch body) so the cutover is
 * incremental.
 *
 * @example
 *   import * as dockerDeploymentService from "../services/deployment/docker/dockerDeploymentService";
 *
 *   async function handleDeploymentService(req, res, body) {
 *     return dockerDeploymentService.handle(req, res, body, async () => {
 *       // legacy switch body — invoked for verbs the registry does not yet own
 *     });
 *   }
 */
import type { Request, Response } from "express";
import { logger } from "../../../utils/logger";
import type { DockerDeploymentAction, DockerDeploymentContext } from "./types";
import { createAction } from "./actions/create";
import { deployAction } from "./actions/deploy";
import { destroyAction } from "./actions/destroy";
import { statusAction } from "./actions/status";
import { updateServiceConfigAction } from "./actions/updateServiceConfig";
import { lifecycleArmAction } from "./actions/lifecycleArm";
import { logsAction } from "./actions/logs";
import { envVarsAction } from "./actions/envVars";

export type DockerDeploymentActionHandler = (
  ctx: DockerDeploymentContext,
) => Promise<unknown>;

/**
 * The action registry. Entries are added by user-story implementation tasks
 * (e.g., T020 registers `create`/`deploy`/`status` after US1's action files
 * are in place). Until then the map stays empty and `handle` falls through.
 *
 * MUST NOT import from `functions.ts` — the only legacy coupling is the
 * fallback closure passed to `handle` at runtime.
 */
const actions = new Map<DockerDeploymentAction, DockerDeploymentActionHandler>([
  ["create", createAction],
  ["deploy", deployAction],
  ["destroy", destroyAction],
  ["status", statusAction],
  ["updateServiceConfig", updateServiceConfigAction],
  ["start", lifecycleArmAction],
  ["stop", lifecycleArmAction],
  ["restart", lifecycleArmAction],
  ["logs", logsAction],
  ["getEvents", logsAction],
  ["getEnvVars", envVarsAction],
  ["updateEnvVars", envVarsAction],
  ["syncEnvVars", envVarsAction],
]);

/**
 * Wire-format aliases. The existing frontend sends `action: 'delete'`
 * (legacy verb); the canonical action verb in the new module is
 * `'destroy'`. Mapped at the registry boundary so the frontend wire
 * format is unchanged (CR-002).
 */
const WIRE_ALIASES: Record<string, DockerDeploymentAction> = {
  delete: "destroy",
};

/**
 * Register a handler for a Docker deployment action verb. Intended for
 * use by `actions/<verb>.ts` modules to wire themselves in.
 *
 * Idempotent: re-registering the same verb overwrites the previous handler
 * (supports test setup that needs to swap a mock in).
 */
export function registerDockerDeploymentAction(
  verb: DockerDeploymentAction,
  handler: DockerDeploymentActionHandler,
): void {
  actions.set(verb, handler);
}

/**
 * Visible for tests — clears the registry. Production code MUST NOT call this.
 */
export function _resetDockerDeploymentActionsForTests(): void {
  actions.clear();
}

/** Visible for tests — read-only view of the registered verbs. */
export function _getRegisteredDockerDeploymentActions(): DockerDeploymentAction[] {
  return Array.from(actions.keys());
}

/**
 * Dispatch a deployment-service request through the action registry.
 *
 * @param req      Express request (carries `req.user.id` for token resolution)
 * @param res      Express response — handlers respond directly
 * @param body     Parsed request body; `body.action` selects the handler
 * @param fallback Closure invoked when no handler is registered for `body.action`.
 *                 During the incremental cutover this is the legacy switch
 *                 body in `functions.ts`; once every verb is registered the
 *                 fallback is dead code and `functions.ts` may drop it.
 */
export async function handle(
  req: Request,
  res: Response,
  body: Record<string, unknown> & { action?: string },
  fallback: () => Promise<unknown> | unknown,
): Promise<unknown> {
  const rawAction = body?.action;
  // Resolve wire aliases using own-property lookups only, so attacker-supplied
  // values such as "__proto__", "constructor", or "toString" cannot resolve to
  // inherited Object.prototype members and trigger an unvalidated method call.
  const aliased =
    typeof rawAction === "string" &&
    Object.prototype.hasOwnProperty.call(WIRE_ALIASES, rawAction)
      ? WIRE_ALIASES[rawAction]
      : rawAction;
  const action = aliased as DockerDeploymentAction | undefined;

  if (!action) {
    logger.warn("[docker-deployment] missing action in body");
    return fallback();
  }

  // Map.get with a string key cannot resolve to inherited Object.prototype
  // members, and any unknown verb yields `undefined` and falls through to the
  // fallback below — so an attacker-supplied action cannot dispatch to an
  // unexpected target. This fixed-key registry lookup is the recommended
  // remediation pattern for dynamic dispatch.
  // codeql[js/unvalidated-dynamic-method-call]
  const handler = actions.get(action);
  if (!handler) {
    return fallback();
  }

  const ctx: DockerDeploymentContext = {
    req,
    res,
    body: body as DockerDeploymentContext["body"],
  };
  return handler(ctx);
}
