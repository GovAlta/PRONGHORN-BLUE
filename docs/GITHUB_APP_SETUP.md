# GitHub App Setup

**Last Updated:** 2026-03-06

Pronghorn uses a **GitHub App** (server-to-server) to create, sync, and manage
repositories on behalf of the platform — no per-user OAuth login and no Personal
Access Tokens (PATs) required. The API mints a short-lived **installation token**
from the App's credentials and uses it for all repository and workflow-dispatch
operations. Repositories are always created inside the configured organization.

---

## Prerequisites

- A GitHub organization where customer repositories will be created
- Org-owner (or App manager) permission to create and install a GitHub App
- Admin access to the Pronghorn API environment variables (`app/backend/.env`)

---

## 1. Register a GitHub App

1. Go to **GitHub → Organization Settings → Developer settings → GitHub Apps**
   `https://github.com/organizations/<org>/settings/apps`
2. Click **New GitHub App**
3. Fill in the form:

   | Field | Value |
   |---|---|
   | **GitHub App name** | `Pronghorn` (or any descriptive name) |
   | **Homepage URL** | Your frontend URL (e.g., `http://localhost:8080`) |
   | **Webhook** | Uncheck **Active** (Pronghorn does not consume webhooks) |

4. Under **Repository permissions**, grant:

   | Permission | Access | Why |
   |---|---|---|
   | **Administration** | Read & write | Create repositories in the org |
   | **Contents** | Read & write | Commit and push files |
   | **Metadata** | Read-only | Mandatory baseline |
   | **Actions** | Read & write | Dispatch and read workflow runs |
   | **Workflows** | Read & write | Push `.github/workflows/*` from templates |

5. Set **Where can this GitHub App be installed?** to **Only on this account**
6. Click **Create GitHub App**
7. Copy the **App ID** shown at the top of the App's settings page
8. Under **Private keys**, click **Generate a private key** and download the
   `.pem` file (it is shown only once)

### Install the App

1. From the App settings, open **Install App** and install it on your org
2. Choose **All repositories** (or selected repositories that include the
   platform workflow repo)
3. After installing, the browser URL ends in `.../installations/<installation-id>` —
   copy that **Installation ID**

---

## 2. Configure Environment Variables

### Local Development

Add the credentials to `app/backend/.env`:

```env
# GitHub App
GITHUB_ORG=<your-org>
GITHUB_APP_ID=<your-app-id>
GITHUB_APP_INSTALLATION_ID=<your-installation-id>
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
```

> The private key is the full PEM contents. When stored in a single-line `.env`
> value, embed newlines as `\n` (the API normalizes them at load time).
> `GITHUB_ORG` is **required** — every repository is created inside this org.

### Azure Deployment (Key Vault)

In production, the GitHub App private key is stored in Azure Key Vault and
injected into the Container App as a secret environment variable. This follows
the same pattern as `POSTGRES_PASSWORD` and other sensitive values. The non-secret
`github_app_id` and `github_app_installation_id` are set in the `*.tfvars` file.

**Option A: Via Terraform** (recommended)

**Option A: Via Terraform** (recommended)

Set the private key as an environment variable before running `terraform apply`
(the `github_app_id` / `github_app_installation_id` values live in the tfvars file):

```powershell
$env:TF_VAR_github_app_private_key = Get-Content -Raw ./pronghorn-app.private-key.pem
```

Terraform will:
1. Store the key in Key Vault as `github-app-private-key`
2. Map it to the Container App as the `GITHUB_APP_PRIVATE_KEY` env var
3. Set `GITHUB_APP_ID` and `GITHUB_APP_INSTALLATION_ID` as plain env vars from tfvars

**Option B: Via Azure CLI** (manual override)

Store the secret directly in Key Vault:

```bash
az keyvault secret set --vault-name "<kv-name>" --name "github-app-private-key" --file ./pronghorn-app.private-key.pem
```

Then update the Container App to reference it:

```bash
az containerapp secret set --name ca-pronghorn-api --resource-group <rg-name> \
  --secrets github-app-private-key=keyvaultref:<kv-uri>/secrets/github-app-private-key,identityref:system

az containerapp update --name ca-pronghorn-api --resource-group <rg-name> \
  --set-env-vars GITHUB_APP_PRIVATE_KEY=secretref:github-app-private-key \
                 GITHUB_APP_ID=<app-id> \
                 GITHUB_APP_INSTALLATION_ID=<installation-id>
```

> The Container App's system-assigned managed identity must have `Get` permission on Key Vault secrets. This is configured automatically by the Terraform keyvault module.

---

## 3. Rebuild the API

After updating `app/backend/.env`, rebuild and restart the API container:

```bash
cd app/backend && npm run build
cd .. && docker compose up -d --build --force-recreate api
```

Verify the GitHub App is configured:

```bash
curl -s http://localhost:3001/api/v1/github/auth/status | jq .
```

You should see a response like:

```json
{
  "connected": true,
  "githubUsername": "<your-org>"
}
```

`connected: true` means the API found valid `GITHUB_APP_ID`,
`GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY` values.

---

## 4. Use GitHub Features

The GitHub App is shared across the platform, so there is no per-user connect
step. Once the App is configured, any project's **Repository** page can create,
sync, and manage repositories immediately. The Repository page shows the
platform's connection status derived from `/github/auth/status`.

---

## How It Works

### Installation Token Flow

```
API                                            GitHub
 │                                              │
 │  Sign a short-lived App JWT (App ID + key)   │
 │  POST /app/installations/<id>/access_tokens  │
 │─────────────────────────────────────────────>│
 │  { token, expires_at }  (~1 hour)            │
 │<─────────────────────────────────────────────│
 │                                              │
 │  Use token for repo + workflow operations    │
 │  e.g. POST /orgs/<org>/repos                  │
 │─────────────────────────────────────────────>│
```

The token is minted on demand by `getInstallationToken()` in
`app/backend/src/utils/githubAppAuth.ts` and resolved centrally through
`resolveGitHubToken()` in `app/backend/src/utils/githubAuth.ts`. The resolution
chain is: per-repo PAT → **GitHub App installation token** → system env token.
Commits are attributed to the App's bot identity.

### API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/github/auth/status` | Optional | Returns whether the GitHub App is configured |
| `DELETE` | `/api/v1/github/auth/disconnect` | Required | No-op retained for frontend compatibility |

> The legacy OAuth endpoints (`/auth/url`, `/auth/callback`) have been removed.

### Repository Creation

When a user creates a repo, Pronghorn:

1. Mints an installation token from the GitHub App credentials
2. Calls `POST https://api.github.com/orgs/<GITHUB_ORG>/repos` to create the repo
   inside the configured organization
3. Stores the actual repo owner (from GitHub's response) in the project database

---

## Troubleshooting

### "GitHub is not configured"
The API cannot find a valid `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, or
`GITHUB_APP_PRIVATE_KEY` in its environment. Check that `app/backend/.env` has
all three set and the container was rebuilt.

### "Resource not accessible by integration"
The GitHub App is missing a required permission. Confirm the App grants
**Administration** (R/W), **Contents** (R/W), **Actions** (R/W), and
**Workflows** (R/W). After changing permissions, re-approve the installation on
the org (GitHub prompts the org owner to accept new permissions).

### "Not Found" when creating a repo
Confirm `GITHUB_ORG` matches the org the App is installed on, and that the App
installation includes that org with **All repositories** access.

### 401 when minting the installation token
The private key (`GITHUB_APP_PRIVATE_KEY`) does not match the App, or the App
ID / Installation ID is wrong. Regenerate the key from the App settings if lost
and update the env var / Key Vault secret.

---

## Security Notes

- The App private key is stored in Azure Key Vault in production and injected as an env var via Container Apps secret references — never committed to source control
- In local dev, the key lives in `app/backend/.env` which is gitignored
- The frontend never has access to the private key — only the API server-side code
- Installation tokens are short-lived (~1 hour) and minted on demand, never persisted
- Scope the App to **Only on this account** and grant least-privilege permissions
- Rotate the private key periodically from the App settings page
