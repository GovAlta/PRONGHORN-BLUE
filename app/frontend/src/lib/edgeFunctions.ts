/**
 * Edge Functions Helper
 * 
 * Provides a unified way to call edge functions through Azure APIM.
 * 
 * Uses the same MSAL auth as apiClient for consistent authentication.
 */
import { getAccessToken } from "./apiClient";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";
const APIM_SUBSCRIPTION_KEY = import.meta.env.VITE_APIM_SUBSCRIPTION_KEY || "";

/**
 * Get the base URL for edge functions
 */
export function getEdgeFunctionsBaseUrl(): string {
  return `${API_BASE_URL}/api/v1/functions`;
}

/**
 * Get headers for edge function calls — uses MSAL token (same as apiClient)
 */
export async function getEdgeFunctionHeaders(): Promise<HeadersInit> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  
  if (APIM_SUBSCRIPTION_KEY) {
    headers["Ocp-Apim-Subscription-Key"] = APIM_SUBSCRIPTION_KEY;
  }
  
  // Use MSAL token (same as apiClient) for APIM auth
  const token = await getAccessToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  
  return headers;
}

/**
 * Invoke an edge function
 */
export async function invokeEdgeFunction<T = any>(
  functionName: string,
  body: any,
  options?: {
    stream?: boolean;
  }
): Promise<Response> {
  const url = `${getEdgeFunctionsBaseUrl()}/${functionName}`;
  const headers = await getEdgeFunctionHeaders();
  
  console.log(`[EdgeFunctions] Invoking ${functionName} -> ${url}`);
  
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/**
 * Invoke an edge function and parse JSON response
 */
export async function invokeEdgeFunctionJson<T = any>(
  functionName: string,
  body: any
): Promise<{ data: T | null; error: string | null }> {
  try {
    const response = await invokeEdgeFunction(functionName, body);
    
    if (!response.ok) {
      const errorText = await response.text();
      return { data: null, error: errorText || `HTTP ${response.status}` };
    }
    
    const data = await response.json();
    return { data, error: null };
  } catch (err: any) {
    return { data: null, error: err.message || "Unknown error" };
  }
}
