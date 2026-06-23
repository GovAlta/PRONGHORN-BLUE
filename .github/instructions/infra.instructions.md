---
applyTo: "infra/**"
---

# Infrastructure Layer — Pronghorn IaC

## Stack

- Terraform 1.x, Azure provider (azurerm)
- Modules under `infra/modules/`: APIM, Container Apps, Container Registry, PostgreSQL, Key Vault, Storage, AI Foundry, Front Door, etc.

## Structure

- Main config: `infra/main.tf`, `infra/variables.tf`, `infra/outputs.tf`, `infra/locals.tf`
- Modules: `infra/modules/<service>/`
- Environment params: `infra/params/` (example: `tfvars.example`)
- Scripts: `infra/scripts/`
- AI model config: `infra/config/ai-models.json`
- Rollback config: `infra/config/rollback-component-sets.json`

## Patterns

- Prefer modifying existing modules over creating parallel definitions.
- Keep APIM/Container Apps/PostgreSQL/Foundry integration consistent with current architecture.
- Never commit secrets — use Key Vault references, managed identity, env vars.
- Validate with `terraform plan` before apply.

## Migrations

- SQL migrations in `infra/migrations/`
- Baseline: `001_full_schema.sql` (62 tables, RLS policies)
- Migrations are part of the API layer workflow but stored here.

## MCP Tools Available

- **Azure Terraform MCP** (`@azure/terraform-mcp-server`): AzureRM/AzAPI provider documentation, Azure Verified Modules lookup, aztfexport resource export, conftest policy validation
- **Azure MCP**: Terraform best practices (`get_azure_best_practices`), deployment guidance, 40+ Azure service namespaces

## External Skills Available

- `azure-deploy` — deployment execution
- `azure-validate` — pre/post deployment validation
- `azure-enterprise-infra-planner` — architecture design, Terraform guidance
- `azure-compliance` — security audits, best practice scans
- `azure-cost` — cost management, optimization
