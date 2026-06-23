import { ReactNode } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { SignupCodeModal } from "./SignupCodeModal";

interface RequireSignupValidationProps {
  children: ReactNode;
}

export function RequireSignupValidation({ children }: RequireSignupValidationProps) {
  const { user, isSignupValidated, loading } = useAuth();
  
  // If loading or no user, just render children (let other auth checks handle it)
  if (loading || !user) {
    return <>{children}</>;
  }
  
  // If not validated, show blocking modal over the content
  if (!isSignupValidated) {
    return (
      <>
        {children}
        <SignupCodeModal />
      </>
    );
  }
  
  return <>{children}</>;
}
