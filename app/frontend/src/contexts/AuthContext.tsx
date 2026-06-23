import { createContext, useContext, useState, useEffect, useMemo, useCallback, ReactNode } from "react";
import { User, Session, createSession } from "@/lib/authTypes";
import { useMsal, useIsAuthenticated, useAccount } from "@azure/msal-react";
import { AccountInfo, InteractionStatus, SilentRequest, PopupRequest } from "@azure/msal-browser";
import { loginRequest, popupRedirectUri } from "@/lib/msalConfig";

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  isSignupValidated: boolean;
  signUp: (email: string, password: string, signupValidated?: boolean) => Promise<{ error: any }>;
  signIn: (email: string, password: string) => Promise<{ error: any }>;
  signInWithGoogle: () => Promise<{ error: any }>;
  signInWithAzure: () => Promise<{ error: any }>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<{ error: any }>;
  updatePassword: (newPassword: string) => Promise<{ error: any }>;
  validateSignupCode: (code: string) => Promise<{ error: any }>;
  refreshAuth: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Helper to convert MSAL account to our User type
function msalAccountToUser(account: AccountInfo): User {
  return {
    id: account.localAccountId || account.homeAccountId,
    email: account.username,
    user_metadata: {
      name: account.name || account.username.split("@")[0],
      provider: "aad",
    },
    app_metadata: {
      roles: [],
    },
    aud: "",
    created_at: "",
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { instance, accounts, inProgress } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const account = useAccount(accounts[0] || null);
  
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  // Get access token for API calls
  const getAccessToken = useCallback(async (): Promise<string | null> => {
    if (!account) return null;
    
    try {
      const silentRequest: SilentRequest = {
        scopes: ["openid", "profile", "email"],
        account: account,
      };
      
      const response = await instance.acquireTokenSilent(silentRequest);
      return response.idToken; // Use ID token for API auth
    } catch (error) {
      console.warn("[AuthProvider] Silent token acquisition failed, trying popup:", error);
      try {
        const response = await instance.acquireTokenPopup(loginRequest as PopupRequest);
        return response.idToken;
      } catch (popupError) {
        console.error("[AuthProvider] Token acquisition failed:", popupError);
        return null;
      }
    }
  }, [instance, account]);

  // Function to refresh auth state
  const refreshAuth = useCallback(async () => {
    console.log("[AuthProvider] Refreshing auth state...");
    if (account) {
      const appUser = msalAccountToUser(account);
      const token = await getAccessToken();
      setUser(appUser);
      setSession(createSession(token || "msal-session", appUser));
      console.log("[AuthProvider] Auth refreshed with user:", appUser);
    }
  }, [account, getAccessToken]);

  // Sync MSAL state with our state
  useEffect(() => {
    console.log("[AuthProvider] MSAL state changed:", {
      isAuthenticated,
      inProgress,
      accountCount: accounts.length,
      account: account?.username
    });

    // Wait for MSAL to finish initializing
    if (inProgress !== InteractionStatus.None) {
      console.log("[AuthProvider] MSAL interaction in progress:", inProgress);
      return;
    }

    if (isAuthenticated && account) {
      console.log("[AuthProvider] User authenticated:", account.username);
      const appUser = msalAccountToUser(account);
      setUser(appUser);
      
      // Get token and create session
      getAccessToken().then(token => {
        setSession(createSession(token || "msal-session", appUser));
        setLoading(false);
      }).catch(() => {
        setSession(createSession("msal-session", appUser));
        setLoading(false);
      });
    } else {
      console.log("[AuthProvider] User not authenticated");
      setUser(null);
      setSession(null);
      setLoading(false);
    }
  }, [isAuthenticated, account, accounts, inProgress, getAccessToken]);

  // Email/password signup is not supported with Azure AD
  const signUp = async (_email: string, _password: string, _signupValidated: boolean = false) => {
    return { 
      error: { 
        message: "Direct signup is not available. Please sign in with Microsoft." 
      } 
    };
  };

  // Email/password login redirects to Azure AD
  const signIn = async (_email: string, _password: string) => {
    return { 
      error: { 
        message: "Please use Microsoft sign-in." 
      } 
    };
  };

  // Google sign-in via MSAL (if configured in Azure AD)
  const signInWithGoogle = async () => {
    try {
      // Azure AD B2C can support Google, but regular Azure AD uses Microsoft accounts
      console.log("[AuthProvider] Google sign-in - using popup");
      await instance.loginPopup(loginRequest as PopupRequest);
      return { error: null };
    } catch (error: any) {
      console.error("[AuthProvider] Google sign-in error:", error);
      return { error: { message: error.message || "Google sign-in failed" } };
    }
  };

  // Azure AD sign-in via MSAL popup
  const signInWithAzure = async () => {
    try {
      console.log("[AuthProvider] Azure sign-in - using popup");
      const response = await instance.loginPopup({
        ...loginRequest,
        redirectUri: popupRedirectUri,
      } as PopupRequest);
      if (response?.account) {
        instance.setActiveAccount(response.account);
      }
      return { error: null };
    } catch (error: any) {
      console.error("[AuthProvider] Azure sign-in error:", error);
      return { error: { message: error.message || "Azure sign-in failed" } };
    }
  };

  // Sign out via MSAL
  const signOut = async () => {
    try {
      console.log("[AuthProvider] Signing out...");
      setUser(null);
      setSession(null);
      
      // Logout with redirect to home
      await instance.logoutPopup({
        postLogoutRedirectUri: window.location.origin,
      });
    } catch (error) {
      console.error("[AuthProvider] Sign out error:", error);
    }
  };

  // Password reset - handled by identity provider
  const resetPassword = async (_email: string) => {
    return { 
      error: { 
        message: "Password reset is managed by your identity provider (Microsoft). Please use their password reset options." 
      } 
    };
  };

  // Password update - handled by identity provider
  const updatePassword = async (_newPassword: string) => {
    return { 
      error: { 
        message: "Password management is handled by your identity provider (Microsoft)." 
      } 
    };
  };

  // Signup validation is not needed with MSAL
  const isSignupValidated = useMemo(() => true, []);

  // Validate signup code - not applicable with MSAL
  const validateSignupCode = async (_code: string) => {
    return { error: null };
  };

  return (
    <AuthContext.Provider value={{ 
      user, 
      session, 
      loading,
      isSignupValidated,
      signUp, 
      signIn, 
      signInWithGoogle, 
      signInWithAzure, 
      signOut, 
      resetPassword, 
      updatePassword,
      validateSignupCode,
      refreshAuth,
      getAccessToken,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
