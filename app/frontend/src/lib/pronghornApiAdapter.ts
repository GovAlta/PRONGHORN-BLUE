/**
 * Pronghorn API Adapter
 *
 * Routes all database, auth, storage, realtime, and function operations
 * through the Pronghorn API (Azure APIM-backed). Exposes a PostgREST-style
 * query builder interface so callers can use a familiar fluent API.
 *
 * Usage:
 *   import { pronghornApiAdapter } from "@/lib/pronghornApiAdapter";
 */

import { getAccessToken, getStoredToken } from "./apiClient";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";
const APIM_SUBSCRIPTION_KEY = import.meta.env.VITE_APIM_SUBSCRIPTION_KEY || "";

/**
 * Get access token for API calls.
 *
 * Delegates to the shared getAccessToken() in apiClient which handles
 * InteractionRequiredAuthError with a popup fallback. Falls back to
 * getStoredToken() for legacy non-MSAL sessions.
 */
async function getMsalToken(): Promise<string | null> {
  const token = await getAccessToken();
  return token ?? getStoredToken();
}

// ============================================================================
// Types
// ============================================================================

interface FilterOperator {
  op:
    | "eq"
    | "neq"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "like"
    | "ilike"
    | "in"
    | "is";
  value: any;
}

interface QueryFilters {
  [key: string]: any | FilterOperator;
}

interface QueryOrder {
  [key: string]: "asc" | "desc";
}

interface QueryResult<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
}

// ============================================================================
// Query Builder (PostgREST-style fluent builder)
// ============================================================================

class QueryBuilder<T = any> {
  private tableName: string;
  private queryType: "select" | "insert" | "update" | "delete" | "upsert" =
    "select";
  private columns: string = "*";
  private filters: QueryFilters = {};
  private orderBy: QueryOrder = {};
  private limitCount?: number;
  private offsetCount?: number;
  private isSingle: boolean = false;
  private insertData?: any;
  private updateData?: any;
  private upsertConflict?: string;
  private returningColumns: string = "*";

  constructor(tableName: string) {
    this.tableName = tableName;
  }

  // SELECT methods
  select(columns: string = "*"): this {
    this.queryType = "select";
    this.columns = columns;
    return this;
  }

  // INSERT methods
  insert(data: any | any[]): this {
    this.queryType = "insert";
    this.insertData = data;
    return this;
  }

  // UPDATE methods
  update(data: any): this {
    this.queryType = "update";
    this.updateData = data;
    return this;
  }

  // DELETE method
  delete(): this {
    this.queryType = "delete";
    return this;
  }

  // UPSERT method
  upsert(data: any | any[], options?: { onConflict?: string }): this {
    this.queryType = "upsert";
    this.insertData = data;
    this.upsertConflict = options?.onConflict;
    return this;
  }

  // Filter methods
  eq(column: string, value: any): this {
    this.filters[column] = value;
    return this;
  }

  neq(column: string, value: any): this {
    this.filters[column] = { op: "neq", value };
    return this;
  }

  gt(column: string, value: any): this {
    this.filters[column] = { op: "gt", value };
    return this;
  }

  gte(column: string, value: any): this {
    this.filters[column] = { op: "gte", value };
    return this;
  }

  lt(column: string, value: any): this {
    this.filters[column] = { op: "lt", value };
    return this;
  }

  lte(column: string, value: any): this {
    this.filters[column] = { op: "lte", value };
    return this;
  }

  like(column: string, value: string): this {
    this.filters[column] = { op: "like", value };
    return this;
  }

  ilike(column: string, value: string): this {
    this.filters[column] = { op: "ilike", value };
    return this;
  }

  in(column: string, values: any[]): this {
    this.filters[column] = { op: "in", value: values };
    return this;
  }

  is(column: string, value: null | boolean): this {
    this.filters[column] = { op: "is", value };
    return this;
  }

  // OR filter - combines multiple conditions with OR
  or(filterString: string): this {
    // Parse the filter string like "column1.eq.value1,column2.eq.value2"
    // This is a simplified implementation - stores the raw string for backend processing
    this.filters["_or"] = { op: "or", value: filterString };
    return this;
  }

  // Ordering
  order(column: string, options?: { ascending?: boolean }): this {
    this.orderBy[column] = options?.ascending === false ? "desc" : "asc";
    return this;
  }

