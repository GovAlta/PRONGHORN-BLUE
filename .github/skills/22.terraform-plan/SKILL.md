---
name: 22.terraform-plan
description: Runs terraform plan in the infra/ directory with the specified environment tfvars file. Uses Azure Terraform MCP for provider documentation context during review.
argument-hint: Specify environment (dev, test, prod)
compatibility:
  - linux
  - macos
license: MIT
user-invokable: true
---

# Terraform Plan — Infrastructure Change Preview

## Pre-requisites
- Terraform 1.x installed
- Azure CLI authenticated (`az login`)
- Access to the target Azure subscription
- Environment tfvars file exists in `infra/params/` (e.g., `dev.tfvars`)

## Steps

1. **Initialize Terraform** (if not already done):
   ```bash
   cd infra && terraform init
   ```

2. **Run plan with environment tfvars**:
   ```bash
   cd infra && terraform plan -var-file=params/<environment>.tfvars -out=tfplan
   ```
   Replace `<environment>` with `dev`, `test`, or `prod`.

3. **Review the plan output**:
   - Check resources to be added, changed, or destroyed.
   - Use the Azure Terraform MCP to look up provider documentation for any unfamiliar resource types.
   - Verify no unexpected destructive changes.

## Validation
- Plan must complete without errors.
- Review all resource changes before proceeding to apply.
- Destructive changes (destroy/replace) require explicit acknowledgment.

## Trigger
- Before applying any infrastructure changes.
- As part of the deployment agent workflow.
- When modifying files in `infra/`.

## Rollback
- Terraform plan is read-only — no rollback needed.
- If applied changes need reverting, use the deployment-rollback workflow.

## Ownership
- Infrastructure team / DevOps.
