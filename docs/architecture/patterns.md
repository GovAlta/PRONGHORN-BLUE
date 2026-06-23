# Implementation Patterns

> Part of the [Pronghorn Architecture Documentation](../README.md)

---

## Route Handler Pattern

```typescript
// routes/v1/{domain}.ts
import { Router, Request, Response } from 'express';

const router = Router();

/**
 * @swagger
 * /api/v1/{domain}:
 *   get:
 *     summary: List resources
 */
router.get('/', async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const result = await query('SELECT * FROM {table} WHERE user_id = $1', [userId]);
  res.json(result.rows);
});

export default router;
```

## Service Action Registry Pattern

```typescript
// services/{domain}/{archetype}/{domain}Service.ts
type ActionHandler = (req: Request, res: Response) => Promise<void>;

const actionRegistry = new Map<string, ActionHandler>();

export function registerAction(verb: string, handler: ActionHandler) {
  actionRegistry.set(verb, handler);
}

// Alias support
registerAction('delete', destroyHandler);  // alias
registerAction('destroy', destroyHandler); // canonical

export async function dispatch(action: string, req: Request, res: Response) {
  const handler = actionRegistry.get(action);
  if (!handler) throw new NotFoundError(`Unknown action: ${action}`);
  return handler(req, res);
}
```

## Frontend API Hook Pattern

```typescript
// hooks/use{Domain}.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => apiClient.get<Project[]>('/projects'),
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateProjectInput) => apiClient.post('/projects', data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
}
```

## Frontend Component Pattern

```typescript
// components/{feature}/{ComponentName}.tsx
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

interface Props {
  /** Project identifier */
  projectId: string;
}

/**
 * Displays project details with edit capabilities.
 * @example <ProjectCard projectId="abc-123" />
 */
export function ProjectCard({ projectId }: Props) {
  const { data, isLoading } = useProject(projectId);
  if (isLoading) return <Skeleton />;
  return (
    <Card>
      <h2>{data.name}</h2>
      <Button variant="outline">Edit</Button>
    </Card>
  );
}
```

## Database Query Pattern

```typescript
// Direct SQL with parameterized queries
import { query, transaction } from '../utils/database';

// Simple query
const { rows } = await query(
  'SELECT * FROM projects WHERE id = $1 AND user_id = $2',
  [projectId, userId]
);

// Transaction
await transaction(async (client) => {
  await client.query('UPDATE projects SET status = $1 WHERE id = $2', ['archived', id]);
  await client.query('INSERT INTO audit_log (action, project_id) VALUES ($1, $2)', ['archive', id]);
});
```

## Terraform Module Pattern

```hcl
# modules/{service}/main.tf
resource "azurerm_..." "this" {
  name                = var.name
  resource_group_name = var.resource_group_name
  location            = var.location
  # ... configuration
}

# Optional private endpoint
resource "azurerm_private_endpoint" "this" {
  count = var.enable_private_endpoint ? 1 : 0
  # ...
}
```

All modules follow: resource creation → optional private endpoint → optional RBAC assignments → outputs.

---

## Extension Guide

### Adding a New API Route

1. Create `app/backend/src/routes/v1/{domain}.ts` with Express Router
2. Add Swagger JSDoc annotations for OpenAPI spec
3. Register in `app/backend/src/routes/v1/index.ts` with appropriate auth middleware
4. Add corresponding tests in `app/backend/src/__tests__/routes/{domain}.test.ts`
5. Update `app/frontend/src/lib/apiClient.ts` if new client methods needed

### Adding a New Service Module

Follow the **action registry pattern** established in `services/deployment/docker/`:

```
services/{domain}/{archetype}/
├── {domain}Service.ts           # Action registry + dispatcher
├── statusMachine.ts             # State transitions (if stateful)
├── poller.ts                    # Background reconciler (if async)
├── naming.ts                    # Deterministic naming helpers
├── types.ts                     # Domain types
├── {externalApi}Client.ts       # External API wrapper
└── actions/
    ├── create.ts
    ├── update.ts
    ├── delete.ts
    └── status.ts
```

### Adding a Frontend Feature

1. Create component directory: `app/frontend/src/components/{feature}/`
2. Create page component: `app/frontend/src/pages/{Feature}Page.tsx`
3. Add route in `App.tsx` (follow existing Suspense/lazy pattern)
4. Create data hooks: `app/frontend/src/hooks/use{Feature}.ts`
5. Reuse `components/ui/` primitives — do not create new base components
6. Add tests in `__tests__/` directories beside source

### Adding a Terraform Module

1. Create `infra/modules/{service}/` with `main.tf`, `variables.tf`, `outputs.tf`
2. Follow existing patterns: resource + optional PE + optional RBAC
3. Instantiate in `infra/main.tf` with appropriate dependencies
4. Add outputs to `infra/outputs.tf`
5. Update `params/dev.tfvars` and `params/pbmm.tfvars`

### Adding a Database Migration

1. Create `infra/migrations/{NNN}_{description}.sql` with next sequence number
2. Use idempotent SQL (`IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`)
3. Test locally: `npm run dev:reset` to verify from scratch
4. Migration runs automatically on startup if `RUN_MIGRATIONS_ON_STARTUP=true`

### Common Pitfalls

| Pitfall | Prevention |
|---------|------------|
| Modifying UI layout | ⛔ Requires explicit client approval |
| Hardcoding URLs | Use environment variables |
| Plaintext secrets | Use Key Vault; migration 011 removed plaintext columns |
| Bypassing auth middleware | Always use `authMiddleware` or `optionalAuthMiddleware` |
| Circular dependencies | Maintain strict layer separation |
| Missing Swagger annotations | All new routes need JSDoc for OpenAPI generation |
| Direct database schema changes | Use numbered migration files in `infra/migrations/` |
| Adding unnecessary dependencies | Justify new packages; prefer existing utilities |
