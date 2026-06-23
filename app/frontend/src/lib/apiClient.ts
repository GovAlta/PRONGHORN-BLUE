/**
 * API Client for Azure Backend
 * 
 * This client wraps fetch calls to the Azure backend.
 * Authentication is handled via MSAL which provides Bearer tokens
 * for cross-origin API calls.
 */

import { InteractionRequiredAuthError } from "@azure/msal-browser";
import { msalInstance } from "./msalInstance";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";
const APIM_SUBSCRIPTION_KEY = import.meta.env.VITE_APIM_SUBSCRIPTION_KEY || "";

// Check if API is same-origin
const isSameOrigin = (): boolean => {
  if (!API_BASE_URL) return true;
  try {
    const apiUrl = new URL(API_BASE_URL, window.location.origin);
    return apiUrl.origin === window.location.origin;
  } catch {
    return true;
  }
};

/**
 * Get access token from MSAL for API calls.
 * Returns the ID token (audience = client ID) for APIM JWT validation.
 * Uses minimal OIDC scopes to avoid consent issues with resource-specific scopes.
 */
export async function getAccessToken(): Promise<string | null> {
  try {
    const accounts = msalInstance.getAllAccounts();
    if (accounts.length === 0) {
      console.log("[ApiClient] No accounts found");
      return null;
    }

    const account = accounts[0];
    
    // Use only OIDC scopes - this returns an idToken with aud = our app's client_id
    // which is what APIM validate-jwt expects
    const response = await msalInstance.acquireTokenSilent({
      scopes: ["openid", "profile", "email"],
      account,
    });

    // Always use idToken - it has aud = our client_id
    // accessToken from these scopes has aud = Graph which APIM rejects
    return response.idToken || null;
  } catch (error) {
    console.warn("[ApiClient] Silent token acquisition failed:", error);

    // When the refresh token is expired (e.g. long absence), MSAL throws
    // InteractionRequiredAuthError. Fall back to an interactive popup so
    // the user can re-authenticate and resume their workflow.
    if (error instanceof InteractionRequiredAuthError) {
      try {
        const response = await msalInstance.acquireTokenPopup({
          scopes: ["openid", "profile", "email"],
        });
        return response.idToken || null;
      } catch (popupError) {
        console.error("[ApiClient] Interactive token acquisition failed:", popupError);
      }
    }

    return null;
  }
}

export interface ApiUser {
  id: string;
  email: string;
  name?: string;
  role?: string;
}

export interface AuthResponse {
  user: ApiUser;
  token: string;
}

export interface ApiError {
  message: string;
  code?: string;
  statusCode?: number;
}

// Token storage (kept for backward compatibility and offline caching)
const TOKEN_KEY = "pronghorn_auth_token";
const USER_KEY = "pronghorn_auth_user";
// Legacy keys (for migration from old auth_token key)
const LEGACY_TOKEN_KEY = "auth_token";

export function getStoredToken(): string | null {
  let token = localStorage.getItem(TOKEN_KEY);
  
  // Check for legacy token and migrate if found
  if (!token) {
    const legacyToken = localStorage.getItem(LEGACY_TOKEN_KEY);
    if (legacyToken) {
      // Migrate to new key
      localStorage.setItem(TOKEN_KEY, legacyToken);
      localStorage.removeItem(LEGACY_TOKEN_KEY);
      token = legacyToken;
      console.log("[ApiClient] Migrated auth token from legacy key");
    }
  }
  
  return token;
}

export function getStoredUser(): ApiUser | null {
  const userData = localStorage.getItem(USER_KEY);
  return userData ? JSON.parse(userData) : null;
}

export function setAuthData(token: string, user: ApiUser): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearAuthData(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  // Also clear legacy key if it exists
  localStorage.removeItem(LEGACY_TOKEN_KEY);
}

class ApiClient {
  private baseUrl: string;
  private subscriptionKey: string;
  private cachedToken: string | null = null;
  private tokenFetchPromise: Promise<string | null> | null = null;

  constructor(baseUrl: string, subscriptionKey: string) {
    this.baseUrl = baseUrl;
    this.subscriptionKey = subscriptionKey;
  }

  // Get access token from MSAL (with caching to avoid repeated calls)
  private async getMsalToken(): Promise<string | null> {
    // If we have a cached token, use it
    if (this.cachedToken) {
      return this.cachedToken;
    }

    // If a fetch is already in progress, wait for it
    if (this.tokenFetchPromise) {
      return this.tokenFetchPromise;
    }

    // Fetch new token from MSAL
    this.tokenFetchPromise = getAccessToken().then(token => {
      this.cachedToken = token;
      // Clear cache after 5 minutes to ensure token freshness
      setTimeout(() => {
        this.cachedToken = null;
      }, 5 * 60 * 1000);
      this.tokenFetchPromise = null;
      return token;
    }).catch(() => {
      this.tokenFetchPromise = null;
      return null;
    });

    return this.tokenFetchPromise;
  }