  // Pagination
  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  range(from: number, to: number): this {
    this.offsetCount = from;
    this.limitCount = to - from + 1;
    return this;
  }

  // Result modifiers
  single(): this {
    this.isSingle = true;
    return this;
  }

  maybeSingle(): this {
    this.isSingle = true;
    return this;
  }

  // Execute query
  async then<TResult>(
    onfulfilled?: (value: QueryResult<T>) => TResult | PromiseLike<TResult>,
  ): Promise<TResult> {
    const result = await this.execute();
    return onfulfilled ? onfulfilled(result) : (result as unknown as TResult);
  }

  private async execute(): Promise<QueryResult<T>> {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };

    if (APIM_SUBSCRIPTION_KEY) {
      headers["Ocp-Apim-Subscription-Key"] = APIM_SUBSCRIPTION_KEY;
    }

    const token = await getMsalToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    try {
      let endpoint: string;
      let body: any;

      switch (this.queryType) {
        case "select":
          endpoint = "/api/v1/db/select";
          body = {
            table: this.tableName,
            columns: this.columns,
            filters:
              Object.keys(this.filters).length > 0 ? this.filters : undefined,
            order:
              Object.keys(this.orderBy).length > 0 ? this.orderBy : undefined,
            limit: this.limitCount,
            offset: this.offsetCount,
            single: this.isSingle,
          };
          break;

        case "insert":
          endpoint = "/api/v1/db/insert";
          body = {
            table: this.tableName,
            data: this.insertData,
            returning: this.returningColumns,
          };
          break;

        case "update":
          endpoint = "/api/v1/db/update";
          body = {
            table: this.tableName,
            data: this.updateData,
            filters:
              Object.keys(this.filters).length > 0 ? this.filters : undefined,
            returning: this.returningColumns,
          };
          break;

        case "delete":
          endpoint = "/api/v1/db/delete";
          body = {
            table: this.tableName,
            filters:
              Object.keys(this.filters).length > 0 ? this.filters : undefined,
            returning: this.returningColumns,
          };
          break;

        case "upsert":
          endpoint = "/api/v1/db/upsert";
          body = {
            table: this.tableName,
            data: this.insertData,
            onConflict: this.upsertConflict,
            returning: this.returningColumns,
          };
          break;

        default:
          throw new Error(`Unknown query type: ${this.queryType}`);
      }

      console.log(
        `[PronghornApiAdapter] ${this.queryType.toUpperCase()} ${this.tableName} -> ${API_BASE_URL}${endpoint}`,
      );

      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          data: null,
          error: {
            message:
              errorData.message ||
              errorData.error ||
              `Request failed with status ${response.status}`,
            code: errorData.code || response.status.toString(),
          },
        };
      }

      const result = await response.json();
      return { data: result.data, error: null };
    } catch (error: any) {
      console.error("[PronghornApiAdapter] Error:", error);
      return {
        data: null,
        error: { message: error.message || "Unknown error" },
      };
    }
  }
}

// ============================================================================
// RPC Function Caller
// ============================================================================

class RpcCaller {
  async invoke<T = any>(
    functionName: string,
    params?: Record<string, any>,
  ): Promise<QueryResult<T>> {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };

    if (APIM_SUBSCRIPTION_KEY) {
      headers["Ocp-Apim-Subscription-Key"] = APIM_SUBSCRIPTION_KEY;
    }

    const token = await getMsalToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    try {
      const endpoint = `/api/v1/rpc/${functionName}`;
      console.log(
        `[PronghornApiAdapter] RPC ${functionName} -> ${API_BASE_URL}${endpoint}`,
      );

      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(params || {}),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          data: null,
          error: {
            message:
              errorData.message ||
              errorData.error ||
              `Request failed with status ${response.status}`,
            code: errorData.code || response.status.toString(),
          },
        };
      }

      const result = await response.json();

      // Check if the backend returned an error in the response body
      if (result.error) {
        return {
          data: null,
          error: {
            message:
              typeof result.error === "string"
                ? result.error
                : result.error.message || "RPC error",
            code: result.error.code || "RPC_ERROR",
          },
        };
      }

      return { data: result.data, error: null };
    } catch (error: any) {
      console.error("[PronghornApiAdapter] RPC Error:", error);
      return {
        data: null,
        error: { message: error.message || "Unknown error" },
      };
    }
  }
}

