/**
 * Azure Container Apps Easy Auth Utilities
 * 
 * Easy Auth handles authentication at the platform level.
 * These utilities help interact with the Easy Auth endpoints.
 * 
 * Session Persistence:
 * - After successful OAuth, user info is stored in localStorage
 * - On page load, we check localStorage first for fast session restoration
 * - We also verify with /.auth/me to ensure session is still valid
 * 
 * Authentication Mode:
 * - In production (Azure): Uses Easy Auth endpoints (/.auth/*)
 * - In local development: Uses mock authentication for testing
 */

export interface EasyAuthClaim {
  typ: string;
  val: string;
}

export interface EasyAuthIdentity {
  user_id: string;
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_on?: string;
  provider_name: string;
  user_claims: EasyAuthClaim[];
}

export interface EasyAuthUser {
  id: string;
  email: string;
  name: string;
  provider: string;
  roles?: string[];
}

// Storage key for persisted session
const AUTH_STORAGE_KEY = "pronghorn-auth-session";

// Easy Auth provider names
export type EasyAuthProvider = "aad" | "google" | "github" | "facebook" | "twitter";

/**
 * Check if running in local development
 */
export function isLocalDevelopment(): boolean {
  const hostname = window.location.hostname;
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/**
 * Check if Easy Auth is enabled (production Azure deployment)
 * Returns false when auth mode is 'msal' or when running locally
 */
export function isEasyAuthEnabled(): boolean {
  const authMode = import.meta.env.VITE_AUTH_MODE;
  if (authMode === "msal" || authMode === "mock") {
    return false;
  }
  return !isLocalDevelopment();
}

/**
 * Save user session to localStorage
 */
export function saveUserToStorage(user: EasyAuthUser): void {
  try {
    const sessionData = {
      user,
      savedAt: Date.now(),
    };
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(sessionData));
    console.log("[EasyAuth] User saved to localStorage");
  } catch (error) {
    console.error("[EasyAuth] Failed to save user to localStorage:", error);
  }
}

/**
 * Load user session from localStorage
 * Returns null if session is expired (older than 24 hours) or not found
 */
export function loadUserFromStorage(): EasyAuthUser | null {
  try {
    const stored = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!stored) {
      console.log("[EasyAuth] No stored session found");
      return null;
    }
    
    const sessionData = JSON.parse(stored);
    const { user, savedAt } = sessionData;
    
    // Check if session is older than 24 hours
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    if (Date.now() - savedAt > maxAge) {
      console.log("[EasyAuth] Stored session expired");
      clearUserFromStorage();
      return null;
    }
    
    console.log("[EasyAuth] User loaded from localStorage:", user);
    return user as EasyAuthUser;
  } catch (error) {
    console.error("[EasyAuth] Failed to load user from localStorage:", error);
    return null;
  }
}

/**
 * Clear user session from localStorage
 */
export function clearUserFromStorage(): void {
  try {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    console.log("[EasyAuth] Session cleared from localStorage");
  } catch (error) {
    console.error("[EasyAuth] Failed to clear session from localStorage:", error);
  }
}

/**
 * Get the login URL for a specific provider
 */
export function getLoginUrl(provider: EasyAuthProvider, postLoginRedirect?: string): string {
  const redirectParam = postLoginRedirect 
    ? `?post_login_redirect_uri=${encodeURIComponent(postLoginRedirect)}`
    : "";
  return `/.auth/login/${provider}${redirectParam}`;
}

/**
 * Get the logout URL
 */
export function getLogoutUrl(postLogoutRedirect?: string): string {
  const redirectParam = postLogoutRedirect 
    ? `?post_logout_redirect_uri=${encodeURIComponent(postLogoutRedirect)}`
    : "";
  return `/.auth/logout${redirectParam}`;
}

/**
 * Parse claims from Easy Auth response to user object
 */
export function parseEasyAuthClaims(claims: EasyAuthClaim[]): Partial<EasyAuthUser> {
  const claimMap = new Map(claims.map(c => [c.typ, c.val]));
  
  // Common claim types across providers
  return {
    email: claimMap.get("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress") 
      || claimMap.get("emails")
      || claimMap.get("preferred_username")
      || claimMap.get("email")
      || "",
    name: claimMap.get("name") 
      || claimMap.get("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name")
      || "",
    roles: claims
      .filter(c => c.typ === "roles" || c.typ === "http://schemas.microsoft.com/ws/2008/06/identity/claims/role")
      .map(c => c.val),
  };
}

/**
 * Parse user from X-MS-CLIENT-PRINCIPAL header (base64 encoded)
 * This header is injected by Easy Auth into all requests after authentication
 */
function parseClientPrincipalHeader(headerValue: string): EasyAuthUser | null {
  try {
    const decoded = atob(headerValue);
    const principal = JSON.parse(decoded);
    console.log("[EasyAuth] Decoded client principal:", principal);
    
    // Parse claims from the principal
    const claims = principal.claims || [];
    const claimMap = new Map(claims.map((c: any) => [c.typ, c.val]));
    
    return {
      id: principal.userId || principal.nameidentifier || "unknown",
      email: claimMap.get("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress") 
        || claimMap.get("emails")
        || claimMap.get("preferred_username")
        || claimMap.get("email")
        || principal.userDetails
        || "",
      name: claimMap.get("name") 
        || claimMap.get("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name")
        || principal.userDetails?.split("@")[0]
        || "User",
      provider: principal.identityProvider || "aad",
      roles: principal.userRoles || claims
        .filter((c: any) => c.typ === "roles")
        .map((c: any) => c.val),
    };
  } catch (error) {
    console.error("[EasyAuth] Error parsing client principal:", error);
    return null;
  }
}

