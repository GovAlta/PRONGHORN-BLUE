# pronghorn-feature Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-05-28

## Active Technologies

- TypeScript 5.x on Node 18+ (Express API)
- TypeScript 5.x on Vite 5 / React 18 (frontend)
- PostgreSQL 16 (advisory locks used for poller multi-replica safety)
- GitHub Actions workflow dispatch (`genapp-deploy.yml`) for Docker container deployments
- See `specs/006-docker-deploy-via-genapp-workflow/plan.md` for the current feature plan.

## Project Structure

```text
app/frontend/src/       # React frontend (Vite)
app/backend/src/        # Express API
infra/                  # Terraform modules + SQL migrations
.github/workflows/      # GitHub Actions
```

## Recent Changes

- 006-docker-deploy-via-genapp-workflow: New service module `app/backend/src/services/deployment/docker/`. Background poller `poller.ts`. Migration `008_deployment_dispatch_columns.sql`. Deletes legacy `app/backend/src/routes/deployment.ts` and removes `USE_GENAPP_WORKFLOW` flag.

<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->
