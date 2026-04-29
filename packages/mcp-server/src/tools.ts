import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExtensionBridge } from "./extensionBridge.js";

function jsonText(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function stripDataUrl(dataUrl: string): { data: string; mimeType: string } {
  const match = /^data:(?<mime>[^;]+);base64,(?<data>.*)$/u.exec(dataUrl);
  if (!match?.groups) {
    throw new Error("Browser returned an invalid data URL screenshot");
  }
  return {
    data: match.groups.data,
    mimeType: match.groups.mime
  };
}

export function registerTools(server: McpServer, bridge: ExtensionBridge): void {
  server.tool("browser_status", "Return MCP bridge status and extension connection state.", {}, async () => {
    return jsonText(bridge.status());
  });

  server.tool("browser_tabs_list", "List tabs visible to the browser extension.", {}, async () => {
    return jsonText(await bridge.request("tabs.list"));
  });

  server.tool("browser_active_tab", "Return the active tab in the current browser window.", {}, async () => {
    return jsonText(await bridge.request("tabs.active"));
  });

  server.tool(
    "browser_screenshot",
    "Capture a PNG screenshot from the visible browser tab.",
    {
      tabId: z.number().int().optional().describe("Optional Chrome tab id. Defaults to the active tab.")
    },
    async ({ tabId }) => {
      const result = (await bridge.request("page.screenshot", { tabId })) as { dataUrl: string };
      const image = stripDataUrl(result.dataUrl);
      return {
        content: [
          {
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType
          }
        ]
      };
    }
  );

  server.tool(
    "browser_screenshot_save",
    "Capture a PNG screenshot from the visible browser tab and save it to a local file.",
    {
      tabId: z.number().int().optional().describe("Optional Chrome tab id. Defaults to the active tab."),
      path: z.string().min(1).optional().describe("Output PNG path. Defaults to tmp/browser-screenshot.png in the current working directory.")
    },
    async ({ tabId, path }) => {
      const result = (await bridge.request("page.screenshot", { tabId })) as { dataUrl: string };
      const image = stripDataUrl(result.dataUrl);
      const outputPath = resolve(path ?? "tmp/browser-screenshot.png");
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, Buffer.from(image.data, "base64"));
      return jsonText({
        path: outputPath,
        mimeType: image.mimeType,
        bytes: Buffer.byteLength(image.data, "base64")
      });
    }
  );

  server.tool(
    "browser_dom_snapshot",
    "Return a compact DOM snapshot for a tab without executing user-provided script.",
    {
      tabId: z.number().int().optional(),
      maxNodes: z.number().int().min(1).max(5000).optional()
    },
    async (params) => jsonText(await bridge.request("page.domSnapshot", params))
  );

  server.tool(
    "browser_page_text",
    "Return visible page text in bounded chunks for long-page reading.",
    {
      tabId: z.number().int().optional(),
      offset: z.number().int().min(0).optional().default(0),
      length: z.number().int().min(1).max(20000).optional().default(8000)
    },
    async (params) => jsonText(await bridge.request("page.text", params))
  );

  server.tool(
    "browser_find_elements",
    "Find visible elements by CSS selector and optional text filter.",
    {
      tabId: z.number().int().optional(),
      selector: z.string().min(1).optional(),
      text: z.string().min(1).optional(),
      visibleOnly: z.boolean().optional().default(true),
      limit: z.number().int().min(1).max(200).optional().default(50)
    },
    async (params) => jsonText(await bridge.request("page.findElements", params))
  );

  server.tool(
    "browser_style_structure",
    "Return visible element structure with bounding boxes and selected computed CSS properties.",
    {
      tabId: z.number().int().optional(),
      maxNodes: z.number().int().min(1).max(2000).optional(),
      properties: z.array(z.string()).max(50).optional()
    },
    async (params) => jsonText(await bridge.request("page.styleStructure", params))
  );

  server.tool(
    "browser_computed_styles",
    "Return computed CSS styles for elements matching a selector.",
    {
      tabId: z.number().int().optional(),
      selector: z.string().min(1),
      properties: z.array(z.string()).min(1).max(80)
    },
    async (params) => jsonText(await bridge.request("page.computedStyles", params))
  );

  server.tool(
    "browser_run_script",
    "Run user-provided JavaScript in the page. Requires enabling script execution in the extension.",
    {
      tabId: z.number().int().optional(),
      script: z.string().min(1).describe("Function body. It receives a single variable named args and should return a serializable value."),
      args: z.unknown().optional(),
      world: z.enum(["MAIN", "ISOLATED"]).optional().default("MAIN")
    },
    async (params) => jsonText(await bridge.request("page.runScript", params))
  );

  server.tool(
    "browser_click",
    "Click a visible element matching a CSS selector.",
    {
      tabId: z.number().int().optional(),
      selector: z.string().min(1),
      index: z.number().int().min(0).optional().default(0)
    },
    async (params) => jsonText(await bridge.request("page.click", params))
  );

  server.tool(
    "browser_type_text",
    "Type text into an input, textarea, or contenteditable element matching a CSS selector.",
    {
      tabId: z.number().int().optional(),
      selector: z.string().min(1),
      text: z.string(),
      index: z.number().int().min(0).optional().default(0),
      clear: z.boolean().optional().default(true),
      pressEnter: z.boolean().optional().default(false)
    },
    async (params) => jsonText(await bridge.request("page.typeText", params))
  );

  server.tool(
    "browser_console_start_capture",
    "Start capturing console messages and page errors for a tab.",
    {
      tabId: z.number().int().optional()
    },
    async (params) => jsonText(await bridge.request("page.console.startCapture", params))
  );

  server.tool(
    "browser_console_stop_capture",
    "Stop capturing console messages and page errors for a tab.",
    {
      tabId: z.number().int().optional()
    },
    async (params) => jsonText(await bridge.request("page.console.stopCapture", params))
  );

  server.tool(
    "browser_console_logs",
    "Return captured console messages and page errors for a tab.",
    {
      tabId: z.number().int().optional(),
      limit: z.number().int().min(1).max(1000).optional().default(200)
    },
    async (params) => jsonText(await bridge.request("page.console.getLogs", params))
  );

  server.tool(
    "browser_console_clear",
    "Clear captured console messages and page errors for a tab.",
    {
      tabId: z.number().int().optional()
    },
    async (params) => jsonText(await bridge.request("page.console.clearLogs", params))
  );

  server.tool(
    "browser_network_start_capture",
    "Start capturing network metadata for a tab. Requires network capture to be enabled in the extension.",
    {
      tabId: z.number().int(),
      includeHeaders: z.boolean().optional().default(false)
    },
    async (params) => jsonText(await bridge.request("network.startCapture", params))
  );

  server.tool(
    "browser_network_stop_capture",
    "Stop capturing network metadata for a tab.",
    {
      tabId: z.number().int()
    },
    async (params) => jsonText(await bridge.request("network.stopCapture", params))
  );

  server.tool(
    "browser_network_events",
    "Return captured network metadata for a tab.",
    {
      tabId: z.number().int(),
      limit: z.number().int().min(1).max(1000).optional().default(200)
    },
    async (params) => jsonText(await bridge.request("network.getEvents", params))
  );
}
