/**
 * WebSocket Server - Real-time messaging
 * 
 * Architecture:
 * - Clients connect directly to Container App (bypasses APIM - Consumption tier doesn't support WS)
 * - JWT authentication on connection handshake via query param or first message
 * - Channel-based pub/sub with group routing
 * - broadcast() utility callable from any Express handler
 * 
 * Channel patterns used by broadcast():
 *   project-{projectId}                → project_refresh
 *   project-{projectId}-requirements   → requirements_refresh, requirement_position_refresh, requirement_added
 *   project-{projectId}-specifications → specification_refresh
 *   project-{projectId}-artifacts      → artifact_refresh
 *   project-{projectId}-canvas         → canvas_refresh
 *   project-{projectId}-testing        → testing_log_refresh
 *   project-{projectId}-standards      → project_standards_refresh
 *   repo-staging-{repoId}              → staging_refresh
 *   repo-changes-{projectId}           → repo_files_refresh
 *   repos-{projectId}                  → repos_refresh
 *   agent-session-{projectId}          → agent_session_refresh
 *   collaboration-{artifactId}         → collaboration_edit, collaboration_blackboard, collaboration_message, collaboration_restore
 *   audit-{projectId}                  → audit_refresh
 *   database-{projectId}               → database_refresh
 *   external-db-{projectId}            → external_db_refresh
 *   deployments-{projectId}            → deployment_refresh
 *   tokens-{projectId}                 → tokens_refresh
 *   chat-sessions-{projectId}          → chat_session_refresh
 *   chat-messages-{sessionId}          → chat_message_refresh
 *   presentations-{projectId}          → presentation_refresh
 *   build-books-realtime               → build_books_refresh
 *   build-book-{buildBookId}           → build_book_refresh
 */

import { Server as HttpServer } from "http";
import { WebSocketServer, WebSocket, RawData } from "ws";
import { IncomingMessage } from "http";
import { URL } from "url";
import jwt from "jsonwebtoken";
import jwksRsa from "jwks-rsa";
import { logger } from "./utils/logger";
import { seedUserIfMissing } from "./middleware/auth";

// ============================================================================
// Types
// ============================================================================

interface WsClient {
  ws: WebSocket;
  id: string;
  userId?: string;
  email?: string;
  channels: Set<string>;
  isAlive: boolean;
  connectedAt: number;
}

interface WsMessage {
  type: "subscribe" | "unsubscribe" | "broadcast" | "ping" | "pong";
  channel?: string;
  channels?: string[];
  event?: string;
  payload?: any;
}

interface BroadcastMessage {
  type: "broadcast";
  channel: string;
  event: string;
  payload: any;
  timestamp: number;
}

// ============================================================================
// WebSocket Server
// ============================================================================

// Client registry: clientId → WsClient
const clients = new Map<string, WsClient>();

// Channel registry: channelName → Set<clientId>
const channels = new Map<string, Set<string>>();

// Heartbeat interval
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

// JWKS client for Azure AD token validation (shared with auth middleware).
// Reads ENTRA_* (not AZURE_*) to avoid clashing with @azure/identity SDK
// env var reservations — see app/backend/src/middleware/auth.ts for details.
//
// Fail-fast: missing values yield an unusable JWKS URL and silently rejected
// connections, so refuse to boot rather than degrade silently.
const TENANT_ID = process.env.ENTRA_TENANT_ID;
const CLIENT_ID = process.env.ENTRA_CLIENT_ID;

if (!TENANT_ID) {
  throw new Error(
    "ENTRA_TENANT_ID is required. Set it in your .env file or in the container environment. " +
    "See app/backend/.env.example for details."
  );
}
if (!CLIENT_ID) {
  throw new Error(
    "ENTRA_CLIENT_ID is required. Set it in your .env file or in the container environment. " +
    "See app/backend/.env.example for details."
  );
}

