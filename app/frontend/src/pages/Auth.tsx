import { useState, useEffect } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { isEasyAuthEnabled } from "@/lib/easyAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { Loader2, Info, AlertTriangle, Shield } from "lucide-react";
import { PronghornLogo } from "@/components/layout/PronghornLogo";

export default function Auth() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const {
    user,
    session,
    loading,
    signInWithAzure,
  } = useAuth();

  // Loading state for SSO button
  const [azureLoading, setAzureLoading] = useState(false);

  // Error state
  const [authError, setAuthError] = useState<string | null>(null);

  // Handle URL params after Easy Auth redirect
  useEffect(() => {
    const error = searchParams.get("error");
    const errorDescription = searchParams.get("error_description");

    // Handle Easy Auth errors
    if (error) {
      const errorMessage = errorDescription || error || "Authentication failed. Please try again.";
      setAuthError(errorMessage);
      toast.error(errorMessage);
      // Clear error params from URL
      window.history.replaceState({}, "", "/auth");
    }
  }, [searchParams]);

  // Redirect to dashboard if already authenticated
  useEffect(() => {
    if (!loading && (session || user)) {
      navigate("/dashboard");
    }
  }, [session, user, navigate, loading]);

  const handleAzureSignIn = async () => {
    setAzureLoading(true);
    setAuthError(null);
    try {
      const { error } = await signInWithAzure();
      if (error) {
        setAuthError(error.message);
        toast.error(error.message);
        setAzureLoading(false);
      } else {
        // Popup succeeded — navigate to dashboard
        // Small delay to allow MSAL state to propagate
        setTimeout(() => navigate("/dashboard"), 500);
      }
    } catch (err: any) {
      const msg = err?.message || "Sign-in failed. Please allow popups for this site and try again.";
      setAuthError(msg);
      toast.error(msg);
      setAzureLoading(false);
    }
  };

  // Login type information component
  const LoginTypeInfo = () => (
    <Alert className="mb-4 border-muted bg-muted/50">
      <Info className="h-4 w-4" />
      <AlertDescription className="text-sm">
        <p className="mt-1 text-muted-foreground">
          <span className="font-medium text-foreground">Microsoft SSO:</span> Sign in with your organization's Entra ID account
        </p>
      </AlertDescription>
    </Alert>
  );

  // Environment mode indicator
  const AuthModeIndicator = () => {
    if (isEasyAuthEnabled()) {
      return (
        <Alert className="mb-4 border-blue-500/50 bg-blue-500/10">
          <Shield className="h-4 w-4 text-blue-600" />
          <AlertDescription className="text-sm text-blue-700 dark:text-blue-400">
            <span className="font-medium">Azure Easy Auth</span>
            <p className="mt-1">Secure authentication via Azure Container Apps.</p>
          </AlertDescription>
        </Alert>
      );
    }
    
    return null;
  };

  // Show loading state while checking authentication
  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4 text-primary" />
          <p className="text-muted-foreground">Checking authentication...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <Link to="/" className="flex justify-center mb-4">
            <PronghornLogo className="h-12 w-12 rounded-lg" />
          </Link>
          <CardTitle className="text-2xl">
            <Link to="/" className="hover:text-primary transition-colors">Welcome to Pronghorn</Link>
          </CardTitle>
          <CardDescription>Sign in to access your projects</CardDescription>
        </CardHeader>
        <CardContent>
          {/* Auth error banner */}
          {authError && (
            <Alert className="mb-4 border-destructive/50 bg-destructive/10">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              <AlertDescription className="text-destructive">
                {authError}
              </AlertDescription>
            </Alert>
          )}

          {/* Local development mode indicator */}
          <AuthModeIndicator />

          {/* Login type information */}
          <LoginTypeInfo />

          {/* SSO Login Button */}
          <div className="space-y-3">
            <Button 
              variant="outline" 
              className="w-full h-12"
              onClick={handleAzureSignIn} 
              disabled={azureLoading}
            >
              {azureLoading ? (
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              ) : (
                <svg className="mr-2 h-5 w-5" viewBox="0 0 23 23">
                  <path fill="#f3f3f3" d="M0 0h23v23H0z" />
                  <path fill="#f35325" d="M1 1h10v10H1z" />
                  <path fill="#81bc06" d="M12 1h10v10H12z" />
                  <path fill="#05a6f0" d="M1 12h10v10H1z" />
                  <path fill="#ffba08" d="M12 12h10v10H12z" />
                </svg>
              )}
              Sign in with Microsoft
            </Button>
          </div>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            By signing in, you agree to our{" "}
            <Link to="/terms" className="underline hover:text-foreground">Terms of Service</Link>
            {" "}and{" "}
            <Link to="/privacy" className="underline hover:text-foreground">Privacy Policy</Link>.
          </p>

          <div className="mt-6 text-center">
            <Button variant="link" onClick={() => navigate("/dashboard")} className="text-sm">
              Continue without signing in
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
