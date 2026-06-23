import { pronghornApi } from "@/integrations/pronghorn-api/client";

interface SecretsResponse {
  secrets: Record<string, string>;
  envVars: Record<string, string>;
}

/**
 * Get decrypted secrets for a deployment
 * Secrets are encrypted at rest and only decrypted when accessed via this function
 */
export async function getDeploymentSecrets(
  deploymentId: string,
  shareToken: string | null
): Promise<SecretsResponse> {
  const { data, error } = await pronghornApi.functions.invoke("deployment-secrets", {
    body: {
      action: "get",
      deploymentId,
      shareToken,
    },
  });

  if (error) {
    console.error("[deploymentSecrets] Get failed:", error);
    throw new Error(error.message || "Failed to get deployment secrets");
  }

  return data as SecretsResponse;
}

/**
 * Set encrypted secrets for a deployment
 * Secrets are encrypted before storage - the raw values never touch the database
 */
export async function setDeploymentSecrets(
  deploymentId: string,
  shareToken: string | null,
  options: {
    secrets?: Record<string, string>;
    envVars?: Record<string, string>;
  }
): Promise<void> {
  const { error } = await pronghornApi.functions.invoke("deployment-secrets", {
    body: {
      action: "set",
      deploymentId,
      shareToken,
      secrets: options.secrets,
      envVars: options.envVars,
    },
  });

  if (error) {
    console.error("[deploymentSecrets] Set failed:", error);
    throw new Error(error.message || "Failed to set deployment secrets");
  }
}

/**
 * Generate a 256-bit hex encryption key for SECRETS_ENCRYPTION_KEY
 * Run this in browser console: generateEncryptionKey()
 */
export function generateEncryptionKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Make available in console for key generation
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).generateEncryptionKey = generateEncryptionKey;
}
