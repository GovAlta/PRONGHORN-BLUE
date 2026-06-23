/**
 * Auth Callback Page
 * 
 * This page handles the post-OAuth redirect from Azure Easy Auth.
 * It captures the user session and stores it in localStorage for persistence.
 * 
 * Flow:
 * 1. User clicks "Sign in with Microsoft" → redirected to /.auth/login/aad
 * 2. User completes Entra ID login → redirected back to /auth/callback
 * 3. This page fetches /.auth/me to get user info
 * 4. User info is stored in localStorage for session persistence
 * 5. User is redirected to the dashboard (or stored redirect path)
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { 
  fetchEasyAuthUser, 
  saveUserToStorage,
  EasyAuthUser 
} from "@/lib/easyAuth";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle, XCircle } from "lucide-react";

export default function AuthCallback() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<EasyAuthUser | null>(null);
  const [debugInfo, setDebugInfo] = useState<string[]>([]);
  const [retryCount, setRetryCount] = useState(0);
  const maxRetries = 5;

  const addDebug = (msg: string) => {
    console.log("[AuthCallback]", msg);
    setDebugInfo(prev => [...prev, `${new Date().toISOString().slice(11, 23)} - ${msg}`]);
  };

  useEffect(() => {
    const handleCallback = async () => {
      // Get stored redirect path or default to dashboard
      let redirectTo = "/dashboard";
      try {
        const storedRedirect = localStorage.getItem("pronghorn-auth-redirect");
        if (storedRedirect) {
          redirectTo = storedRedirect;
          localStorage.removeItem("pronghorn-auth-redirect"); // Clean up
        }
      } catch (e) {
        // Ignore localStorage errors
      }

      addDebug(`Redirect target: ${redirectTo}`);
      addDebug(`Current URL: ${window.location.href}`);
      addDebug(`Retry attempt: ${retryCount + 1}/${maxRetries}`);

      // Check URL for OAuth errors
      const urlParams = new URLSearchParams(window.location.search);
      const errorParam = urlParams.get("error");
      const errorDescription = urlParams.get("error_description");

      if (errorParam) {
        const errorMessage = errorDescription || errorParam || "Authentication failed";
        addDebug(`OAuth error: ${errorMessage}`);
        setError(errorMessage);
        setStatus("error");
        return;
      }

      // Wait a moment for cookies to be properly set
      addDebug("Waiting for session cookies...");
      await new Promise(resolve => setTimeout(resolve, 500 + (retryCount * 500)));

      try {
        addDebug("Fetching user from /.auth/me...");
        
        // Fetch user info
        const authUser = await fetchEasyAuthUser();
        
        if (authUser) {
          addDebug(`User authenticated: ${authUser.email}`);
          
          // Save to localStorage for persistence
          saveUserToStorage(authUser);
          
          setUser(authUser);
          setStatus("success");
          
          // Redirect after showing success message
          setTimeout(() => {
            addDebug(`Redirecting to ${redirectTo}...`);
            navigate(redirectTo, { replace: true });
          }, 1000);
          
        } else {
          // No user found - maybe cookies aren't set yet
          addDebug("No user from /.auth/me");
          
          if (retryCount < maxRetries - 1) {
            addDebug("Will retry in 1 second...");
            setRetryCount(prev => prev + 1);
          } else {
            // After all retries, give up
            setError("Could not verify authentication. The session may not have been established. Please try signing in again.");
            setStatus("error");
          }
        }
      } catch (err: any) {
        addDebug(`Error: ${err.message}`);
        
        if (retryCount < maxRetries - 1) {
          addDebug("Will retry due to error...");
          setRetryCount(prev => prev + 1);
        } else {
          setError(err.message || "Failed to verify authentication");
          setStatus("error");
        }
      }
    };

    // Only run when status is loading
    if (status === "loading") {
      handleCallback();
    }
  }, [navigate, retryCount, status]);

  // Trigger retry when retryCount changes
  useEffect(() => {
    if (retryCount > 0 && status === "loading") {
      // This will cause the main effect to re-run
    }
  }, [retryCount, status]);

  if (status === "loading") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="text-center max-w-lg">
          <Loader2 className="h-12 w-12 animate-spin mx-auto mb-4 text-primary" />
          <h2 className="text-xl font-semibold mb-2">
            Completing sign in...
          </h2>
          <p className="text-muted-foreground">
            {retryCount > 0 
              ? `Verifying session (attempt ${retryCount + 1}/${maxRetries})...`
              : "Please wait while we verify your authentication."
            }
          </p>
          
          {/* Debug panel - collapsed by default */}
          <details className="mt-8 text-left">
            <summary className="cursor-pointer text-xs text-muted-foreground">Debug Info</summary>
            <pre className="mt-2 p-2 bg-muted rounded text-xs overflow-auto max-h-48 text-left">
              {debugInfo.join("\n")}
            </pre>
          </details>
        </div>
      </div>
    );
  }

  if (status === "success" && user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="text-center">
          <CheckCircle className="h-12 w-12 mx-auto mb-4 text-green-500" />
          <h2 className="text-xl font-semibold mb-2">Welcome, {user.name}!</h2>
          <p className="text-muted-foreground">Redirecting to your dashboard...</p>
        </div>
      </div>
    );
  }

  // Error state
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="text-center max-w-lg">
        <XCircle className="h-12 w-12 mx-auto mb-4 text-destructive" />
        <h2 className="text-xl font-semibold mb-2">Authentication Failed</h2>
        <p className="text-muted-foreground mb-4">{error}</p>
        
        <div className="flex gap-4 justify-center">
          <Button onClick={() => navigate("/auth")} variant="default">
            Try Again
          </Button>
          <Button onClick={() => navigate("/")} variant="outline">
            Go Home
          </Button>
        </div>
        
        {/* Debug panel */}
        <details className="mt-8 text-left">
          <summary className="cursor-pointer text-xs text-muted-foreground">Debug Info</summary>
          <pre className="mt-2 p-2 bg-muted rounded text-xs overflow-auto max-h-48 text-left">
            {debugInfo.join("\n")}
          </pre>
        </details>
      </div>
    </div>
  );
}
