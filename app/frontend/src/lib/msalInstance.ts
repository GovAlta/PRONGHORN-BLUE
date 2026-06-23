/**
 * MSAL Instance
 * 
 * Singleton instance of PublicClientApplication for MSAL authentication.
 * This should be created once and used throughout the application.
 */
import { PublicClientApplication, EventType, EventMessage, AuthenticationResult } from "@azure/msal-browser";
import { msalConfig } from "./msalConfig";

// Create the MSAL instance
export const msalInstance = new PublicClientApplication(msalConfig);

// Register event callbacks
msalInstance.addEventCallback((event: EventMessage) => {
  if (event.eventType === EventType.LOGIN_SUCCESS) {
    console.log("[MSAL] Login successful");
    const result = event.payload as AuthenticationResult;
    if (result?.account) {
      // Set the active account
      msalInstance.setActiveAccount(result.account);
    }
  }
  
  if (event.eventType === EventType.LOGOUT_SUCCESS) {
    console.log("[MSAL] Logout successful");
  }
  
  if (event.eventType === EventType.LOGIN_FAILURE) {
    console.error("[MSAL] Login failed:", event.error);
  }
});

// Handle redirect promise on page load
msalInstance.initialize().then(() => {
  // Handle redirect response if coming back from login
  msalInstance.handleRedirectPromise()
    .then((response) => {
      if (response) {
        console.log("[MSAL] Redirect login completed");
        msalInstance.setActiveAccount(response.account);
      } else {
        // Check if there's an active account
        const accounts = msalInstance.getAllAccounts();
        if (accounts.length > 0) {
          msalInstance.setActiveAccount(accounts[0]);
          console.log("[MSAL] Active account restored:", accounts[0].username);
        }
      }
    })
    .catch((error) => {
      console.error("[MSAL] Error handling redirect:", error);
    });
}).catch((error) => {
  console.error("[MSAL] Initialization error:", error);
});

export default msalInstance;
