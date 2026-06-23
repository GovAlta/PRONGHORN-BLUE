/**
 * Pronghorn API Client
 *
 * Re-exports the Pronghorn API adapter (and related realtime types) under a
 * convenient `pronghornApi` binding for use throughout the frontend. All
 * database, RPC, storage, and function calls are routed through the Pronghorn
 * API (Azure APIM); realtime channels use Azure SignalR.
 */

export { pronghornApiAdapter as pronghornApi, RealtimeChannel } from "@/lib/pronghornApiAdapter";

// Also export types that may be used elsewhere
export type { Database } from "./types";