// ============================================================================
// Functions Invoker (serverless-style function endpoints)
// ============================================================================

class FunctionsInvoker {
  async invoke<T = any>(
    functionName: string,
    options?: { body?: any },
  ): Promise<{ data: T | null; error: { message: string } | null }> {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };

    if (APIM_SUBSCRIPTION_KEY) {
      headers["Ocp-Apim-Subscription-Key"] = APIM_SUBSCRIPTION_KEY;
    }

    const token = await getMsalToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    try {
      const endpoint = `/api/v1/functions/${functionName}`;
      console.log(
        `[PronghornApiAdapter] Function ${functionName} -> ${API_BASE_URL}${endpoint}`,
      );

      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(options?.body || {}),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage =
          errorData.message ||
          errorData.error ||
          `Request failed with status ${response.status}`;
        console.error(
          `[PronghornApiAdapter] Function ${functionName} failed with status ${response.status}:`,
          errorData,
          "-> errorMessage:",
          errorMessage,
        );
        return {
          data: null,
          error: {
            message: errorMessage,
          },
        };
      }

      const result = await response.json();

      // Check if the backend returned an error in the response
      if (result.error) {
        return {
          data: null,
          error: {
            message:
              typeof result.error === "string"
                ? result.error
                : result.error.message || "Function error",
          },
        };
      }

      return { data: result as T, error: null };
    } catch (error: any) {
      console.error("[PronghornApiAdapter] Function Error:", error);
      return {
        data: null,
        error: { message: error.message || "Unknown error" },
      };
    }
  }
}

// ============================================================================
// Realtime (Azure SignalR Integration)
// ============================================================================

import {
  SignalRChannel,
  signalRRealtime,
} from "./signalRClient";

// Re-export SignalR types under generic Realtime names
type RealtimeChannel = SignalRChannel;

// ============================================================================
// Auth Adapter (delegates to authApi)
// ============================================================================

import { authApi, getStoredUser, ApiUser } from "./apiClient";

class AuthClient {
  async getSession(): Promise<{ data: { session: any } }> {
    const token = await getMsalToken();
    const user = getStoredUser();
    return {
      data: {
        session: token ? { access_token: token, user } : null,
      },
    };
  }

  async getUser(): Promise<{ data: { user: ApiUser | null } }> {
    return { data: { user: getStoredUser() } };
  }

  async signInWithPassword(credentials: {
    email: string;
    password: string;
  }): Promise<{ error: any }> {
    try {
      await authApi.signIn(credentials.email, credentials.password);
      return { error: null };
    } catch (e: any) {
      return { error: { message: e.message } };
    }
  }

  async signUp(credentials: {
    email: string;
    password: string;
  }): Promise<{ error: any }> {
    try {
      await authApi.signUp(credentials.email, credentials.password);
      return { error: null };
    } catch (e: any) {
      return { error: { message: e.message } };
    }
  }

  async signOut(options?: { scope?: string }): Promise<{ error: any }> {
    await authApi.signOut();
    return { error: null };
  }

  async signInWithOAuth(options: {
    provider: string;
    options?: { redirectTo?: string; scopes?: string };
  }): Promise<{ error: any }> {
    // Redirect to APIM OAuth endpoints
    const provider = options.provider.toLowerCase();
    const redirectTo = options.options?.redirectTo || "/dashboard";

    let oauthUrl: string;

    switch (provider) {
      case "google":
        oauthUrl = `${API_BASE_URL}/api/v1/auth/oauth/google?redirectTo=${encodeURIComponent(redirectTo)}`;
        break;
      case "azure":
        oauthUrl = `${API_BASE_URL}/api/v1/auth/oauth/azure?redirectTo=${encodeURIComponent(redirectTo)}`;
        break;
      default:
        return {
          error: { message: `OAuth provider '${provider}' is not supported` },
        };
    }

    // Redirect to OAuth endpoint
    window.location.href = oauthUrl;

    // This won't actually return since we're redirecting
    return { error: null };
  }

