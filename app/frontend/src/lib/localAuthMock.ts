/**
 * Local Development Auth Mock
 * 
 * Simulates Azure Easy Auth for local development testing.
 * This allows developers to test the app locally without deploying to Azure.
 */

import { EasyAuthUser } from "./easyAuth";

const LOCAL_AUTH_KEY = "pronghorn_local_auth_user";

export interface LocalMockUser {
  id: string;
  email: string;
  name: string;
  provider: "aad" | "google";
}

/**
 * Get mock user from localStorage
 */
export function getLocalMockUser(): LocalMockUser | null {
  try {
    const stored = localStorage.getItem(LOCAL_AUTH_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

/**
 * Set mock user in localStorage
 */
export function setLocalMockUser(user: LocalMockUser): void {
  localStorage.setItem(LOCAL_AUTH_KEY, JSON.stringify(user));
}

/**
 * Clear mock user from localStorage
 */
export function clearLocalMockUser(): void {
  localStorage.removeItem(LOCAL_AUTH_KEY);
}

/**
 * Convert local mock user to EasyAuthUser format
 */
export function localMockToEasyAuthUser(mockUser: LocalMockUser): EasyAuthUser {
  return {
    id: mockUser.id,
    email: mockUser.email,
    name: mockUser.name,
    provider: mockUser.provider,
    roles: ["user"],
  };
}

/**
 * Generate a mock Microsoft user for local testing
 */
export function generateMockMicrosoftUser(email?: string): LocalMockUser {
  const mockEmail = email || "localdev@microsoft.com";
  return {
    id: `mock-aad-${Date.now()}`,
    email: mockEmail,
    name: mockEmail.split("@")[0].replace(".", " ").replace(/\b\w/g, c => c.toUpperCase()),
    provider: "aad",
  };
}

/**
 * Generate a mock Google user for local testing
 */
export function generateMockGoogleUser(email?: string): LocalMockUser {
  const mockEmail = email || "localdev@gmail.com";
  return {
    id: `mock-google-${Date.now()}`,
    email: mockEmail,
    name: mockEmail.split("@")[0].replace(".", " ").replace(/\b\w/g, c => c.toUpperCase()),
    provider: "google",
  };
}