const jwksClient = jwksRsa({
  jwksUri: `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 600000,
});

/**
 * Validate JWT token from Azure AD or local dev token
 */
async function validateToken(token: string): Promise<{ userId: string; email?: string } | null> {
  // Development mode: accept APIM-style headers encoded in token
  if (process.env.NODE_ENV === "development" || process.env.SKIP_AUTH === "true") {
    try {
      // Try simple JWT decode for dev tokens
      const decoded = jwt.decode(token) as any;
      if (decoded) {
        return {
          userId: decoded.sub || decoded.oid || decoded.id || "dev-user",
          email: decoded.email || decoded.preferred_username,
        };
      }
    } catch {
      // Fall through to Azure AD validation
    }
  }

  return new Promise((resolve) => {
    jwt.verify(
      token,
      (header, callback) => {
        jwksClient.getSigningKey(header.kid, (err, key) => {
          if (err) {
            callback(err);
            return;
          }
          callback(null, key?.getPublicKey());
        });
      },
      {
        audience: CLIENT_ID,
        issuer: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
        algorithms: ["RS256"],
      },
      (err, decoded: any) => {
        if (err) {
          logger.debug("WebSocket JWT validation failed:", err.message);
          resolve(null);
          return;
        }
        const userId = decoded.oid || decoded.sub;
        const email =
          decoded.email ||
          decoded.preferred_username ||
          decoded.upn ||
          decoded.unique_name;
        // Seed auth.users for WS-first sign-ins (e.g. a client that opens
        // a socket before issuing any REST call). Fire-and-forget: a seed
        // failure must not block the handshake.
        void seedUserIfMissing({ id: userId, email, name: decoded.name });
        resolve({
          userId,
          email,
        });
      }
    );
  });
}

/**
 * Generate a unique client ID
 */
function generateClientId(): string {
  return `ws-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Add a client to a channel
 */
function joinChannel(clientId: string, channelName: string): void {
  const client = clients.get(clientId);
  if (!client) return;

  // Add to channel set
  if (!channels.has(channelName)) {
    channels.set(channelName, new Set());
  }
  channels.get(channelName)!.add(clientId);
  client.channels.add(channelName);

  logger.debug(`Client ${clientId} joined channel ${channelName}`);

  // Confirm subscription to client
  sendToClient(client, {
    type: "broadcast",
    channel: channelName,
    event: "system",
    payload: { status: "SUBSCRIBED", channel: channelName },
    timestamp: Date.now(),
  });
}

/**
 * Remove a client from a channel
 */
function leaveChannel(clientId: string, channelName: string): void {
  const client = clients.get(clientId);
  if (!client) return;

  const channelClients = channels.get(channelName);
  if (channelClients) {
    channelClients.delete(clientId);
    if (channelClients.size === 0) {
      channels.delete(channelName);
    }
  }
  client.channels.delete(channelName);

  logger.debug(`Client ${clientId} left channel ${channelName}`);
}

/**
 * Remove a client from all channels and clean up
 */
function removeClient(clientId: string): void {
  const client = clients.get(clientId);
  if (!client) return;

  // Remove from all channels
  for (const channelName of client.channels) {
    const channelClients = channels.get(channelName);
    if (channelClients) {
      channelClients.delete(clientId);
      if (channelClients.size === 0) {
        channels.delete(channelName);
      }
    }
  }

  clients.delete(clientId);
  logger.debug(`Client ${clientId} removed (was in ${client.channels.size} channels)`);
}

/**
 * Send a message to a specific client
 */
function sendToClient(client: WsClient, message: BroadcastMessage): void {
  if (client.ws.readyState === WebSocket.OPEN) {
    try {
      client.ws.send(JSON.stringify(message));
    } catch (err) {
      logger.error(`Failed to send to client ${client.id}:`, err);
    }
  }
}

/**
 * Broadcast a message to all clients subscribed to a channel
 * This is the main function used by Express handlers to push real-time events
 * 
 * @param channelName - The channel name (e.g., 'project_repos-{projectId}')
 * @param event - The event name (e.g., 'repos_refresh')
 * @param payload - Optional data payload
 * @param excludeClientId - Optional client ID to exclude (prevent echo)
 */
export function broadcast(
  channelName: string,
  event: string,
  payload: any = {},
  excludeClientId?: string
): void {
  const channelClients = channels.get(channelName);
  if (!channelClients || channelClients.size === 0) {
    logger.debug(`No subscribers for channel ${channelName}, skipping broadcast`);
    return;
  }

  const message: BroadcastMessage = {
    type: "broadcast",
    channel: channelName,
    event,
    payload,
    timestamp: Date.now(),
  };

  let sentCount = 0;
  for (const clientId of channelClients) {
    if (clientId === excludeClientId) continue;
    const client = clients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      sendToClient(client, message);
      sentCount++;
    }
  }

  logger.debug(`Broadcast to channel ${channelName}: event=${event}, recipients=${sentCount}`);
}

/**
 * Handle incoming WebSocket message
 */
function handleMessage(clientId: string, data: RawData): void {
  const client = clients.get(clientId);
  if (!client) return;

  let msg: WsMessage;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    logger.warn(`Invalid JSON from client ${clientId}`);
    return;
  }

  switch (msg.type) {
    case "subscribe": {
      // Support single channel or batch subscription
      const channelsToJoin = msg.channels || (msg.channel ? [msg.channel] : []);
      for (const ch of channelsToJoin) {
        joinChannel(clientId, ch);
      }
      break;
    }

    case "unsubscribe": {
      const channelsToLeave = msg.channels || (msg.channel ? [msg.channel] : []);
      for (const ch of channelsToLeave) {
        leaveChannel(clientId, ch);
      }
      break;
    }

    case "broadcast": {
      // Client-to-client broadcast (relay through server)
      if (msg.channel && msg.event) {
        broadcast(msg.channel, msg.event, msg.payload || {}, clientId);
      }
      break;
    }

    case "ping": {
      // Application-level ping (separate from WS protocol ping)
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      }
      break;
    }

    default:
      logger.debug(`Unknown message type from ${clientId}: ${msg.type}`);
  }
}

