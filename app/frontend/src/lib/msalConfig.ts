/**
 * MSAL Configuration for Azure AD Authentication
 * 
 * This configures the Microsoft Authentication Library (MSAL) for 
 * authenticating users via Azure Entra ID (formerly Azure AD).
 */
import { Configuration, LogLevel, PopupRequest, RedirectRequest } from "@azure/msal-browser";

// Azure AD App Registration details.
// Browser-side env vars never touch the @azure/identity SDK, but we keep
// naming consistent with the backend (which MUST avoid AZURE_CLIENT_ID due
// to ManagedIdentityCredential reserving that name — see
// app/backend/src/middleware/auth.ts).
//
// Fail-fast: missing values produce a malformed authorize URL
// (client_id=&...) which Entra rejects, sending the user back to the app
// and triggering a redirect loop. Throwing here surfaces the misconfig
// immediately in the browser console / error boundary.
const CLIENT_ID = import.meta.env.VITE_ENTRA_CLIENT_ID;
const TENANT_ID = import.meta.env.VITE_ENTRA_TENANT_ID;
const REDIRECT_URI = import.meta.env.VITE_AZURE_REDIRECT_URI || window.location.origin;

if (!CLIENT_ID) {
  throw new Error(
    "VITE_ENTRA_CLIENT_ID is required. Set it in app/frontend/.env (or pass it at build time). " +
    "See app/frontend/.env.example for details."
  );
}
if (!TENANT_ID) {
  throw new Error(
    "VITE_ENTRA_TENANT_ID is required. Set it in app/frontend/.env (or pass it at build time). " +
    'Use "organizations" for multi-tenant or your directory (tenant) ID. ' +
    "See app/frontend/.env.example for details."
  );
}

// Authority URL - 'organizations' allows any Azure AD tenant to sign in
const AUTHORITY = `https://login.microsoftonline.com/${TENANT_ID}`;

/**
 * MSAL Configuration
 */
export const msalConfig: Configuration = {
  auth: {
    clientId: CLIENT_ID,
    authority: AUTHORITY,
    redirectUri: REDIRECT_URI,
    postLogoutRedirectUri: REDIRECT_URI,
    navigateToLoginRequestUrl: true,
  },
  cache: {
    cacheLocation: "localStorage", // Use localStorage for persistence across tabs
    storeAuthStateInCookie: false, // Set to true if issues on IE11/Edge
  },
  system: {
    loggerOptions: {
      loggerCallback: (level, message, containsPii) => {
        if (containsPii) return;
        switch (level) {
          case LogLevel.Error:
            console.error("[MSAL]", message);
            break;
          case LogLevel.Info:
            console.info("[MSAL]", message);
            break;
          case LogLevel.Verbose:
            console.debug("[MSAL]", message);
            break;
          case LogLevel.Warning:
            console.warn("[MSAL]", message);
            break;
        }
      },
      logLevel: LogLevel.Warning,
    },
    allowNativeBroker: false, // Disable WAM broker - not needed for web
  },
};

/**
 * Popup redirect URI - lightweight page that handles the MSAL response
 * and closes the popup without loading the full SPA
 */
export const popupRedirectUri = `${window.location.origin}/auth-redirect.html`;

/**
 * Scopes to request for login
 * - openid, profile, email: Standard OIDC scopes
 * - User.Read: Microsoft Graph scope for reading user profile
 * 
 * Note: Do NOT add resource-specific scopes like api://{clientId}/access_as_user here.
 * APIM JWT validation uses the ID token (aud = client_id), which doesn't require
 * a custom API scope. Mixing Graph + custom API scopes causes acquireTokenSilent
 * to fail with InteractionRequiredAuthError for users who haven't consented.
 */
export const loginRequest: PopupRequest = {
  scopes: ["openid", "profile", "email", "User.Read"],
  redirectUri: popupRedirectUri,
};

/**
 * Scopes to request for API access
 * If your API requires specific scopes, add them here
 */
export const apiRequest: PopupRequest = {
  scopes: [
    `api://${CLIENT_ID}/access_as_user`, // Custom scope for your API
  ],
};

/**
 * Redirect request configuration
 */
export const redirectRequest: RedirectRequest = {
  scopes: ["openid", "profile", "email", "User.Read"],
  redirectStartPage: window.location.href,
};

/**
 * Graph API configuration
 */
export const graphConfig = {
  graphMeEndpoint: "https://graph.microsoft.com/v1.0/me",
};

/**
 * Helper to get the B2C or regular AD authority
 */
export function getAuthority(): string {
  return AUTHORITY;
}

/**
 * Export configuration values for use elsewhere
 */
export const authConfig = {
  clientId: CLIENT_ID,
  tenantId: TENANT_ID,
  redirectUri: REDIRECT_URI,
  authority: AUTHORITY,
};
