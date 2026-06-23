/**
 * Shared types for the Docker deployment service module.
 *
 * Single source of truth for the deployment status enum, the action verb
 * union, and the row shape used by the action handlers and the poller.
 */
import type { Request, Response } from "express";

// ---------------------------------------------------------------------------
// Deployment status (FR-016)
// ---------------------------------------------------------------------------

export type DeploymentStatus =
  | "pending" // transitional — dispatched but not yet observed in GitHub Actions
  | "building" // transitional — workflow run in progress
  | "deploying" // transitional — reserved; treated identically to 'building' today
  | "running" // terminal     — workflow concluded success, running URL resolved
  | "failed" // terminal     — terminal failure (deploy or destroy)
  | "stopped" // terminal     — operator-stopped (lifecycle action)
  | "deleted"; // terminal     — post-successful-destroy

export const TRANSITIONAL: ReadonlySet<DeploymentStatus> =
  new Set<DeploymentStatus>(["pending", "building", "deploying"]);

export const TERMINAL: ReadonlySet<DeploymentStatus> =
  new Set<DeploymentStatus>(["running", "failed", "stopped", "deleted"]);

export const isTransitional = (s: DeploymentStatus | string): boolean =>
  TRANSITIONAL.has(s as DeploymentStatus);

export const isTerminal = (s: DeploymentStatus | string): boolean =>
  TERMINAL.has(s as DeploymentStatus);

// ---------------------------------------------------------------------------
// Docker deployment action verbs
// ---------------------------------------------------------------------------

export type DockerDeploymentAction =
  | "create"
  | "deploy"
  | "destroy"
  | "status"
  | "updateServiceConfig"
  | "start"
  | "stop"
  | "restart"
  | "logs"
  | "getEvents"
  | "getEnvVars"
  | "updateEnvVars"
  | "syncEnvVars";

// ---------------------------------------------------------------------------
// LastFailureCause taxonomy (descriptive — DB column is plain text)
// ---------------------------------------------------------------------------

export type LastFailureCause =
  | `pre-push-failed: ${string}`
  | `dispatch-http-${string}`
  | "stall-window-exceeded"
  | "workflow-conclusion-failure"
  | "workflow-conclusion-failure-destroy"
  | "no-github-token";

// ---------------------------------------------------------------------------
// DeploymentRow — read model used inside the new service module
// ---------------------------------------------------------------------------

export interface DeploymentRow {
  id: string;
  project_id: string;
  status: DeploymentStatus;
  url: string | null;
  azure_container_app_name: string | null;
  azure_resource_group: string | null;
  workflow_run_id: number | null;
  workflow_run_url: string | null;
  dispatched_by_user_id: string | null;
  dispatched_at: string | null; // ISO timestamp
  dispatched_action: DockerDeploymentAction | null;
  last_failure_cause: string | null;
  port: number | null;
  // Editable service-config fields (FR-010)
  run_command: string | null;
  build_command: string | null;
  install_command: string | null;
  dockerfile_path: string | null;
  branch: string | null;
  run_folder: string | null;
  build_folder: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Action context passed from the entry point into each action handler
// ---------------------------------------------------------------------------

export interface DockerDeploymentContext {
  req: Request;
  res: Response;
  body: Record<string, unknown> & {
    action: DockerDeploymentAction;
    deploymentId: string;
    shareToken?: string | null;
  };
}
