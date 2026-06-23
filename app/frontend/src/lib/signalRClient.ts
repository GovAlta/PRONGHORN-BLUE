/**
 * WebSocket Client - Real-time messaging
 * 
 * Class names kept as SignalR* for backward compatibility with imports.
 */

// ============================================================================
// Types
// ============================================================================

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface ChannelCallback {
  type: "broadcast" | "presence";
  event: string;
  callback: (payload: any) => void;
}

// ============================================================================
// Channel Class
// ============================================================================

export class SignalRChannel {
  private channelName: string;
  private callbacks: ChannelCallback[] = [];
  private subscribed: boolean = false;
  private client: SignalRRealtimeClient;

  constructor(channelName: string, client: SignalRRealtimeClient) {
    this.channelName = channelName;
    this.client = client;
  }

  /**
   * Register for broadcast events
   */
  on(
    event: "broadcast",
    filter: { event: string },
    callback: (payload: any) => void
  ): this;

  /**
   * Register for presence events
   */
  on(
    event: "presence",
    filter: { event: string },
    callback: (payload: any) => void
  ): this;

  on(
    event: string,
    filter: { event: string },
    callback: (payload: any) => void
  ): this {
    const cb: ChannelCallback = {
      type: event as "broadcast" | "presence",
      event: filter.event,
      callback,
    };
    
    this.callbacks.push(cb);
    return this;
  }

  /**
   * Subscribe to the channel — sends join message to WebSocket server
   */
  subscribe(callback?: (status: string) => void): this {
    if (this.subscribed) {
      if (callback) callback("SUBSCRIBED");
      return this;
    }

    this.subscribed = true;

    // Ensure WebSocket is connected, then subscribe
    this.client.ensureConnected().then(() => {
      this.client.sendWsMessage({
        type: "subscribe",
        channel: this.channelName,
      });
      if (callback) callback("SUBSCRIBED");
    }).catch((err) => {
      console.warn(`[WS] Failed to subscribe to ${this.channelName}:`, err);
      // Still report as subscribed to prevent cascading errors in UI
      if (callback) callback("SUBSCRIBED");
    });

    return this;
  }

  /**
   * Unsubscribe from the channel
   */
  unsubscribe(): void {
    if (this.subscribed) {
      this.client.sendWsMessage({
        type: "unsubscribe",
        channel: this.channelName,
      });
    }
    this.subscribed = false;
    this.callbacks = [];
  }

  /**
   * Track presence
   */
  track(payload: any): this {
    this.client.sendWsMessage({
      type: "broadcast",
      channel: this.channelName,
      event: "presence",
      payload,
    });
    return this;
  }

  /**
   * Untrack presence
   */
  untrack(): this {
    return this;
  }

  /**
   * Send a broadcast message through the WebSocket server
   */
  async send(payload: { type: string; event: string; payload?: any }): Promise<string> {
    try {
      await this.client.ensureConnected();
      this.client.sendWsMessage({
        type: "broadcast",
        channel: this.channelName,
        event: payload.event,
        payload: payload.payload || {},
      });
      return "ok";
    } catch (err) {
      console.warn(`[WS] Failed to send on ${this.channelName}:`, err);
      return "ok"; 
    }
  }

  /**
   * Dispatch an incoming WebSocket message to matching callbacks
   * Called by SignalRRealtimeClient when a message arrives for this channel
   */
  _dispatch(event: string, payload: any): void {
    for (const cb of this.callbacks) {
      // Match broadcast events: event name must match
      if (cb.type === "broadcast" && cb.event === event) {
        cb.callback({ event, payload, type: "broadcast" });
      }
      // Match presence
      if (cb.type === "presence" && (cb.event === event || cb.event === "sync")) {
        cb.callback({ event, payload, type: "presence" });
      }
    }
  }

  get name(): string {
    return this.channelName;
  }

  get isSubscribed(): boolean {
    return this.subscribed;
  }
}

// ============================================================================
// Realtime Client
// ============================================================================

export class SignalRRealtimeClient {
  private channels: Map<string, SignalRChannel> = new Map();
  private ws: WebSocket | null = null;
  private _status: ConnectionStatus = "disconnected";
  private statusCallbacks: Set<(status: ConnectionStatus) => void> = new Set();
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 20;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<void> | null = null;
  private wsUrl: string = "";
  private authToken: string = "";