/**
 * Initialize WebSocket server and attach to existing HTTP server
 */
export function initWebSocket(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: 1024 * 1024, // 1MB max message size
  });

  logger.info("WebSocket server initialized on /ws path");

  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    const clientId = generateClientId();

    // Extract token from query params or headers
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const token = url.searchParams.get("token") ||
      req.headers.authorization?.replace("Bearer ", "") ||
      "";

    let userId: string | undefined;
    let email: string | undefined;

    // Validate token (optional auth — allow anonymous connections for public shared projects)
    if (token) {
      const auth = await validateToken(token);
      if (auth) {
        userId = auth.userId;
        email = auth.email;
      }
    }

    // Register client
    const client: WsClient = {
      ws,
      id: clientId,
      userId,
      email,
      channels: new Set(),
      isAlive: true,
      connectedAt: Date.now(),
    };
    clients.set(clientId, client);

    logger.info(`WebSocket client connected: ${clientId} (user: ${userId || "anonymous"})`);

    // Send welcome message with client ID
    ws.send(JSON.stringify({
      type: "broadcast",
      channel: "system",
      event: "connected",
      payload: { clientId, userId, timestamp: Date.now() },
      timestamp: Date.now(),
    }));

    // Handle incoming messages
    ws.on("message", (data: RawData) => {
      client.isAlive = true;
      handleMessage(clientId, data);
    });

    // Handle pong (for heartbeat)
    ws.on("pong", () => {
      client.isAlive = true;
    });

    // Handle disconnect
    ws.on("close", (code: number, reason: Buffer) => {
      logger.info(`WebSocket client disconnected: ${clientId} (code: ${code})`);
      removeClient(clientId);
    });

    // Handle errors
    ws.on("error", (err: Error) => {
      logger.error(`WebSocket error for client ${clientId}:`, err);
      removeClient(clientId);
    });
  });

  // Heartbeat: ping all clients every 30 seconds, terminate dead connections
  heartbeatInterval = setInterval(() => {
    for (const [clientId, client] of clients) {
      if (!client.isAlive) {
        logger.debug(`Terminating unresponsive client: ${clientId}`);
        client.ws.terminate();
        removeClient(clientId);
        continue;
      }
      client.isAlive = false;
      client.ws.ping();
    }
  }, 30000);

  wss.on("close", () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  });

  return wss;
}

/**
 * Get WebSocket server stats (for health checks / monitoring)
 */
export function getWsStats(): {
  totalClients: number;
  totalChannels: number;
  channels: Record<string, number>;
} {
  const channelStats: Record<string, number> = {};
  for (const [name, clientSet] of channels) {
    channelStats[name] = clientSet.size;
  }

  return {
    totalClients: clients.size,
    totalChannels: channels.size,
    channels: channelStats,
  };
}
