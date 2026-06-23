# Contract — Deployment WebSocket Events

**Feature**: [spec.md](../spec.md) | **Plan**: [plan.md](../plan.md)

The existing `deployments-{projectId}` WebSocket channel and the
`deployment_refresh` event name are **preserved unchanged** (CR-002). This
contract pins the payload shape after the cutover.

## Channel

```
deployments-{projectId}
```

- Subscribed by the frontend deployment card and logs dialog.
- One channel per project; one deployment row at a time triggers events
  on it.

## Event: `deployment_refresh`

### Payload

```ts
interface DeploymentRefreshPayload {
  /** Discriminator for the cause of the broadcast. */
  action:
    | 'created'         // a new deployment row was just dispatched (create)
    | 'status_updated'  // status changed (deploy dispatched, poller observed transition, etc.)
    | 'config_updated'  // updateServiceConfig persisted non-env fields
    | 'deleted';        // destroy completed and row reached terminal 'deleted'

  /** Always present. */
  deploymentId: string;

  /** Present for 'created' and 'status_updated'. */
  status?: 'pending' | 'building' | 'deploying' | 'running' | 'failed' | 'deleted';

  /** Present only when a URL just resolved (i.e., poller observed
   *  conclusion=success and fetched the container-app FQDN). */
  url?: string | null;

  /** Present only when status === 'failed'. Operator-facing free text
   *  drawn from the LastFailureCause taxonomy in data-model.md. */
  lastFailureCause?: string | null;

  /** Present only when a workflow run concluded (success or failure). */
  workflowRunUrl?: string | null;
}
```

### When emitted

| Trigger                                                      | `action`           | Source                                    |
| ------------------------------------------------------------ | ------------------ | ----------------------------------------- |
| `create` request succeeds (workflow dispatched)              | `created`          | `actions/create.ts`                       |
| `deploy` request succeeds (workflow dispatched)              | `status_updated`   | `actions/deploy.ts`                       |
| `destroy` request succeeds (workflow dispatched)             | `status_updated`   | `actions/destroy.ts`                      |
| Poller observes transition `pending → building`              | `status_updated`   | `poller.ts`                               |
| Poller observes transition `building → running`              | `status_updated`   | `poller.ts` (with `url`)                  |
| Poller observes transition `building → failed`               | `status_updated`   | `poller.ts` (with `lastFailureCause` + `workflowRunUrl`) |
| Poller marks row `failed` via stall-window                   | `status_updated`   | `poller.ts` (with `lastFailureCause`)     |
| Poller observes destroy success → terminal `deleted`         | `deleted`          | `poller.ts`                               |
| Pre-deploy auto-push fails                                   | `status_updated`   | `actions/deploy.ts` (with `lastFailureCause`) |
| Workflow dispatch HTTP fails                                 | `status_updated`   | `actions/{create,deploy,destroy}.ts` (with `lastFailureCause`) |
| `updateServiceConfig` persists non-env fields                | `config_updated`   | `actions/updateServiceConfig.ts`          |

### Backwards-compatibility notes

- The existing payload's `action` discriminator already carries values that
  the frontend dispatches on. New event sub-types (`status_updated`,
  `config_updated`) extend this set without renaming or removing existing
  values.
- The optional fields (`status`, `url`, `lastFailureCause`, `workflowRunUrl`)
  are additive; existing subscribers that ignore unknown fields continue to
  work.
- The channel name and event name are unchanged; subscribers do not need to
  resubscribe.

### Delivery guarantees

- **At-most-one broadcast per poller tick per row across the API fleet**,
  guaranteed by the per-row advisory lock (FR-017, SC-008).
- **No delivery retry**: WebSocket broadcast is best-effort. The frontend
  `DeploymentCard` retains a 10-second safety poll for any subscriber that
  missed an event (e.g., a tab that lost the WebSocket connection
  mid-deploy).
