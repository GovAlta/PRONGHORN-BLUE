/**
 * Canonical staging operation types and exhaustiveness utilities.
 *
 * Centralising these types ensures that every switch over `operation_type`
 * covers all cases at compile time — missing cases become TypeScript errors.
 *
 * @example
 * ```ts
 * switch (row.operation_type as StagingOpType) {
 *   case 'add':
 *   case 'create':
 *   case 'modify':
 *   case 'edit':
 *     // content-bearing ops
 *     break;
 *   case 'delete':
 *     // remove from repo_files
 *     break;
 *   case 'rename':
 *     // update path in repo_files
 *     break;
 *   default:
 *     assertNeverStagingOp(row.operation_type);
 * }
 * ```
 */

/** All valid operation types for a staged file change. */
export type StagingOpType =
  | "add"
  | "create"
  | "modify"
  | "edit"
  | "delete"
  | "rename";

/**
 * Op types that carry file content — the blob must be read on commit.
 * 'delete' and 'rename' are intentionally excluded.
 */
export const CONTENT_OP_TYPES: ReadonlySet<StagingOpType> = new Set([
  "add",
  "create",
  "modify",
  "edit",
]);

/**
 * Compile-time exhaustiveness guard for staging op-type switches.
 * Call from the `default` branch; TypeScript will report an error if any
 * `StagingOpType` member is not handled before reaching this function.
 *
 * @param op - The unhandled op value; must be `never` for the switch to be exhaustive.
 * @throws Error at runtime if an unexpected value reaches this branch.
 */
export function assertNeverStagingOp(op: never): never {
  throw new Error(`Unhandled staging operation type: ${String(op)}`);
}