  constructor() {
    // Build WebSocket URL from environment
    this.buildWsUrl();
  }

private buildWsUrl(): void {
    // Route WebSocket through APIM (Standard tier supports WS)
    // VITE_WS_URL takes priority, then derive from VITE_API_BASE_URL
    const wsUrl = typeof import.meta !== "undefined" && import.meta.env?.VITE_WS_URL;
    const apiBase = typeof import.meta !== "undefined" && import.meta.env?.VITE_API_BASE_URL;

    if (wsUrl) {
      // Use explicit WS URL (e.g., wss://apim-pronghorn.azure-api.net/ws)
      this.wsUrl = wsUrl
        .replace(/\/ws\/?$/, "") // Strip /ws suffix if already included
        .replace(/\/$/, "");     // Strip trailing slash
      this.wsUrl += "/ws";
    } else if (apiBase) {
      // Derive from API base URL (goes through APIM)
      this.wsUrl = apiBase
        .replace(/^https:\/\//, "wss://")
        .replace(/^http:\/\//, "ws://")
        .replace(/\/api\/?$/, "") // Strip /api suffix
        .replace(/\/$/, "");     // Strip trailing slash
      this.wsUrl += "/ws";
    } else {
      // Fallback: same origin
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      this.wsUrl = `${proto}//${window.location.host}/ws`;
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this._status !== status) {
      this._status = status;
      for (const cb of this.statusCallbacks) {
        try { cb(status); } catch { /* ignore */ }
      }
    }
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  /**
   * Set the auth token for WebSocket connections
   */
  setToken(token: string): void {
    this.authToken = token;
  }

  /**
   * Ensure WebSocket is connected. Returns a promise that resolves when connected.
   */
  ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    return this.connect();
  }

  /**
   * Connect to the WebSocket server
   */
  private connect(): Promise<void> {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return Promise.resolve();
    }

    this.setStatus("connecting");

    this.connectPromise = new Promise<void>((resolve, reject) => {
      try {
        // Dynamically get MSAL token
        this.getAuthToken().then((token) => {
          // Build URL with auth token + APIM subscription key
          const subscriptionKey = (typeof import.meta !== "undefined" && import.meta.env?.VITE_APIM_SUBSCRIPTION_KEY) || "";
          let url = token ? `${this.wsUrl}?token=${encodeURIComponent(token)}` : this.wsUrl;
          if (subscriptionKey) {
            url += `${url.includes("?") ? "&" : "?"}subscription-key=${encodeURIComponent(subscriptionKey)}`;
          }

          const ws = new WebSocket(url);

          ws.onopen = () => {
            this.ws = ws;
            this.setStatus("connected");
            this.reconnectAttempts = 0;
            this.connectPromise = null;

            console.log("[WS] Connected to", this.wsUrl);

            // Re-subscribe to all active channels
            for (const [name, channel] of this.channels) {
              if (channel.isSubscribed) {
                this.sendWsMessage({ type: "subscribe", channel: name });
              }
            }

            resolve();
          };

          ws.onmessage = (event) => {
            try {
              const msg = JSON.parse(event.data);
              this.handleServerMessage(msg);
            } catch (err) {
              console.warn("[WS] Failed to parse message:", err);
            }
          };

          ws.onclose = (event) => {
            this.ws = null;
            this.connectPromise = null;

            if (event.code === 1000) {
              // Clean close
              this.setStatus("disconnected");
            } else {
              // Unexpected close — reconnect
              console.warn(`[WS] Connection closed (code: ${event.code}), scheduling reconnect`);
              this.setStatus("reconnecting");
              this.scheduleReconnect();
            }
          };

          ws.onerror = (err) => {
            console.error("[WS] WebSocket error:", err);
            this.connectPromise = null;
            // onclose will fire after onerror, which handles reconnect
            reject(err);
          };
        }).catch((err) => {
          this.connectPromise = null;
          this.setStatus("disconnected");
          reject(err);
        });
      } catch (err) {
        this.connectPromise = null;
        this.setStatus("disconnected");
        reject(err);
      }
    });

    return this.connectPromise;
  }

  /**
   * Get auth token from MSAL or localStorage
   */
  private async getAuthToken(): Promise<string> {
    if (this.authToken) return this.authToken;

    try {
      // Try to get MSAL token dynamically
      // Use only OIDC scopes — we only need idToken for WS auth
      const { msalInstance } = await import("./msalInstance");
      const accounts = msalInstance.getAllAccounts();
      if (accounts.length > 0) {
        const response = await msalInstance.acquireTokenSilent({
          scopes: ["openid", "profile", "email"],
          account: accounts[0],
        });
        return response.idToken;
      }
    } catch {
      // Fall through
    }

    // Fallback: check localStorage
    try {
      const stored = localStorage.getItem("auth_token");
      if (stored) return stored;
    } catch {
      // Not in browser context
    }

    return "";
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[WS] Max reconnection attempts reached");
      this.setStatus("disconnected");
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, ..., max 30s
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        console.warn("[WS] Reconnection failed:", err);
      });
    }, delay);
  }

  /**
   * Handle a message from the WebSocket server
   */
  private handleServerMessage(msg: any): void {
    if (msg.type === "broadcast" && msg.channel) {
      const channel = this.channels.get(msg.channel);
      if (channel) {
        channel._dispatch(msg.event, msg.payload);
      }
    } else if (msg.type === "pong") {
      // Application-level pong — no action needed
    }
  }

  /**
   * Send a message through the WebSocket
   */
  sendWsMessage(msg: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Get or create a channel
   */
  channel(name: string): SignalRChannel {
    if (!this.channels.has(name)) {
      this.channels.set(name, new SignalRChannel(name, this));
    }
    return this.channels.get(name)!;
  }

  /**
   * Remove a channel and unsubscribe
   */
  removeChannel(channel: SignalRChannel): void {
    channel.unsubscribe();
    for (const [name, ch] of this.channels) {
      if (ch === channel) {
        this.channels.delete(name);
        break;
      }
    }
  }

  /**
   * Remove all channels and unsubscribe
   */
  removeAllChannels(): void {
    for (const channel of this.channels.values()) {
      channel.unsubscribe();
    }
    this.channels.clear();
  }

  /**
   * Disconnect the WebSocket
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }
    this.setStatus("disconnected");
    this.connectPromise = null;
  }
}

export const signalRRealtime = new SignalRRealtimeClient();

// For backwards compatibility
export const signalRManager = {
  getStatus: () => signalRRealtime.status,
  onStatusChange: (callback: (status: ConnectionStatus) => void) => {
    (signalRRealtime as any).statusCallbacks?.add(callback);
    return () => {
      (signalRRealtime as any).statusCallbacks?.delete(callback);
    };
  },
};
