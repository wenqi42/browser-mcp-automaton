#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_WS_PORT } from "@browser-mcp-automaton/shared";
import { ExtensionBridge } from "./extensionBridge.js";
import { registerTools } from "./tools.js";

const port = Number.parseInt(process.env.BMA_PORT ?? String(DEFAULT_WS_PORT), 10);
const token = process.env.BMA_TOKEN;

const bridge = new ExtensionBridge({ port, token });
try {
  await bridge.start();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[browser-mcp-automaton] Failed to start WebSocket bridge: ${message}`);
  console.error("[browser-mcp-automaton] Set BMA_PORT to a free local port or stop the existing server.");
  process.exit(1);
}

console.error("[browser-mcp-automaton] WebSocket bridge listening");
console.error(`[browser-mcp-automaton] URL: ws://127.0.0.1:${bridge.port}/extension`);
console.error(`[browser-mcp-automaton] Token: ${bridge.token}`);
console.error("[browser-mcp-automaton] Paste the URL and token into the browser extension popup.");

const server = new McpServer({
  name: "browser-mcp-automaton",
  version: "0.1.0"
});

registerTools(server, bridge);

const shutdown = async () => {
  await bridge.stop();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await server.connect(new StdioServerTransport());
