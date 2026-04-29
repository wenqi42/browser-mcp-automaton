# Browser MCP Automaton

Browser MCP Automaton connects an AI agent to the user's real Chrome or Edge browser through an explicit local bridge:

```text
MCP client -> Node MCP server -> localhost WebSocket -> browser extension -> current browser tabs
```

It is designed for tasks where an isolated automation browser is not enough, such as inspecting a page the user is already logged into, taking screenshots of the real tab, reading computed styles, or collecting network metadata from the actual browser session.

## Status

This is an early open-source foundation. It favors a clear security model and readable code over pretending every browser capability is solved.

Implemented:

- MCP stdio server
- Local WebSocket bridge with token authentication
- Chrome/Edge MV3 extension
- Tab listing and active tab inspection
- Visible-tab screenshot capture
- Compact DOM snapshot
- Bounded page text extraction
- Visible element discovery
- Computed style and layout structure extraction
- Console message and page error capture
- Click and text-entry helpers for common page interactions
- Optional page script execution
- Optional network metadata capture with sensitive headers redacted

Known limits:

- Network response bodies are not captured by the MV3 extension path.
- Full DevTools Protocol control is out of scope for the default mode.
- Screenshots use `chrome.tabs.captureVisibleTab`, so they capture the visible viewport.
- Script execution and network capture must be explicitly enabled in the extension popup.

## Install

```bash
npm install
npm run build
```

Use Node.js 22+ and npm 10+. Older npm versions do not understand this repository's workspace lockfile.

The built extension is copied to:

```text
packages/extension/dist
```

Load it in Chrome or Edge:

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable developer mode.
3. Choose "Load unpacked".
4. Select `packages/extension/dist`.

## Run The MCP Server

Use a stable token so the extension can connect:

```bash
$env:BMA_TOKEN="change-me-local-token"
node packages/mcp-server/dist/index.js
```

The server prints the WebSocket URL and token. Put those values in the extension popup, then click **Connect**.

Example MCP client config:

```json
{
  "mcpServers": {
    "browser-mcp-automaton": {
      "command": "node",
      "args": [
        "C:/Users/nest/Desktop/browser-mcp-automaton/packages/mcp-server/dist/index.js"
      ],
      "env": {
        "BMA_TOKEN": "change-me-local-token"
      }
    }
  }
}
```

## Tools

- `browser_status`: return bridge and extension connection state
- `browser_tabs_list`: list tabs visible to the extension
- `browser_active_tab`: return the active tab
- `browser_screenshot`: capture a visible-tab PNG
- `browser_screenshot_save`: capture a visible-tab PNG and save it to a local file
- `browser_dom_snapshot`: return a compact DOM snapshot
- `browser_page_text`: return visible page text in bounded chunks
- `browser_find_elements`: find visible elements by selector and optional text filter
- `browser_style_structure`: return visible elements, bounding boxes, and selected computed styles
- `browser_computed_styles`: return selected computed CSS properties for a selector
- `browser_click`: click a visible element matching a selector
- `browser_type_text`: type into an input, textarea, or contenteditable element
- `browser_console_start_capture`: start capturing console messages and page errors
- `browser_console_logs`: return captured console messages and page errors
- `browser_console_clear`: clear captured console messages and page errors
- `browser_console_stop_capture`: stop capturing console messages and page errors
- `browser_run_script`: run JavaScript in the page after enabling script execution
- `browser_network_start_capture`: start network metadata capture for a tab
- `browser_network_stop_capture`: stop network metadata capture
- `browser_network_events`: return captured network metadata

## Script Execution Contract

`browser_run_script` receives a function body. The body receives one variable named `args` and should return a serializable value:

```js
return {
  title: document.title,
  href: location.href,
  keys: Object.keys(window).slice(0, args.limit)
};
```

Pass arguments separately:

```json
{
  "script": "return Object.keys(window).slice(0, args.limit);",
  "args": {
    "limit": 100
  }
}
```

Use `browser_page_text`, `browser_find_elements`, `browser_click`, and `browser_type_text` before reaching for custom scripts. They cover common inspection and interaction flows with smaller, easier-to-debug operations.

For React/Vue-style controlled inputs, prefer a two-step interaction:

```text
browser_type_text -> browser_click
```

Some pages do not submit search boxes reliably from synthetic Enter key events alone, so clicking the page's visible submit/search button is usually more robust.

## Console And Error Logs

`browser_console_start_capture` injects a small in-page collector into the target tab. It captures future `console.debug/log/info/warn/error` calls plus `error` and `unhandledrejection` events until stopped or the page navigates.

Fetch recent entries with:

```json
{
  "limit": 100
}
```

## Security Model

This project intentionally treats the browser extension as a high-trust local capability. The extension can access real logged-in pages, so the default posture is conservative:

- Token required before the extension connects to the local server.
- Optional host allowlist in the extension popup.
- Script execution disabled by default.
- Network capture disabled by default.
- Request headers are excluded by default.
- Sensitive URL query parameters and sensitive headers are redacted.
- Browser-internal pages are blocked.

Read [SECURITY.md](SECURITY.md) before using this on personal accounts or production systems.

## Development

```bash
npm run typecheck
npm run build
```

Project layout:

```text
packages/shared      shared protocol constants and types
packages/mcp-server  MCP server and WebSocket bridge
packages/extension   Chrome/Edge MV3 extension
docs                 design notes and roadmap
skills/codex         optional Codex skill users can copy into their skills directory
```

## Optional Codex Skill

The repository includes a small Codex skill at:

```text
skills/codex/browser-mcp-automaton
```

Users can copy that folder into their Codex skills directory so future agents remember when and how to use this MCP bridge.

## License

MIT