  private async getHeaders(includeAuth: boolean = true): Promise<HeadersInit> {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };

    if (this.subscriptionKey) {
      headers["Ocp-Apim-Subscription-Key"] = this.subscriptionKey;
    }

    // Always include Bearer token for API calls when authenticated
    if (includeAuth) {
      const token = await this.getMsalToken();
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
    }

    return headers;
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      let errorMessage = `Request failed with status ${response.status}`;
      try {
        const errorData = await response.json();
        errorMessage = errorData.message || errorData.error || errorMessage;
      } catch {
        // Response body may not be JSON
      }
      
      const error: ApiError = {
        message: errorMessage,
        statusCode: response.status,
      };
      throw error;
    }

    // Handle 204 No Content (e.g. DELETE responses)
    if (response.status === 204 || response.headers.get("content-length") === "0") {
      return undefined as T;
    }

    return response.json();
  }

  async get<T>(endpoint: string): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    console.log(`[ApiClient] GET ${url}`);
    const response = await fetch(url, {
      method: "GET",
      headers: await this.getHeaders(),
      credentials: isSameOrigin() ? "include" : "same-origin", // Include cookies for same-origin
    });
    return this.handleResponse<T>(response);
  }

  async post<T>(endpoint: string, data?: any, includeAuth: boolean = true): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    console.log(`[ApiClient] POST ${url}`);
    const response = await fetch(url, {
      method: "POST",
      headers: await this.getHeaders(includeAuth),
      credentials: isSameOrigin() ? "include" : "same-origin",
      body: data ? JSON.stringify(data) : undefined,
    });
    return this.handleResponse<T>(response);
  }

  async put<T>(endpoint: string, data?: any): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: "PUT",
      headers: await this.getHeaders(),
      credentials: isSameOrigin() ? "include" : "same-origin",
      body: data ? JSON.stringify(data) : undefined,
    });
    return this.handleResponse<T>(response);
  }

  async delete<T>(endpoint: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: "DELETE",
      headers: await this.getHeaders(),
      credentials: isSameOrigin() ? "include" : "same-origin",
    });
    return this.handleResponse<T>(response);
  }

  async patch<T>(endpoint: string, data?: any): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: "PATCH",
      headers: await this.getHeaders(),
      credentials: isSameOrigin() ? "include" : "same-origin",
      body: data ? JSON.stringify(data) : undefined,
    });
    return this.handleResponse<T>(response);
  }

  // Clear the cached token (call this on logout)
  clearTokenCache(): void {
    this.cachedToken = null;
  }

  // Get auth headers for use with raw fetch calls (e.g., streaming)
  async getAuthHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    const token = await this.getMsalToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    return headers;
  }
}

// Singleton instance
export const apiClient = new ApiClient(API_BASE_URL, APIM_SUBSCRIPTION_KEY);

// ============================================================================
// Auth API Methods (Legacy - Auth is now handled by Easy Auth)
// These methods are kept for backward compatibility but will not work
// with Easy Auth. Use the easyAuth.ts utilities instead.
// ============================================================================

export const authApi = {
  // Deprecated: Authentication is handled by Easy Auth
  async signUp(_email: string, _password: string, _name?: string): Promise<AuthResponse> {
    throw new Error("Direct signup is not supported. Please use Microsoft sign-in.");
  },

  // Deprecated: Authentication is handled by MSAL
  async signIn(_email: string, _password: string): Promise<AuthResponse> {
    throw new Error("Direct sign-in is not supported. Please use Microsoft sign-in.");
  },

  // Sign out via MSAL
  async signOut(): Promise<void> {
    apiClient.clearTokenCache();
    clearAuthData();
  },

  // Token refresh is handled automatically by MSAL
  async refreshToken(): Promise<{ token: string }> {
    apiClient.clearTokenCache(); // Clear cache to force re-fetch
    const token = await getAccessToken();
    return { token: token || "" };
  },

  getSession(): { user: ApiUser | null; token: string | null } {
    return {
      user: getStoredUser(),
      token: getStoredToken(),
    };
  },

  // Check if authenticated via MSAL
  async isAuthenticated(): Promise<boolean> {
    const accounts = msalInstance.getAllAccounts();
    return accounts.length > 0;
  },
};

// ============================================================================
// Helper to check if using Azure API
// ============================================================================

export function useAzureApi(): boolean {
  return import.meta.env.VITE_USE_AZURE_API === "true";
}

export default apiClient;
