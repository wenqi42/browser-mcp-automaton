# Architecture

## Components

```text
MCP client
  |
  | stdio MCP
  v
Node MCP server
  |
  | localhost WebSocket + token
  v
Chrome/Edge extension background service worker
  |
  | chrome.tabs / chrome.scripting / chrome.webRequest
  v
User's real browser tabs
```

## Why An Extension

An extension can work with the user's existing browser state: logged-in tabs, current page state, browser settings, and extension environment. This is different from Playwright or an in-app browser, which usually creates an isolated browser context.

## Why A Local WebSocket

MCP clients usually speak stdio or HTTP to a local server. Browser extensions cannot be launched directly by MCP, so the local server owns MCP and the extension connects out to it over `ws://127.0.0.1`.

## Capability Tiers

Read tier:

- List tabs
- Read active tab metadata
- Capture screenshot
- Read DOM structure
- Read selected computed styles
- Return captured network events

High-trust tier:

- Run page JavaScript
- Start network capture
- Include request headers

High-trust methods are disabled by default in the extension popup.

## Network Capture

The MV3 extension path can observe request lifecycle metadata through `chrome.webRequest`. It does not capture response bodies. For full request/response body inspection, a future mode could integrate Chrome DevTools Protocol with an explicit debugging-session consent flow.
