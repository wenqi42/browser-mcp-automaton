export const DEFAULT_WS_HOST = "127.0.0.1";
export const DEFAULT_WS_PORT = 17361;
export const DEFAULT_WS_PATH = "/extension";

export const PROTOCOL_VERSION = "0.1";

export type BrowserRpcMethod =
  | "tabs.list"
  | "tabs.active"
  | "page.screenshot"
  | "page.domSnapshot"
  | "page.styleStructure"
  | "page.computedStyles"
  | "page.runScript"
  | "page.click"
  | "page.typeText"
  | "page.console.startCapture"
  | "page.console.stopCapture"
  | "page.console.getLogs"
  | "page.console.clearLogs"
  | "network.startCapture"
  | "network.stopCapture"
  | "network.getEvents";

export type BrowserRpcRequest = {
  id: string;
  type: "request";
  method: BrowserRpcMethod;
  params?: unknown;
};

export type BrowserRpcResponse =
  | {
      id: string;
      type: "response";
      ok: true;
      result: unknown;
    }
  | {
      id: string;
      type: "response";
      ok: false;
      error: {
        code: string;
        message: string;
        details?: unknown;
      };
    };

export type BrowserHello = {
  type: "hello";
  token: string;
  protocolVersion: string;
  extensionVersion?: string;
};

export type BrowserReady = {
  type: "ready";
  protocolVersion: string;
  serverName: string;
};

export type BrowserEnvelope = BrowserRpcRequest | BrowserRpcResponse | BrowserHello | BrowserReady;

export type BrowserTab = {
  id?: number;
  windowId?: number;
  title?: string;
  url?: string;
  active?: boolean;
  pinned?: boolean;
  audible?: boolean;
};

export type NetworkEvent = {
  id: string;
  tabId: number;
  type: "beforeRequest" | "beforeSendHeaders" | "completed" | "error";
  url: string;
  method?: string;
  requestId: string;
  timestamp: number;
  statusCode?: number;
  error?: string;
  requestHeaders?: Array<{ name: string; value?: string }>;
};

export type SafetyTier = "read" | "high-trust";

export const METHOD_SAFETY: Record<BrowserRpcMethod, SafetyTier> = {
  "tabs.list": "read",
  "tabs.active": "read",
  "page.screenshot": "read",
  "page.domSnapshot": "read",
  "page.styleStructure": "read",
  "page.computedStyles": "read",
  "page.runScript": "high-trust",
  "page.click": "high-trust",
  "page.typeText": "high-trust",
  "page.console.startCapture": "read",
  "page.console.stopCapture": "read",
  "page.console.getLogs": "read",
  "page.console.clearLogs": "read",
  "network.startCapture": "high-trust",
  "network.stopCapture": "high-trust",
  "network.getEvents": "read"
};

export function wsUrl(port = DEFAULT_WS_PORT): string {
  return `ws://${DEFAULT_WS_HOST}:${port}${DEFAULT_WS_PATH}`;
}