/**
 * Fetch user info from Easy Auth /.auth/me endpoint
 * Also checks X-MS-CLIENT-PRINCIPAL header as a backup
 * If successful, saves to localStorage for session persistence
 */
export async function fetchEasyAuthUser(): Promise<EasyAuthUser | null> {
  try {
    console.log("[EasyAuth] Fetching /.auth/me...");
    
    // First try hitting any endpoint to see if Easy Auth headers are present
    // Easy Auth injects X-MS-CLIENT-PRINCIPAL into all requests when user is authenticated
    const probeResponse = await fetch("/health", {
      credentials: "include",
    });
    
    // Check for Easy Auth headers
    const clientPrincipal = probeResponse.headers.get("X-MS-CLIENT-PRINCIPAL");
    const clientPrincipalId = probeResponse.headers.get("X-MS-CLIENT-PRINCIPAL-ID");
    const clientPrincipalName = probeResponse.headers.get("X-MS-CLIENT-PRINCIPAL-NAME");
    const clientPrincipalIdp = probeResponse.headers.get("X-MS-CLIENT-PRINCIPAL-IDP");
    
    console.log("[EasyAuth] Easy Auth headers:", {
      hasClientPrincipal: !!clientPrincipal,
      principalId: clientPrincipalId,
      principalName: clientPrincipalName,
      idp: clientPrincipalIdp
    });
    
    // If we have the full client principal, parse it
    if (clientPrincipal) {
      const user = parseClientPrincipalHeader(clientPrincipal);
      if (user) {
        console.log("[EasyAuth] User from X-MS-CLIENT-PRINCIPAL:", user);
        saveUserToStorage(user);
        return user;
      }
    }
    
    // If we have the individual headers, use those
    if (clientPrincipalId && clientPrincipalName) {
      const user: EasyAuthUser = {
        id: clientPrincipalId,
        email: clientPrincipalName,
        name: clientPrincipalName.split("@")[0] || "User",
        provider: clientPrincipalIdp || "aad",
        roles: [],
      };
      console.log("[EasyAuth] User from Easy Auth headers:", user);
      saveUserToStorage(user);
      return user;
    }
    
    // Fall back to /.auth/me endpoint
    const response = await fetch("/.auth/me", {
      credentials: "include", // Important: include cookies for Easy Auth
    });
    
    console.log("[EasyAuth] /.auth/me response status:", response.status);
    
    if (!response.ok) {
      console.log("[EasyAuth] Not authenticated or /.auth/me failed, status:", response.status);
      return null;
    }
    
    const text = await response.text();
    console.log("[EasyAuth] /.auth/me raw response:", text);
    
    if (!text || text.trim() === "" || text === "[]") {
      console.log("[EasyAuth] Empty response from /.auth/me");
      return null;
    }
    
    const data: EasyAuthIdentity[] = JSON.parse(text);
    
    if (!data || data.length === 0) {
      console.log("[EasyAuth] No identity found in array");
      return null;
    }
    
    // Get the first (and usually only) identity
    const identity = data[0];
    console.log("[EasyAuth] Identity found:", identity.provider_name, identity.user_id);
    
    const parsedClaims = parseEasyAuthClaims(identity.user_claims || []);
    
    const user: EasyAuthUser = {
      id: identity.user_id,
      email: parsedClaims.email || identity.user_id,
      name: parsedClaims.name || parsedClaims.email?.split("@")[0] || "User",
      provider: identity.provider_name,
      roles: parsedClaims.roles,
    };
    
    console.log("[EasyAuth] User authenticated:", user);
    
    // Save to localStorage for session persistence
    saveUserToStorage(user);
    
    return user;
  } catch (error) {
    console.error("[EasyAuth] Error fetching user:", error);
    return null;
  }
}

/**
 * Check if user is authenticated via Easy Auth
 */
export async function isAuthenticated(): Promise<boolean> {
  const user = await fetchEasyAuthUser();
  return user !== null;
}

/**
 * Redirect to login page for a specific provider
 * Easy Auth will redirect back to the specified path after authentication
 */
export function loginWithProvider(provider: EasyAuthProvider, redirectPath?: string): void {
  // Store the intended redirect path for after authentication (backup)
  const destination = redirectPath || "/dashboard";
  try {
    localStorage.setItem("pronghorn-auth-redirect", destination);
  } catch (e) {
    console.error("[EasyAuth] Failed to store redirect path:", e);
  }
  // Redirect directly to dashboard after login - simpler flow
  // Easy Auth will set cookies and redirect, then dashboard will pick up the session
  window.location.href = getLoginUrl(provider, destination);
}

/**
 * Redirect to logout - clears localStorage and redirects to Easy Auth logout
 */
export function logout(redirectPath?: string): void {
  // Clear localStorage session
  clearUserFromStorage();
  const redirectUrl = redirectPath || "/";
  window.location.href = getLogoutUrl(redirectUrl);
}

/**
 * Get the access token from Easy Auth (if needed for API calls)
 */
export async function getAccessToken(): Promise<string | null> {
  try {
    const response = await fetch("/.auth/me", {
      credentials: "include", // Important: include cookies for Easy Auth
    });
    
    if (!response.ok) {
      return null;
    }
    
    const data: EasyAuthIdentity[] = await response.json();
    
    if (!data || data.length === 0) {
      return null;
    }
    
    return data[0].access_token || null;
  } catch (error) {
    console.error("[EasyAuth] Error getting access token:", error);
    return null;
  }
}

/**
 * Refresh the Easy Auth token
 */
export async function refreshToken(): Promise<boolean> {
  try {
    const response = await fetch("/.auth/refresh", { 
      method: "GET",
      credentials: "include", // Important: include cookies for Easy Auth
    });
    return response.ok;
  } catch (error) {
    console.error("[EasyAuth] Error refreshing token:", error);
    return false;
  }
}
