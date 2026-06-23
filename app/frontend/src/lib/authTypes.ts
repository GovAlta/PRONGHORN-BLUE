/**
 * Auth Types - Local type definitions replacing @pronghornApi/pronghornApi-js
 * 
 */

/**
 * User type - represents an authenticated user
 */
export interface User {
  id: string;
  email?: string;
  phone?: string;
  app_metadata: Record<string, any>;
  user_metadata: Record<string, any>;
  aud: string;
  confirmation_sent_at?: string;
  recovery_sent_at?: string;
  email_confirmed_at?: string;
  phone_confirmed_at?: string;
  last_sign_in_at?: string;
  role?: string;
  updated_at?: string;
  created_at?: string;
  is_anonymous?: boolean;
}

/**
 * Session type - represents an active auth session
 */
export interface Session {
  access_token: string;
  token_type: string;
  expires_in: number;
  expires_at?: number;
  refresh_token: string;
  user: User;
}

/**
 * Auth state change event types
 */
export type AuthChangeEvent =
  | "INITIAL_SESSION"
  | "SIGNED_IN"
  | "SIGNED_OUT"
  | "TOKEN_REFRESHED"
  | "USER_UPDATED"
  | "PASSWORD_RECOVERY"
  | "MFA_CHALLENGE_VERIFIED";

/**
 * Auth state subscription
 */
export interface AuthSubscription {
  unsubscribe: () => void;
}

/**
 * Simplified API user (used by apiClient)
 */
export interface ApiUser {
  id: string;
  email: string;
  name?: string;
  role?: string;
}

/**
 * Convert API user to User type for compatibility
 */
export function apiUserToUser(apiUser: ApiUser | null): User | null {
  if (!apiUser) return null;
  
  return {
    id: apiUser.id,
    email: apiUser.email,
    aud: "authenticated",
    app_metadata: {},
    user_metadata: {
      name: apiUser.name,
    },
    role: apiUser.role,
    created_at: new Date().toISOString(),
  };
}

/**
 * Create a session from token and user
 */
export function createSession(token: string, user: User | null): Session | null {
  if (!token || !user) return null;
  
  return {
    access_token: token,
    token_type: "bearer",
    expires_in: 3600,
    refresh_token: "",
    user,
  };
}
