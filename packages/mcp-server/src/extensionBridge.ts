import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  DEFAULT_WS_HOST,
  DEFAULT_WS_PATH,
  DEFAULT_WS_PORT,
  PROTOCOL_VERSION,
  type BrowserHello,
  type BrowserReady,
  type BrowserRpcMethod,
  type BrowserRpcRequest,
  type BrowserRpcResponse
} from "@browser-mcp-automaton/shared";

export type ExtensionBridgeOptions = {
  host?: string;
  port?: number;
  token?: string;
  requestTimeoutMs?: number;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class ExtensionBridge {
  readonly host: string;
  readonly port: number;
  readonly token: string;

  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private server?: WebSocketServer;
  private socket?: WebSocket;
  private clientInfo?: BrowserHello;

  constructor(options: ExtensionBridgeOptions = {}) {
    this.host = options.host ?? DEFAULT_WS_HOST;
    this.port = options.port ?? DEFAULT_WS_PORT;
    this.token = options.token ?? randomUUID();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  status(): Record<string, unknown> {
    return {
      host: this.host,
      port: this.port,
      path: DEFAULT_WS_PATH,
      connected: this.connected,
      protocolVersion: PROTOCOL_VERSION,
      extensionVersion: this.clientInfo?.extensionVersion,
      pendingRequests: this.pending.size
    };
  }

  async start(): Promise<void> {
    if (this.server) return;

    const server = new WebSocketServer({
      host: this.host,
      port: this.port,
      path: DEFAULT_WS_PATH
    });
    this.server = server;

    server.on("connection", (socket) => {
      let authenticated = false;

      socket.on("message", (raw) => {
        let message: unknown;
        try {
          message = JSON.parse(String(raw));
        } catch {
          socket.close(1008, "Invalid JSON");
          return;
        }

        if (!authenticated) {
          const hello = message as Partial<BrowserHello>;
          if (hello.type !== "hello" || hello.token !== this.token) {
            socket.close(1008, "Invalid token");
            return;
          }
          authenticated = true;
          this.replaceSocket(socket, hello as BrowserHello);
          const ready: BrowserReady = {
            type: "ready",
            protocolVersion: PROTOCOL_VERSION,
            serverName: "browser-mcp-automaton"
          };
          socket.send(JSON.stringify(ready));
          return;
        }

        this.handleResponse(message as BrowserRpcResponse);
      });

      socket.on("close", () => {
        if (this.socket === socket) {
          this.socket = undefined;
          this.clientInfo = undefined;
          this.rejectPending("Browser extension disconnected");
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        server.off("listening", onListening);
        server.off("error", onError);
      };
      const onListening = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        this.server = undefined;
        reject(error);
      };
      server.once("listening", onListening);
      server.once("error", onError);
    });
  }

  async stop(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Bridge stopped"));
    }
    this.pending.clear();
    this.socket?.close();
    await new Promise<void>((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = undefined;
  }

  async request(method: BrowserRpcMethod, params?: unknown): Promise<unknown> {
    if (!this.connected || !this.socket) {
      throw new Error("No browser extension is connected. Open the extension popup and connect it to this MCP server.");
    }

    const id = randomUUID();
    const payload: BrowserRpcRequest = {
      id,
      type: "request",
      method,
      params
    };

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for browser response to ${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.socket?.send(JSON.stringify(payload), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private replaceSocket(socket: WebSocket, info: BrowserHello): void {
    if (this.socket && this.socket !== socket) {
      this.rejectPending("Browser extension connection was replaced");
      this.socket.close(1000, "Replaced by a newer extension connection");
    }
    this.socket = socket;
    this.clientInfo = info;
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  private handleResponse(response: BrowserRpcResponse): void {
    if (response?.type !== "response" || typeof response.id !== "string") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(response.id);

    if (response.ok) {
      pending.resolve(response.result);
      return;
    }

    pending.reject(new Error(`${response.error.code}: ${response.error.message}`));
  }
}