  async updateUser(attributes: { password?: string }): Promise<{ error: any }> {
    if (attributes.password) {
      // Call password update endpoint
      try {
        const token = await getMsalToken();
        const response = await fetch(
          `${API_BASE_URL}/api/v1/auth/update-password`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
              ...(APIM_SUBSCRIPTION_KEY
                ? { "Ocp-Apim-Subscription-Key": APIM_SUBSCRIPTION_KEY }
                : {}),
            },
            body: JSON.stringify({ password: attributes.password }),
          },
        );

        if (!response.ok) {
          const data = await response.json();
          return {
            error: { message: data.message || "Failed to update password" },
          };
        }

        return { error: null };
      } catch (e: any) {
        return { error: { message: e.message } };
      }
    }
    return { error: null };
  }

  async refreshSession(): Promise<{ error: any }> {
    try {
      await authApi.refreshToken();
      return { error: null };
    } catch (e: any) {
      return { error: { message: e.message } };
    }
  }

  onAuthStateChange(callback: (event: string, session: any) => void): {
    data: { subscription: { unsubscribe: () => void } };
  } {
    // For Azure API mode, we don't have real-time auth state changes
    // Just call with initial state (async to get MSAL token)
    (async () => {
      const token = await getMsalToken();
      const user = getStoredUser();
      setTimeout(() => {
        callback(
          "INITIAL_SESSION",
          token ? { access_token: token, user } : null,
        );
      }, 0);
    })();

    return {
      data: {
        subscription: {
          unsubscribe: () => {},
        },
      },
    };
  }
}

// ============================================================================
// Storage Adapter (Azure Blob Storage via APIM)
// ============================================================================

interface StorageFile {
  name: string;
  id?: string;
  updated_at?: string;
  created_at?: string;
  last_accessed_at?: string;
  metadata?: Record<string, any>;
}

interface StorageUploadResult {
  path: string;
  id?: string;
  fullPath?: string;
}

class StorageBucket {
  private bucketName: string;

  constructor(bucketName: string) {
    this.bucketName = bucketName;
  }

