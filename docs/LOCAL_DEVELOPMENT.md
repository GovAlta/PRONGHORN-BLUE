# Pronghorn — Local Development Guide

Complete guide to setting up and running the full Pronghorn stack locally: **React frontend**, **Express API**, **two PostgreSQL databases** (Application + Generated Applications), and **Azure AI Foundry** models.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Local DB Port Policy Update (Mar 2026)](#local-db-port-policy-update-mar-2026)
- [Prerequisites](#prerequisites)
- [1. Clone the Repository](#1-clone-the-repository)
- [2. Set Up PostgreSQL](#2-set-up-postgresql)
- [3. Run the Schema Migration](#3-run-the-schema-migration)
- [4. Set Up the API](#4-set-up-the-api)
- [5. Set Up the Frontend](#5-set-up-the-frontend)
- [6. Verify the Stack](#6-verify-the-stack)
- [7. Quick Start — One-Command Dev Loop](#7-quick-start--one-command-dev-loop)
- [8. Azure AD / MSAL Authentication](#8-azure-ad--msal-authentication)
- [9. Azure AI Foundry — Model Deployment](#9-azure-ai-foundry--model-deployment)
- [10. Optional Services](#10-optional-services)
- [Environment Variables Reference](#environment-variables-reference)
- [Port Map](#port-map)
- [Common Commands](#common-commands)
- [Troubleshooting](#troubleshooting)

---

## Architecture Overview

| Component      | Technology                                          | Description                                                          |
| -------------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| **Frontend**   | React 18, Vite, TypeScript, Tailwind CSS, shadcn/ui | SPA served via Vite dev server (local) or nginx container (deployed) |
| **API**        | Express.js, TypeScript, Node.js 20                  | REST API with Swagger docs                                           |
| **App DB**     | PostgreSQL 16 (`db`, port 5432)                     | Pronghorn Application — system schema, user data                     |
| **GenApps DB** | PostgreSQL 16 (`db-generated-apps`, port 5433)      | Pronghorn Generated Applications — per-project databases             |
| **Auth**       | MSAL (Azure Entra ID)                               | Microsoft sign-in via `@azure/msal-browser`                          |
| **AI Models**  | Azure AI Foundry                                    | GPT-4.1, GPT-4o, o3, o4-mini                                         |

---

## Local DB Port Policy Update (Mar 2026)

- Keep Docker PostgreSQL mapped to `5432` as the local default.
- Keep `POSTGRES_PORT=5432` in `app/backend/.env`; do not hardcode `5433` as a primary setting.
- API runtime dynamically retries `5433` only when `5432` is unavailable or mismatched.
- On Windows, the PostgreSQL setup script now detects PostgreSQL-service conflicts on the target port and attempts to stop/disable those services so Docker can bind the port.

---

## Prerequisites

### Required

| Tool               | Version | Install                                                       |
| ------------------ | ------- | ------------------------------------------------------------- |
| **Node.js**        | 18+     | [nodejs.org](https://nodejs.org/)                             |
| **npm**            | 9+      | Ships with Node.js                                            |
| **Git**            | 2.x     | [git-scm.com](https://git-scm.com/)                           |
| **Docker Desktop** | Latest  | [docker.com](https://www.docker.com/products/docker-desktop/) |

### Optional (for specific features)

| Tool          | Purpose                                        | Install                                                                       |
| ------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| **Azure CLI** | Deploy AI models, manage Azure resources       | [docs.microsoft.com](https://learn.microsoft.com/cli/azure/install-azure-cli) |
| **Terraform** | Infrastructure-as-Code deployment              | [terraform.io](https://developer.hashicorp.com/terraform/install)             |
| **psql**      | Direct database access (ships with PostgreSQL) | [postgresql.org](https://www.postgresql.org/download/)                        |

---

## 1. Clone the Repository

```bash
git clone https://github.com/phb-msft-dev/pronghorn.git
cd pronghorn
```

---

## 2. Set Up PostgreSQL

Pronghorn uses **two** PostgreSQL servers:

| Server                               | Purpose                                    | Local Port | Docker Service      |
| ------------------------------------ | ------------------------------------------ | ---------- | ------------------- |
| **Pronghorn Application**            | System schema, user data, project metadata | 5432       | `db`                |
| **Pronghorn Generated Applications** | Per-project databases (`proj_{id}`)        | 5433       | `db-generated-apps` |

Choose **one** of the following options.

### Option A: Docker (recommended)

**Application database** (port 5432):

```bash
docker run -d \
  --name pronghorn-db \
  -e POSTGRES_USER=pronghorn_admin \
  -e POSTGRES_PASSWORD=localdev123 \
  -e POSTGRES_DB=pronghorn \
  -v pronghorn_db_data:/var/lib/postgresql/data \
  -p 5432:5432 \
  postgres:16-alpine
```

**Generated Applications database** (port 5433):

```bash
docker run -d \
  --name pronghorn-db-generated-apps \
  -e POSTGRES_USER=pronghorn_genapps_admin \
  -e POSTGRES_PASSWORD=localdev123 \
  -v pronghorn_genapps_db_data:/var/lib/postgresql/data \
  -p 5433:5432 \
  postgres:16-alpine
```

> ⚠️ **Container restart warning:** If the container already exists from a previous session, `docker run` will fail. Use `docker start pronghorn-db` instead. However, **`docker start` does NOT re-run the init scripts** — the database will be empty if the volume was lost. Always verify tables exist after starting the container (see Step 3) and re-run the migration if needed.

Verify both:

```bash
docker exec pronghorn-db pg_isready -U pronghorn_admin -d pronghorn
# Expected output: /var/run/postgresql:5432 - accepting connections

docker exec pronghorn-db-generated-apps pg_isready -U pronghorn_genapps_admin
# Expected output: /var/run/postgresql:5432 - accepting connections
```

### Option B: Native PostgreSQL

If PostgreSQL is already installed locally:

```bash
psql -U postgres -c "CREATE USER pronghorn_admin WITH PASSWORD 'localdev123';"
psql -U postgres -c "CREATE DATABASE pronghorn OWNER pronghorn_admin;"
psql -U postgres -c "ALTER USER pronghorn_admin WITH SUPERUSER;"
```

> **Note:** The user needs superuser (or at least `CREATE EXTENSION`) privileges because the schema creates `uuid-ossp` and `pgcrypto` extensions.

---

## 3. Run the Schema Migration

The full database schema is defined in `infra/migrations/001_full_schema.sql`. This creates all tables, functions, RPC handlers, RLS policies, and triggers.

### With Docker PostgreSQL

```bash
docker exec -i pronghorn-db psql -U pronghorn_admin -d pronghorn < infra/migrations/001_full_schema.sql
```

### With Native PostgreSQL

```bash
psql -h localhost -U pronghorn_admin -d pronghorn -f infra/migrations/001_full_schema.sql
```

### Verify

```bash
# Docker
docker exec pronghorn-db psql -U pronghorn_admin -d pronghorn -c "\dt" | head -20

# Native
psql -h localhost -U pronghorn_admin -d pronghorn -c "\dt" | head -20
```

You should see tables like `projects`, `artifacts`, `requirements`, `standards`, etc. (62 tables total).

> ⚠️ **"Did not find any relations"?** If `\dt` returns no tables, the migration hasn't been applied. This commonly happens when you restart an existing Docker container with `docker start` instead of `docker run` (which runs init scripts). Re-run the migration command above.

---

## 4. Set Up the API

### 4.1 Install Dependencies

```bash
cd app/backend
npm install
```

### 4.2 Create Environment Files

Pronghorn uses a **two-tier environment variable strategy** to minimise duplication:

| File                    | Purpose                                               | Read by                                    |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------ |
| **Root `.env`**         | Shared local-dev defaults (DB creds, auth IDs, ports) | Docker Compose (DB) + `npm run dev` script |
| **`app/backend/.env`**  | Backend-specific overrides (APIM, GitHub, deployment) | `npm run dev` script                       |
| **`app/frontend/.env`** | Frontend-specific `VITE_*` vars                       | Vite only                                  |

The backend `npm run dev` script sources the root `.env` first (shared defaults),
then sources `app/backend/.env` second — so backend-specific values override root
defaults. No application code changes are needed; the shell handles the cascade.

**Docker Compose** only runs the two database services. It reads the root `.env`
for variable substitution (DB credentials, ports).

In **production (Azure Container Apps)**, no `.env` files exist — all variables
are injected by Terraform at runtime.

#### Step 1 — Root `.env` (shared defaults)

Copy from the repo root example:

```bash
cp .env.example .env
```

Review and fill in `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID` if you have an Entra ID
App Registration. For mock-auth local dev, the defaults are sufficient.

#### Step 2 — `app/backend/.env` (backend-specific)

```bash
cp app/backend/.env.example app/backend/.env
```

Fill in backend-specific values (APIM URL, GitHub OAuth credentials, deployment
settings). Database credentials, auth IDs, and server settings are inherited from
the root `.env` automatically — no need to duplicate them here.

> **Override rule:** Any variable set in `app/backend/.env` takes priority over the
> root `.env`. To override a shared default for the backend only, add it to
> `app/backend/.env`.

#### Step 3 — `app/frontend/.env`

```bash
cp app/frontend/.env.example app/frontend/.env
```

The frontend requires `VITE_`-prefixed variables (Vite security boundary). These
cannot be shared with the root `.env`, so `VITE_ENTRA_CLIENT_ID` and
`VITE_ENTRA_TENANT_ID` must be set here separately.

### 4.3 Build and Start the API

```bash
# Development mode (hot-reload)
npm run dev

# OR build and run manually
npm run build
node dist/index.js
```

### 4.4 Verify

```bash
curl http://localhost:3001/health
# Expected: 200 OK

# Swagger docs
open http://localhost:3001/api-docs
```

---

## 5. Set Up the Frontend

### 5.1 Install Dependencies

From `app/frontend/`:

```bash
npm install
```

If npm reports a peer dependency resolution conflict (for example `ERESOLVE` with `vite-plugin-pwa`), run:

```bash
npm install --legacy-peer-deps
```

### 5.2 Create Environment File

Copy from the frontend example:

```bash
cp app/frontend/.env.example app/frontend/.env
```

Review and update the values:

- **`VITE_API_BASE_URL`** — defaults to `http://localhost:8080` (same-origin). If the
  API runs on a different port (e.g., `http://localhost:3001`), update this value.
- **`VITE_ENTRA_CLIENT_ID`** and **`VITE_ENTRA_TENANT_ID`** — must match your Azure AD
  App Registration. For local dev without Azure auth, set `VITE_AUTH_MODE=mock`
  (the default in `.env.example`).
- **`VITE_WS_URL`** — leave blank for local dev; the client auto-derives it from
  `VITE_API_BASE_URL`.

> **Important:** The `VITE_ENTRA_CLIENT_ID` and `VITE_ENTRA_TENANT_ID` must match the Azure AD App Registration configured for your environment. See [Section 8](#8-azure-ad--msal-authentication) for details.
>
> **Note:** The Vite dev server target port is `8080` (configured in `vite.config.ts`). If `8080` is already occupied, Vite may auto-fallback to another port (for example `8081`). For local auth consistency, free `8080` and restart frontend.

### 5.3 Start the Frontend

```bash
# Development mode (hot-reload with Vite)
npm run dev
```

The frontend starts on **http://localhost:8080** (configured in `vite.config.ts`).

---

## 6. Verify the Stack

1. Ensure PostgreSQL, API, and frontend are all running.
2. Open **http://localhost:8080** in your browser.
3. Sign in with your Azure AD account.
4. Create a project — the API will write to your local PostgreSQL.
5. Check the API terminal for request logs.

```
✅ Frontend:   http://localhost:8080   (Vite dev server)
✅ API:        http://localhost:3001   (Express)
✅ Database:   localhost:5432          (PostgreSQL)
✅ Swagger:    http://localhost:3001/api-docs
```

---

## 7. Quick Start — One-Command Dev Loop

A root `package.json` with [`concurrently`](https://github.com/open-cli-tools/concurrently) orchestrates all three services — databases via Docker Compose and frontend/API via native `npm run dev` — in a single terminal with color-coded, named output.

### 7.1 Overview

| Service             | How it runs                  | Port |
| ------------------- | ---------------------------- | ---- |
| `db` (Application)  | Docker Compose (postgres:16) | 5432 |
| `db-generated-apps` | Docker Compose (postgres:16) | 5433 |
| API                 | `npm run dev` (ts-node)      | 3001 |
| Frontend            | `npm run dev` (Vite)         | 8080 |

Docker Compose **only** runs the two PostgreSQL databases. The API and frontend
run natively on the host with hot-reload, matching the standard Node.js
development experience.

### 7.2 Install Root Dependencies

From the repo root (one-time setup):

```bash
npm install
```

This installs `concurrently` for parallel process orchestration.

### 7.3 Start Everything

```bash
npm run dev
```

This runs three processes in parallel:
- **`[db]`** — `docker compose up` (both PostgreSQL containers)
- **`[api]`** — `npm run dev --prefix app/backend` (Express with hot-reload)
- **`[fe]`** — `npm run dev --prefix app/frontend` (Vite with HMR)

Output is color-coded and prefixed:

```
[db]  pronghorn-db-1  | LOG:  database system is ready to accept connections
[api] 🚀 Pronghorn API Server running on port 3001
[fe]  VITE v5.x  ready in 300ms — http://localhost:8080
```

### 7.4 Start Services Individually

```bash
npm run dev:db         # Databases only (Docker Compose)
npm run dev:api        # API only (requires databases running)
npm run dev:frontend   # Frontend only (requires API running)
```

### 7.5 Stop

Press **`Ctrl+C`** to stop the API and frontend. Then stop the databases:

```bash
npm run dev:stop       # docker compose down (preserves data)
```

### 7.6 Fresh Database Reset

```bash
npm run dev:reset      # docker compose down -v && docker compose up -d
```

This wipes both database volumes and recreates the containers. The Application
database schema (`001_full_schema.sql`) is automatically applied on first init
via Docker's `docker-entrypoint-initdb.d` mechanism. Additional migrations are
applied by the API at startup via `runMigrations()`.

> **Note:** The Generated Applications database (`db-generated-apps`) has no init
> schema — per-project databases are created on demand by the API.

### 7.7 All Root Scripts

| Script                 | Command                             | Description                     |
| ---------------------- | ----------------------------------- | ------------------------------- |
| `npm run dev`          | Starts db + api + frontend          | Full stack in one terminal      |
| `npm run dev:db`       | `docker compose up`                 | Databases only                  |
| `npm run dev:api`      | `npm run dev --prefix app/backend`  | API with hot-reload             |
| `npm run dev:frontend` | `npm run dev --prefix app/frontend` | Frontend with Vite HMR          |
| `npm run dev:stop`     | `docker compose down`               | Stop databases (preserves data) |
| `npm run dev:reset`    | `docker compose down -v && up -d`   | Wipe databases and recreate     |
| `npm run build`        | Build backend then frontend         | CI-style build for both layers  |
| `npm run lint`         | Lint frontend                       | ESLint for frontend             |
| `npm run test`         | Test backend then frontend          | Jest + Vitest for both layers   |

---

## 8. Azure AD / MSAL Authentication

Pronghorn uses **Microsoft Entra ID** (Azure AD) for authentication via MSAL (Microsoft Authentication Library). Users sign in with their Microsoft account.

### 8.1 App Registration

An Azure AD App Registration is required. The following values must match your registration:

| Environment Variable      | Description                                               | Example                                |
| ------------------------- | --------------------------------------------------------- | -------------------------------------- |
| `VITE_ENTRA_CLIENT_ID`    | Application (client) ID                                   | `11111111-1111-1111-1111-111111111111` |
| `VITE_ENTRA_TENANT_ID`    | Directory (tenant) ID or `organizations` for multi-tenant | `00000000-0000-0000-0000-000000000000` |
| `VITE_AZURE_REDIRECT_URI` | Redirect URI registered in Azure AD                       | `http://localhost:8080`                |

### 8.2 Configure Redirect URIs in Azure Portal

For local development, add these redirect URIs to your App Registration:

1. Go to **Azure Portal** → **Azure Active Directory** → **App registrations** → your app
2. Under **Authentication** → **Platform configurations** → **Single-page application**
3. Add these redirect URIs:

```
http://localhost:8080              (Vite dev server)
http://localhost:8080/auth-redirect.html
```

> **Important:** Use the **Single-page application** platform for these localhost redirects. If configured under **Web** instead, you may see `AADSTS9002326` during token redemption.

### 8.3 MSAL Configuration

The MSAL config is located at `app/frontend/src/lib/msalConfig.ts`. Key settings:

- **Cache Location:** `localStorage` (persists across tabs)
- **Login scopes:** `openid`, `profile`, `email`, `User.Read`
- **API scopes:** `api://{clientId}/access_as_user` (preferred for bearer auth)
- **Authority:** `https://login.microsoftonline.com/{tenantId}`
- **Login method:** Popup-based authentication

> **Note:** The frontend uses `VITE_ENTRA_CLIENT_ID` and `VITE_ENTRA_TENANT_ID`
> (not `VITE_AZURE_*`) to stay consistent with the backend, which must avoid
> `AZURE_CLIENT_ID` due to conflicts with the `@azure/identity` SDK. See the
> `.env.example` files for details.

### 8.4 How Authentication Flows

1. User clicks **Sign In** on the frontend
2. MSAL opens a popup to Microsoft login
3. User authenticates with their Microsoft account
4. MSAL receives tokens and stores auth state in `localStorage`
5. The frontend requests an **access token** for API calls (`api://{clientId}/access_as_user`) and attaches it as `Authorization: Bearer <token>`
6. The Express API validates the token and identifies the user

---

## 9. Azure AI Foundry — Model Deployment

Pronghorn uses **Azure AI Foundry** for AI model inference (chat, code generation, reasoning, image analysis). This section covers setting up AI models for your environment.

> **Important:** Azure AI Foundry credentials are **required** for the full Pronghorn experience. AI features (chat agents, code generation, reasoning, presentation generation) will not work without them. See below for setup instructions.

### 9.1 Available Models

| Model        | Deployment Name | Best For                                     | TPM (Dev) |
| ------------ | --------------- | -------------------------------------------- | --------- |
| GPT-4.1      | `gpt-4-1`       | Coding, instruction following, long contexts | 20K       |
| GPT-4.1 Mini | `gpt-4-1-mini`  | General use, cost-effective                  | 50K       |
| GPT-4o       | `gpt-4o`        | Multimodal (text + images)                   | 30K       |
| GPT-4o Mini  | `gpt-4o-mini`   | Affordable and fast                          | 100K      |
| o3           | `o3`            | Complex reasoning                            | 10K       |
| o4-mini      | `o4-mini`       | Efficient reasoning                          | 20K       |

Model configuration is centralized in:
- **Frontend:** `app/frontend/src/config/aiModels.ts`
- **Backend API:** `app/backend/src/config/aiModels.ts`
- **Infrastructure:** `infra/config/ai-models.json`

### 9.2 Prerequisites

```bash
# Login to Azure
az login

# Set your subscription
az account set --subscription "your-subscription-id"

# Verify Cognitive Services is registered
az provider show --namespace Microsoft.CognitiveServices --query "registrationState" -o tsv
# Expected: Registered

# If not registered:
az provider register --namespace Microsoft.CognitiveServices

# Verify App Service is registered
az provider show --namespace Microsoft.AppService --query "registrationState" -o tsv
# Expected: Registered

# If not registered:
az provider register --namespace Microsoft.AppService

```

### 9.3 Deploy AI Models with Terraform

#### Step 1 — Configure Variables

Create or update `infra/params/dev.tfvars`:

```hcl
# Azure Configuration
subscription_id     = "your-subscription-id"
resource_group_name = "pronghorn-blue"
location            = "canadacentral"
project_name        = "pronghorn"
environment         = "dev"

# Enable AI Foundry
enable_ai_foundry = true

# AI Model Deployments
ai_model_deployments = [
  {
    deployment_name = "gpt-4-1"
    model_name      = "gpt-4.1"
    model_version   = "2025-04-14"
    sku_name        = "GlobalStandard"
    sku_capacity    = 20
  },
  {
    deployment_name = "gpt-4-1-mini"
    model_name      = "gpt-4.1-mini"
    model_version   = "2025-04-14"
    sku_name        = "GlobalStandard"
    sku_capacity    = 50
  },
  {
    deployment_name = "gpt-4o"
    model_name      = "gpt-4o"
    model_version   = "2024-11-20"
    sku_name        = "GlobalStandard"
    sku_capacity    = 30
  },
  {
    deployment_name = "o4-mini"
    model_name      = "o4-mini"
    model_version   = "2025-04-16"
    sku_name        = "GlobalStandard"
    sku_capacity    = 20
  }
]
```

#### Step 2 — Deploy

```bash
cd infra
terraform init
terraform plan -var-file="params/dev.tfvars"
terraform apply -var-file="params/dev.tfvars"
```

#### Step 3 — Retrieve Outputs

```bash
terraform output ai_foundry_endpoint
terraform output ai_foundry_deployed_models
```

### 9.4 Deploy AI Models with Azure CLI (Without Terraform)

```bash
# Set variables
RG="pronghorn-blue"
AI_ACCOUNT="ai-pronghorn-dev"
LOCATION="canadacentral"

# Create AI Services account (if it doesn't exist)
az cognitiveservices account create \
  --name $AI_ACCOUNT \
  --resource-group $RG \
  --kind "OpenAI" \
  --sku "S0" \
  --location $LOCATION

# Deploy GPT-4.1
az cognitiveservices account deployment create \
  --resource-group $RG \
  --name $AI_ACCOUNT \
  --deployment-name "gpt-4-1" \
  --model-name "gpt-4.1" \
  --model-version "2025-04-14" \
  --model-format "OpenAI" \
  --sku-name "GlobalStandard" \
  --sku-capacity 20

# Deploy GPT-4o
az cognitiveservices account deployment create \
  --resource-group $RG \
  --name $AI_ACCOUNT \
  --deployment-name "gpt-4o" \
  --model-name "gpt-4o" \
  --model-version "2024-11-20" \
  --model-format "OpenAI" \
  --sku-name "GlobalStandard" \
  --sku-capacity 30

# Deploy o4-mini
az cognitiveservices account deployment create \
  --resource-group $RG \
  --name $AI_ACCOUNT \
  --deployment-name "o4-mini" \
  --model-name "o4-mini" \
  --model-version "2025-04-16" \
  --model-format "OpenAI" \
  --sku-name "GlobalStandard" \
  --sku-capacity 20

# List deployments
az cognitiveservices account deployment list \
  --resource-group $RG \
  --name $AI_ACCOUNT \
  -o table

# Get endpoint and keys
az cognitiveservices account show \
  --resource-group $RG \
  --name $AI_ACCOUNT \
  --query "properties.endpoint" -o tsv

az cognitiveservices account keys list \
  --resource-group $RG \
  --name $AI_ACCOUNT \
  --query "key1" -o tsv
```

### 9.5 Deploy AI Models with PowerShell Script

```powershell
cd infra/scripts

# List current deployments
.\Deploy-AIModels.ps1 `
  -ResourceGroupName "pronghorn-blue" `
  -AIServicesName "ai-pronghorn-dev" `
  -ListModels

# Deploy all configured models from infra/config/ai-models.json
.\Deploy-AIModels.ps1 `
  -ResourceGroupName "pronghorn-blue" `
  -AIServicesName "ai-pronghorn-dev"

# Deploy a specific model
.\Deploy-AIModels.ps1 `
  -ResourceGroupName "pronghorn-blue" `
  -AIServicesName "ai-pronghorn-dev" `
  -DeployModel "gpt-4-1"
```

### 9.6 Configure the API to Use AI Models

Add to your `app/backend/.env`:

```env
# APIM gateway URL for AI calls (from terraform output or az cli)
APIM_OPENAI_URL=https://apim-pronghorn-xxx.azure-api.net/openai
```

### 9.7 Verify AI Models

```bash
# Test a model endpoint directly
curl "https://ai-pronghorn-dev.services.ai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-01-preview" \
  -H "Content-Type: application/json" \
  -H "api-key: YOUR_API_KEY" \
  -d '{
    "messages": [{"role": "user", "content": "Hello, what is Pronghorn?"}],
    "max_tokens": 100
  }'
```

### 9.8 Cost Estimates

| Model        | Input (per 1M tokens) | Output (per 1M tokens) |
| ------------ | --------------------- | ---------------------- |
| GPT-4.1 Mini | ~$0.70                | ~$2.10                 |
| GPT-4.1      | ~$3.50                | ~$10.50                |
| GPT-4o       | ~$2.50                | ~$10.00                |
| GPT-4o Mini  | ~$0.15                | ~$0.60                 |
| o4-mini      | ~$1.93                | ~$5.78                 |
| o3           | ~$3.50                | ~$10.50                |

---

## 10. Optional Services

### 10.1 Azure Blob Storage for Staged Content

Blob-backed staged file content uses Azure Storage with Azure identity authentication.
For local development, sign in with Azure CLI and point the API at a dev storage account:

```bash
az login
```

Add to `app/backend/.env`:

```env
AZURE_STORAGE_ACCOUNT_NAME=stpronghornvdqf8a
```

Your signed-in Azure identity needs `Storage Blob Data Contributor` on the storage account.

### 10.2 WebSocket (Realtime Collaboration)

Realtime collaboration uses native WebSocket built into the API server. No external service is required.

- **Local development**: WebSocket is available at `ws://localhost:3001/ws` when the API is running.
- **Azure deployment**: WebSocket is proxied through APIM or Container Apps ingress.

The frontend connects automatically when `VITE_WS_URL` is set in `app/frontend/.env`.
For local development, leave `VITE_WS_URL` blank — the client auto-derives it from
`VITE_API_BASE_URL`.

---

## Environment Variables Reference

### Shared — Root `.env`

Variables defined once in the repo-root `.env`. Read by Docker Compose directly
and by the backend API as a fallback (via `dotenv`).

| Variable                    | Required | Default       | Description                                                  |
| --------------------------- | -------- | ------------- | ------------------------------------------------------------ |
| `POSTGRES_HOST`             | ✅        | `localhost`   | App DB hostname (`db` in Docker, `localhost` for native dev) |
| `POSTGRES_PORT`             | —        | `5432`        | App DB port                                                  |
| `POSTGRES_DB`               | —        | `pronghorn`   | App DB name                                                  |
| `POSTGRES_USER`             | ✅        | —             | App DB user                                                  |
| `POSTGRES_PASSWORD`         | ✅        | —             | App DB password                                              |
| `POSTGRES_SSL`              | —        | `false`       | Enable SSL for App DB                                        |
| `POSTGRES_GENAPPS_HOST`     | ✅        | `localhost`   | GenApps DB hostname (`db-generated-apps` in Docker)          |
| `POSTGRES_GENAPPS_PORT`     | —        | `5433`        | GenApps DB port (5433 locally, 5432 inside Docker network)   |
| `POSTGRES_GENAPPS_USER`     | ✅        | —             | GenApps DB user                                              |
| `POSTGRES_GENAPPS_PASSWORD` | ✅        | —             | GenApps DB password                                          |
| `POSTGRES_GENAPPS_SSL`      | —        | `false`       | Enable SSL for GenApps DB                                    |
| `ENTRA_TENANT_ID`           | ✅        | —             | Entra ID Directory (tenant) ID                               |
| `ENTRA_CLIENT_ID`           | ✅        | —             | Entra ID Application (client) ID                             |
| `PORT`                      | —        | `3001`        | API listen port                                              |
| `API_PORT`                  | —        | `3001`        | Docker host port → API container (CI/CD only)                |
| `NODE_ENV`                  | —        | `development` | Environment (`development` / `production`)                   |
| `LOG_LEVEL`                 | —        | `info`        | Winston log level: debug, info, warn, error                  |
| `ALLOWED_ORIGINS`           | —        | `http://localhost:8081,http://localhost:8080` | CORS origins (comma-separated)                               |
| `JWT_SECRET`                | ✅        | —             | JWT signing secret                                           |
| `SKIP_AUTH`                 | —        | `true`        | `true` to bypass auth in local dev                           |
| `FRONTEND_PORT`             | —        | `8081`        | Frontend port (used by orchestration scripts)                |

### API-only — `app/backend/.env`

Variables specific to the backend. Not needed in the root file.

| Variable                      | Required | Default     | Description                                      |
| ----------------------------- | -------- | ----------- | ------------------------------------------------ |
| `APIM_OPENAI_URL`             | —        | —           | APIM gateway URL for AI calls                    |
| `GITHUB_APP_ID`               | —        | —           | GitHub App ID                                    |
| `GITHUB_APP_INSTALLATION_ID`  | —        | —           | GitHub App installation ID                       |
| `GITHUB_APP_PRIVATE_KEY`      | —        | —           | GitHub App private key (PEM contents)            |
| `GITHUB_ORG`                  | —        | —           | GitHub organization for deployed app repos       |
| `STORAGE_BASE_PATH`           | —        | `./storage` | Local file storage root                          |
| `AZURE_STORAGE_ACCOUNT_NAME`  | —        | —           | Azure Storage account name for blob-backed staged file content; local dev authenticates with `az login` |
| `AZURE_STORAGE_TIMEOUT_MS`   | —        | `3000`      | Azure Storage operation timeout in milliseconds  |
| `WS_URL`                      | —        | —           | Public WebSocket URL returned to clients         |
| `API_BASE_URL`                | —        | —           | Public base URL of this API                      |
| `FRONTEND_URL`                | —        | —           | Frontend URL for OAuth redirect callbacks        |
| `AZURE_SUBSCRIPTION_ID`       | —        | —           | Azure subscription ID for deployment             |
| `AZURE_DEPLOY_RESOURCE_GROUP` | —        | —           | Azure resource group for deployment              |
| `AZURE_ACR_NAME`              | —        | —           | Azure Container Registry name                    |
| `AZURE_ACR_LOGIN_SERVER`      | —        | —           | ACR login server FQDN                            |
| `AZURE_CONTAINER_APPS_ENV`    | —        | —           | Container Apps environment resource ID           |

### Frontend — `app/frontend/.env`

| Variable                     | Required | Default                  | Description                                                 |
| ---------------------------- | -------- | ------------------------ | ----------------------------------------------------------- |
| `VITE_API_BASE_URL`          | ✅        | —                        | API URL (e.g., `http://localhost:8080`)                     |
| `VITE_APIM_SUBSCRIPTION_KEY` | —        | —                        | APIM key (leave blank for local dev)                        |
| `VITE_AUTH_MODE`             | —        | `mock`                   | `msal` for Microsoft sign-in, `mock` for local testing      |
| `VITE_ENTRA_CLIENT_ID`       | ✅        | —                        | Entra ID App Registration client ID                         |
| `VITE_ENTRA_TENANT_ID`       | ✅        | —                        | Entra ID tenant ID or `organizations`                       |
| `VITE_AZURE_REDIRECT_URI`    | —        | `window.location.origin` | MSAL redirect URI                                           |
| `VITE_WS_URL`                | —        | (auto-derived)           | WebSocket URL for realtime; auto-derived from `VITE_API_BASE_URL` if blank |
| `VITE_GITHUB_ORG`            | —        | —                        | Default GitHub organization in repository dialogs           |

> ⚠️ **Vite env file priority:** `.env` → `.env.local` → `.env.[mode]` → `.env.[mode].local`. When building for containers, use `npx vite build --mode development` to ensure `.env.local` takes effect over `.env.production`.

---

## Port Map

| Service                     | Default Port                         | Configurable Via                      |
| --------------------------- | ------------------------------------ | ------------------------------------- |
| Vite dev server (frontend)  | 8080                                 | `vite.config.ts` → `server.port`      |
| Express API                 | 3001                                 | Root `.env` → `PORT`                  |
| PostgreSQL (Application)    | 5432 (runtime can fail over to 5433) | Root `.env` → `POSTGRES_PORT`         |
| PostgreSQL (Generated Apps) | 5433                                 | Root `.env` → `POSTGRES_GENAPPS_PORT` |
| Azurite Blob                | 10000                                | `--blobPort` flag                     |
| Swagger UI                  | 3001                                 | Same as API port, at `/api-docs`      |

---

## Common Commands

### Quick Start (Recommended)

| Action           | Command             | Directory |
| ---------------- | ------------------- | --------- |
| Start full stack | `npm run dev`       | repo root |
| Stop databases   | `npm run dev:stop`  | repo root |
| Reset databases  | `npm run dev:reset` | repo root |
| Build all        | `npm run build`     | repo root |
| Lint frontend    | `npm run lint`      | repo root |
| Test all         | `npm run test`      | repo root |

### Individual Services

| Action               | Command                                                                                     | Directory       |
| -------------------- | ------------------------------------------------------------------------------------------- | --------------- |
| Start frontend (dev) | `npm run dev`                                                                               | `app/frontend/` |
| Start API (dev)      | `npm run dev`                                                                               | `app/backend/`  |
| Build frontend       | `npm run build`                                                                             | `app/frontend/` |
| Build API            | `npm run build`                                                                             | `app/backend/`  |
| Run migration        | `psql -h localhost -U pronghorn_admin -d pronghorn -f infra/migrations/001_full_schema.sql` | repo root       |
| Lint frontend        | `npm run lint`                                                                              | `app/frontend/` |
| API health check     | `curl http://localhost:3001/health`                                                         | anywhere        |
| API Swagger          | Open `http://localhost:3001/api-docs`                                                       | browser         |

### Database (Docker Compose)

| Action                 | Command                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- |
| Start databases        | `docker compose up -d`                                                              |
| Stop (preserve data)   | `docker compose down`                                                               |
| Stop + wipe data       | `docker compose down -v`                                                            |
| View DB logs           | `docker compose logs -f`                                                            |
| Run SQL in App DB      | `docker compose exec db psql -U pronghorn_admin -d pronghorn`                       |
| Run SQL in GenApps DB  | `docker compose exec db-generated-apps psql -U pronghorn_genapps_admin -d postgres` |
| Check container status | `docker compose ps`                                                                 |

---

## Troubleshooting

| Problem                                                                            | Solution                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Port 5432 already in use**                                                       | Another PostgreSQL instance is running. Keep `POSTGRES_PORT=5432`; the PostgreSQL setup script now stops/disables conflicting Windows PostgreSQL services when possible, and API runtime can auto-fail over to `5433` when needed.                                                                                                                                                    |
| **Port 3001 already in use**                                                       | Change `PORT` in root `.env` and update `VITE_API_BASE_URL` in `app/frontend/.env`                                                                                                                                                                                                                                                                                                   |
| **CORS errors in browser**                                                         | Ensure `ALLOWED_ORIGINS` in root `.env` includes your frontend URL (e.g., `http://localhost:8080,http://localhost:8081`)                                                                                                                                                                                                                                                              |
| **Database connection refused**                                                    | Verify PostgreSQL is running: `pg_isready -h localhost` or `docker ps`                                                                                                                                                                                                                                                                                                                |
| **Migration fails on extensions**                                                  | Ensure your DB user has superuser privileges                                                                                                                                                                                                                                                                                                                                          |
| **Frontend shows Azure data after build**                                          | You built with `npm run build` (production mode). Use `npx vite build --mode development` instead                                                                                                                                                                                                                                                                                     |
| **Frontend `npm install` fails with `ERESOLVE` (`vite-plugin-pwa` peer conflict)** | Run `npm install --legacy-peer-deps` in `app/frontend/`                                                                                                                                                                                                                                                                                                                               |
| **Projects from Azure appear locally**                                             | Clear browser cache/service worker: DevTools → Application → Storage → Clear site data. Or use Incognito                                                                                                                                                                                                                                                                              |
| **MSAL redirect fails**                                                            | Ensure `http://localhost:8080` (or your port) is registered as a redirect URI in Azure AD App Registration                                                                                                                                                                                                                                                                            |
| **AI features not working**                                                        | Verify `APIM_OPENAI_URL` is set in `app/backend/.env`. See [Section 9](#9-azure-ai-foundry--model-deployment)                                                                                                                                                                                                                                                                        |
| **Realtime/live collab not working**                                               | Ensure the API is running. `VITE_WS_URL` is auto-derived from `VITE_API_BASE_URL` when blank                                                                                                                                                                                                                                                                                         |
| **`MODULE_NOT_FOUND` in API**                                                      | Run `npm install` inside the `app/backend/` directory                                                                                                                                                                                                                                                                                                                                 |
| **`Cannot find module 'dist/index.js'`**                                           | Run `npm run build` inside the `app/backend/` directory before starting in production mode                                                                                                                                                                                                                                                                                            |
| **`npm run dev` starts frontend when you expect API**                              | You ran the command from repo root — this now starts the full stack. For API only, use `npm run dev:api` or `cd app/backend && npm run dev`                                                                                                                                                                                                                                           |
| **"Failed to create project"**                                                     | Common causes: (1) no tables, (2) DB port conflict, or (3) stale auth token. Verify tables with `docker exec pronghorn-db psql -U pronghorn_admin -d pronghorn -c "\dt"`; API now auto-fails over from `5432` to `5433` when needed; hard refresh browser after auth changes                                                                                                          |
| **TypeScript errors in `functions.ts`**                                            | If `npm run dev` crashes with "Property X does not exist on type 'never'", add explicit `: any` type annotations to variables initialized as `null`. See `app/backend/src/routes/functions.ts` for examples                                                                                                                                                                           |
| **`ALLOWED_ORIGINS` mismatch**                                                     | The Vite dev server runs on port `8080` (not `5173`). Ensure root `.env` has `ALLOWED_ORIGINS=http://localhost:8081,http://localhost:8080`                                                                                                                                                                                                                                            |
| **Frontend started on `8081` unexpectedly**                                        | Port `8080` is already occupied, so Vite auto-falls back. Free `8080` and restart frontend                                                                                                                                                                                                                                                                                            |
| **SCRAM-SERVER-FIRST-MESSAGE: client password must be a string**                   | The `dotenv` `config()` call must execute **before** any module that reads `process.env.POSTGRES_*`. In `app/backend/src/index.ts`, `config()` must be called before importing routes/database modules. Also ensure `app/backend/.env` has **no UTF-8 BOM** — PowerShell's `Set-Content -Encoding UTF8` adds one. Use `UTF8NoBOM` encoding or write the file from your editor instead |
| **`.env` created by PowerShell has BOM**                                           | If you used `Set-Content -Encoding UTF8` to create `app/backend/.env`, it contains a UTF-8 BOM that can corrupt env var parsing. Rewrite with: `[IO.File]::WriteAllText("app/backend/.env", (Get-Content "app/backend/.env" -Raw), [Text.UTF8Encoding]::new($false))`                                                                                                                 |

---

*Last updated: June 2026*