  async list(
    path?: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{
    data: StorageFile[] | null;
    error: { message: string } | null;
  }> {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };

    if (APIM_SUBSCRIPTION_KEY) {
      headers["Ocp-Apim-Subscription-Key"] = APIM_SUBSCRIPTION_KEY;
    }

    const token = await getMsalToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    try {
      const endpoint = `/api/v1/storage/${this.bucketName}/list`;
      console.log(
        `[StorageAdapter] List ${this.bucketName}/${path || ""} -> ${API_BASE_URL}${endpoint}`,
      );

      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ path: path || "", ...options }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          data: null,
          error: {
            message:
              errorData.message ||
              errorData.error ||
              `Request failed with status ${response.status}`,
          },
        };
      }

      const result = await response.json();
      return { data: result.data || result || [], error: null };
    } catch (error: any) {
      console.error("[StorageAdapter] List Error:", error);
      return {
        data: null,
        error: { message: error.message || "Unknown error" },
      };
    }
  }

  async upload(
    path: string,
    file: File | Blob | ArrayBuffer,
    options?: { contentType?: string; upsert?: boolean },
  ): Promise<{
    data: StorageUploadResult | null;
    error: { message: string } | null;
  }> {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };

    if (APIM_SUBSCRIPTION_KEY) {
      headers["Ocp-Apim-Subscription-Key"] = APIM_SUBSCRIPTION_KEY;
    }

    const token = await getMsalToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    try {
      const endpoint = `/api/v1/storage/${this.bucketName}/upload`;
      console.log(
        `[StorageAdapter] Upload ${this.bucketName}/${path} -> ${API_BASE_URL}${endpoint}`,
      );

      // Convert file to base64
      let arrayBuffer: ArrayBuffer;
      if (file instanceof File || file instanceof Blob) {
        arrayBuffer = await file.arrayBuffer();
      } else {
        arrayBuffer = file;
      }

      // Convert ArrayBuffer to base64
      const uint8Array = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < uint8Array.byteLength; i++) {
        binary += String.fromCharCode(uint8Array[i]);
      }
      const base64Content = btoa(binary);

      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          path,
          content: base64Content,
          contentType: options?.contentType,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          data: null,
          error: {
            message:
              errorData.message ||
              errorData.error ||
              `Upload failed with status ${response.status}`,
          },
        };
      }

      const result = await response.json();
      return { data: result.data || { path }, error: null };
    } catch (error: any) {
      console.error("[StorageAdapter] Upload Error:", error);
      return {
        data: null,
        error: { message: error.message || "Unknown error" },
      };
    }
  }

  async download(
    path: string,
  ): Promise<{ data: Blob | null; error: { message: string } | null }> {
    const headers: HeadersInit = {};

    if (APIM_SUBSCRIPTION_KEY) {
      headers["Ocp-Apim-Subscription-Key"] = APIM_SUBSCRIPTION_KEY;
    }

    const token = await getMsalToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    try {
      const endpoint = `/api/v1/storage/${this.bucketName}/download?path=${encodeURIComponent(path)}`;
      console.log(
        `[StorageAdapter] Download ${this.bucketName}/${path} -> ${API_BASE_URL}${endpoint}`,
      );

      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        return {
          data: null,
          error: { message: `Download failed with status ${response.status}` },
        };
      }

      const blob = await response.blob();
      return { data: blob, error: null };
    } catch (error: any) {
      console.error("[StorageAdapter] Download Error:", error);
      return {
        data: null,
        error: { message: error.message || "Unknown error" },
      };
    }
  }

  async remove(
    paths: string[],
  ): Promise<{
    data: { message: string } | null;
    error: { message: string } | null;
  }> {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };

    if (APIM_SUBSCRIPTION_KEY) {
      headers["Ocp-Apim-Subscription-Key"] = APIM_SUBSCRIPTION_KEY;
    }

    const token = await getMsalToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    try {
      const endpoint = `/api/v1/storage/${this.bucketName}/remove`;
      console.log(
        `[StorageAdapter] Remove ${this.bucketName} -> ${API_BASE_URL}${endpoint}`,
      );

      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ paths }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          data: null,
          error: {
            message:
              errorData.message ||
              errorData.error ||
              `Remove failed with status ${response.status}`,
          },
        };
      }

      return { data: { message: "Files removed" }, error: null };
    } catch (error: any) {
      console.error("[StorageAdapter] Remove Error:", error);
      return {
        data: null,
        error: { message: error.message || "Unknown error" },
      };
    }
  }

  getPublicUrl(path: string): { data: { publicUrl: string } } {
    // Generate public URL via APIM storage endpoint
    const publicUrl = `${API_BASE_URL}/api/v1/storage/${this.bucketName}/public/${path}`;
    console.log(`[StorageAdapter] Public URL: ${publicUrl}`);
    return { data: { publicUrl } };
  }

  createSignedUrl(
    path: string,
    expiresIn: number,
  ): Promise<{
    data: { signedUrl: string } | null;
    error: { message: string } | null;
  }> {
    // For now, just return the public URL - signed URL functionality can be added later
    const publicUrl = `${API_BASE_URL}/api/v1/storage/${this.bucketName}/public/${path}`;
    return Promise.resolve({ data: { signedUrl: publicUrl }, error: null });
  }
}

class StorageClient {
  from(bucketName: string): StorageBucket {
    return new StorageBucket(bucketName);
  }
}

// ============================================================================
// Main Pronghorn API Adapter
// ============================================================================

const rpcCaller = new RpcCaller();
const storageClient = new StorageClient();

class PronghornApiAdapter {
  auth = new AuthClient();
  functions = new FunctionsInvoker();
  realtime = signalRRealtime; // Use SignalR for realtime
  storage = storageClient;

  from<T = any>(tableName: string): QueryBuilder<T> {
    return new QueryBuilder<T>(tableName);
  }

  rpc<T = any>(
    functionName: string,
    params?: Record<string, any>,
  ): Promise<QueryResult<T>> {
    return rpcCaller.invoke<T>(functionName, params);
  }

  channel(name: string): RealtimeChannel {
    return this.realtime.channel(name);
  }

  removeChannel(channel: RealtimeChannel): void {
    this.realtime.removeChannel(channel);
  }

  removeAllChannels(): void {
    this.realtime.removeAllChannels();
  }
}

// Create singleton instance
export const pronghornApiAdapter = new PronghornApiAdapter();

// Export as default
export default pronghornApiAdapter;

// Also export the class for typing
export { PronghornApiAdapter, QueryBuilder };

// Export SignalRChannel as RealtimeChannel for compatibility
export { SignalRChannel as RealtimeChannel } from "./signalRClient";
