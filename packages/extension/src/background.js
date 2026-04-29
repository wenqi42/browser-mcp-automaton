const DEFAULT_SETTINGS = {
  serverUrl: "ws://127.0.0.1:17361/extension",
  token: "",
  allowScriptExecution: false,
  allowNetworkCapture: false,
  includeRequestHeaders: false,
  allowedHosts: []
};

let socket = null;
let connectTimer = null;
let reconnectAttempts = 0;
let shouldReconnect = false;
let connectionGeneration = 0;
let settings = { ...DEFAULT_SETTINGS };
const captureTabs = new Map();
const networkEvents = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(DEFAULT_SETTINGS);
  await chrome.storage.local.set({ ...DEFAULT_SETTINGS, ...existing });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  for (const [key, change] of Object.entries(changes)) {
    settings[key] = change.newValue;
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleRuntimeMessage(message).then(sendResponse);
  return true;
});

async function handleRuntimeMessage(message) {
  if (message?.type === "settings.get") {
    settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(DEFAULT_SETTINGS)) };
    return { ok: true, settings, connected: socket?.readyState === WebSocket.OPEN };
  }

  if (message?.type === "settings.save") {
    const next = sanitizeSettings(message.settings ?? {});
    await chrome.storage.local.set(next);
    settings = { ...settings, ...next };
    return { ok: true, settings };
  }

  if (message?.type === "bridge.connect") {
    await loadSettings();
    connect();
    return { ok: true };
  }

  if (message?.type === "bridge.disconnect") {
    disconnect();
    return { ok: true };
  }

  return { ok: false, error: "Unknown runtime message" };
}

function sanitizeSettings(value) {
  return {
    serverUrl: String(value.serverUrl || DEFAULT_SETTINGS.serverUrl),
    token: String(value.token || ""),
    allowScriptExecution: Boolean(value.allowScriptExecution),
    allowNetworkCapture: Boolean(value.allowNetworkCapture),
    includeRequestHeaders: Boolean(value.includeRequestHeaders),
    allowedHosts: Array.isArray(value.allowedHosts)
      ? value.allowedHosts.map((host) => String(host).trim()).filter(Boolean)
      : String(value.allowedHosts || "")
          .split(/\r?\n|,/u)
          .map((host) => host.trim())
          .filter(Boolean)
  };
}

async function loadSettings() {
  settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(DEFAULT_SETTINGS)) };
}

function connect() {
  disconnect(false);
  if (!settings.token) {
    console.warn("[Browser MCP Automaton] Refusing to connect without a token.");
    return;
  }

  shouldReconnect = true;
  const generation = ++connectionGeneration;
  socket = new WebSocket(settings.serverUrl);

  socket.addEventListener("open", () => {
    reconnectAttempts = 0;
    socket.send(
      JSON.stringify({
        type: "hello",
        token: settings.token,
        protocolVersion: "0.1",
        extensionVersion: chrome.runtime.getManifest().version
      })
    );
  });

  socket.addEventListener("message", (event) => {
    void handleSocketMessage(event.data);
  });

  socket.addEventListener("close", () => {
    if (generation !== connectionGeneration) return;
    socket = null;
    if (shouldReconnect) scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    socket?.close();
  });
}

function disconnect(clearReconnect = true) {
  shouldReconnect = false;
  connectionGeneration += 1;
  if (clearReconnect && connectTimer) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }
  socket?.close();
  socket = null;
}

function scheduleReconnect() {
  if (!settings.token || connectTimer) return;
  const delay = Math.min(30_000, 1000 * 2 ** reconnectAttempts);
  reconnectAttempts += 1;
  connectTimer = setTimeout(() => {
    connectTimer = null;
    connect();
  }, delay);
}

async function handleSocketMessage(raw) {
  let message;
  try {
    message = JSON.parse(String(raw));
  } catch {
    disconnect();
    return;
  }
  if (message.type !== "request") return;

  try {
    const result = await dispatch(message.method, message.params ?? {});
    sendResponse({ id: message.id, type: "response", ok: true, result });
  } catch (error) {
    sendResponse({
      id: message.id,
      type: "response",
      ok: false,
      error: {
        code: error?.code || "EXTENSION_ERROR",
        message: error?.message || String(error)
      }
    });
  }
}

function sendResponse(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

async function dispatch(method, params) {
  switch (method) {
    case "tabs.list":
      return await tabsList();
    case "tabs.active":
      return await activeTab();
    case "page.screenshot":
      return await screenshot(params);
    case "page.domSnapshot":
      return await executeInTab(params.tabId, collectDomSnapshot, [params.maxNodes ?? 1000]);
    case "page.styleStructure":
      return await executeInTab(params.tabId, collectStyleStructure, [
        params.maxNodes ?? 500,
        params.properties ?? DEFAULT_STYLE_PROPERTIES
      ]);
    case "page.computedStyles":
      return await executeInTab(params.tabId, collectComputedStyles, [
        params.selector,
        params.properties
      ]);
    case "page.runScript":
      return await runScript(params);
    case "page.click":
      return await clickElement(params);
    case "page.typeText":
      return await typeText(params);
    case "page.console.startCapture":
      return await consoleStartCapture(params);
    case "page.console.stopCapture":
      return await consoleStopCapture(params);
    case "page.console.getLogs":
      return await consoleGetLogs(params);
    case "page.console.clearLogs":
      return await consoleClearLogs(params);
    case "network.startCapture":
      return startNetworkCapture(params);
    case "network.stopCapture":
      return stopNetworkCapture(params);
    case "network.getEvents":
      return getNetworkEvents(params);
    default:
      throw new Error(`Unknown RPC method: ${method}`);
  }
}

async function tabsList() {
  const tabs = await chrome.tabs.query({});
  return tabs.map(toTabInfo);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? toTabInfo(tab) : null;
}

function toTabInfo(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title,
    url: redactUrl(tab.url),
    active: tab.active,
    pinned: tab.pinned,
    audible: tab.audible
  };
}

async function getTargetTab(tabId) {
  if (tabId) return await chrome.tabs.get(tabId);
  const tab = await activeTab();
  if (!tab?.id) throw new Error("No active tab is available.");
  return await chrome.tabs.get(tab.id);
}

async function screenshot(params) {
  const tab = await getTargetTab(params.tabId);
  await assertHostAllowed(tab.url, "screenshot");
  await chrome.tabs.update(tab.id, { active: true });
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  return { tab: toTabInfo(tab), dataUrl };
}

async function executeInTab(tabId, func, args = [], world = "MAIN") {
  const tab = await getTargetTab(tabId);
  await assertHostAllowed(tab.url, "read page content");
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world,
    func,
    args
  });
  return result?.result;
}

async function consoleStartCapture(params) {
  const tab = await getTargetTab(params.tabId);
  await assertHostAllowed(tab.url, "capture console logs");
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: installConsoleCapture
  });
  return {
    tab: toTabInfo(tab),
    capturing: Boolean(result?.result?.capturing),
    installed: Boolean(result?.result?.installed),
    count: Number(result?.result?.count ?? 0)
  };
}

async function consoleStopCapture(params) {
  const tab = await getTargetTab(params.tabId);
  await assertHostAllowed(tab.url, "capture console logs");
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: stopConsoleCapture
  });
  return {
    tab: toTabInfo(tab),
    capturing: Boolean(result?.result?.capturing),
    count: Number(result?.result?.count ?? 0)
  };
}

async function consoleGetLogs(params) {
  const tab = await getTargetTab(params.tabId);
  await assertHostAllowed(tab.url, "read console logs");
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: getConsoleLogs,
    args: [Number(params.limit ?? 200)]
  });
  return {
    tab: toTabInfo(tab),
    capturing: Boolean(result?.result?.capturing),
    count: Number(result?.result?.count ?? 0),
    logs: result?.result?.logs ?? []
  };
}

async function consoleClearLogs(params) {
  const tab = await getTargetTab(params.tabId);
  await assertHostAllowed(tab.url, "clear console logs");
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: clearConsoleLogs
  });
  return {
    tab: toTabInfo(tab),
    capturing: Boolean(result?.result?.capturing),
    count: Number(result?.result?.count ?? 0)
  };
}

async function runScript(params) {
  if (!settings.allowScriptExecution) {
    throw new Error("Script execution is disabled in the extension popup.");
  }

  const tab = await getTargetTab(params.tabId);
  await assertHostAllowed(tab.url, "run script");

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: params.world || "MAIN",
    func: (script, args) => {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const fn = new AsyncFunction("args", `"use strict";\n${script}`);
      return fn(args);
    },
    args: [String(params.script), params.args ?? null]
  });

  return {
    tab: toTabInfo(tab),
    result: result?.result
  };
}

async function clickElement(params) {
  const tab = await getTargetTab(params.tabId);
  await assertHostAllowed(tab.url, "click element");
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: (selector, index) => {
      const visibleText = (element) => {
        const text = element.innerText || element.textContent || "";
        return text.replace(/\s+/gu, " ").trim().slice(0, 240) || undefined;
      };
      const roundRect = (rect) => ({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      });
      const elements = [...document.querySelectorAll(selector)].filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= innerHeight;
      });
      const element = elements[index];
      if (!element) return { clicked: false, reason: "No visible element matched selector", matchCount: elements.length };
      const rect = element.getBoundingClientRect();
      element.scrollIntoView({ block: "center", inline: "center" });
      element.focus?.();
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
      element.click();
      return {
        clicked: true,
        element: {
          tag: element.tagName.toLowerCase(),
          text: visibleText(element),
          rect: roundRect(rect)
        }
      };
    },
    args: [String(params.selector), Number(params.index ?? 0)]
  });
  return {
    tab: toTabInfo(tab),
    result: result?.result
  };
}

async function typeText(params) {
  const tab = await getTargetTab(params.tabId);
  await assertHostAllowed(tab.url, "type text");
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: (selector, text, index, clear, pressEnter) => {
      const roundRect = (rect) => ({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      });
      const elements = [...document.querySelectorAll(selector)].filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= innerHeight;
      });
      const element = elements[index];
      if (!element) return { typed: false, reason: "No visible element matched selector", matchCount: elements.length };

      element.scrollIntoView({ block: "center", inline: "center" });
      element.focus?.();

      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        const descriptor =
          Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value") ??
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        const currentValue = clear ? "" : element.value;
        descriptor?.set?.call(element, currentValue);
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
        descriptor?.set?.call(element, `${currentValue}${text}`);
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (element.isContentEditable) {
        if (clear) element.textContent = "";
        document.execCommand("insertText", false, text);
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      } else {
        return { typed: false, reason: "Matched element is not editable", tag: element.tagName.toLowerCase() };
      }

      if (pressEnter) {
        element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
        element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter" }));
      }

      return {
        typed: true,
        value: "value" in element ? element.value : element.textContent,
        tag: element.tagName.toLowerCase(),
        rect: roundRect(element.getBoundingClientRect())
      };
    },
    args: [
      String(params.selector),
      String(params.text ?? ""),
      Number(params.index ?? 0),
      Boolean(params.clear ?? true),
      Boolean(params.pressEnter ?? false)
    ]
  });
  return {
    tab: toTabInfo(tab),
    result: result?.result
  };
}

function startNetworkCapture(params) {
  if (!settings.allowNetworkCapture) {
    throw new Error("Network capture is disabled in the extension popup.");
  }
  const tabId = Number(params.tabId);
  captureTabs.set(tabId, {
    includeHeaders: Boolean(params.includeHeaders && settings.includeRequestHeaders)
  });
  if (!networkEvents.has(tabId)) networkEvents.set(tabId, []);
  return { tabId, capturing: true };
}

function stopNetworkCapture(params) {
  const tabId = Number(params.tabId);
  captureTabs.delete(tabId);
  return { tabId, capturing: false };
}

function getNetworkEvents(params) {
  const tabId = Number(params.tabId);
  const limit = Number(params.limit ?? 200);
  return {
    tabId,
    events: (networkEvents.get(tabId) ?? []).slice(-limit)
  };
}

function pushNetworkEvent(event) {
  if (!captureTabs.has(event.tabId)) return;
  const events = networkEvents.get(event.tabId) ?? [];
  events.push(event);
  while (events.length > 2000) events.shift();
  networkEvents.set(event.tabId, events);
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    pushNetworkEvent({
      id: crypto.randomUUID(),
      tabId: details.tabId,
      type: "beforeRequest",
      url: redactUrl(details.url),
      method: details.method,
      requestId: details.requestId,
      timestamp: details.timeStamp
    });
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const capture = captureTabs.get(details.tabId);
    if (!capture?.includeHeaders) return;
    pushNetworkEvent({
      id: crypto.randomUUID(),
      tabId: details.tabId,
      type: "beforeSendHeaders",
      url: redactUrl(details.url),
      method: details.method,
      requestId: details.requestId,
      timestamp: details.timeStamp,
      requestHeaders: sanitizeHeaders(details.requestHeaders ?? [])
    });
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    pushNetworkEvent({
      id: crypto.randomUUID(),
      tabId: details.tabId,
      type: "completed",
      url: redactUrl(details.url),
      method: details.method,
      requestId: details.requestId,
      timestamp: details.timeStamp,
      statusCode: details.statusCode
    });
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (details.tabId < 0) return;
    pushNetworkEvent({
      id: crypto.randomUUID(),
      tabId: details.tabId,
      type: "error",
      url: redactUrl(details.url),
      method: details.method,
      requestId: details.requestId,
      timestamp: details.timeStamp,
      error: details.error
    });
  },
  { urls: ["<all_urls>"] }
);

async function assertHostAllowed(url, action) {
  if (!url) return;
  const parsed = new URL(url);
  if (["chrome:", "edge:", "chrome-extension:", "devtools:"].includes(parsed.protocol)) {
    throw new Error(`Cannot ${action} on browser-internal pages.`);
  }
  if (!settings.allowedHosts.length) return;
  if (!settings.allowedHosts.some((host) => host === parsed.hostname || parsed.hostname.endsWith(`.${host}`))) {
    throw new Error(`Host ${parsed.hostname} is not in the extension allowlist.`);
  }
}

function redactUrl(url) {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|key|secret|code|auth|password|session/i.test(key)) {
        parsed.searchParams.set(key, "[redacted]");
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function sanitizeHeaders(headers) {
  return headers.map((header) => {
    if (/authorization|cookie|set-cookie|x-api-key/i.test(header.name)) {
      return { name: header.name, value: "[redacted]" };
    }
    return { name: header.name, value: header.value };
  });
}

const DEFAULT_STYLE_PROPERTIES = [
  "display",
  "position",
  "boxSizing",
  "width",
  "height",
  "margin",
  "padding",
  "color",
  "backgroundColor",
  "font",
  "zIndex",
  "overflow"
];

function collectDomSnapshot(maxNodes) {
  const result = [];
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
  let node = walker.currentNode;

  while (node && result.length < maxNodes) {
    const element = node;
    const rect = element.getBoundingClientRect();
    result.push({
      tag: element.tagName.toLowerCase(),
      id: element.id || undefined,
      className: typeof element.className === "string" ? element.className || undefined : undefined,
      role: element.getAttribute("role") || undefined,
      ariaLabel: element.getAttribute("aria-label") || undefined,
      name: element.getAttribute("name") || undefined,
      href: element instanceof HTMLAnchorElement ? element.href : undefined,
      text: visibleText(element),
      rect: rect.width || rect.height ? roundRect(rect) : undefined
    });
    node = walker.nextNode();
  }

  return {
    title: document.title,
    url: location.href,
    count: result.length,
    nodes: result
  };
}

function collectStyleStructure(maxNodes, properties) {
  const elements = [...document.querySelectorAll("body *")];
  const nodes = [];

  for (const element of elements) {
    if (nodes.length >= maxNodes) break;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;

    const computed = getComputedStyle(element);
    const styles = {};
    for (const property of properties) {
      styles[property] = computed[property] || computed.getPropertyValue(property);
    }

    nodes.push({
      selector: selectorFor(element),
      tag: element.tagName.toLowerCase(),
      text: visibleText(element),
      rect: roundRect(rect),
      styles
    });
  }

  return {
    title: document.title,
    url: location.href,
    count: nodes.length,
    nodes
  };
}

function collectComputedStyles(selector, properties) {
  const elements = [...document.querySelectorAll(selector)].slice(0, 50);
  return {
    selector,
    count: elements.length,
    elements: elements.map((element) => {
      const computed = getComputedStyle(element);
      const styles = {};
      for (const property of properties) {
        styles[property] = computed[property] || computed.getPropertyValue(property);
      }
      return {
        selector: selectorFor(element),
        tag: element.tagName.toLowerCase(),
        text: visibleText(element),
        rect: roundRect(element.getBoundingClientRect()),
        styles
      };
    })
  };
}

function visibleText(element) {
  const text = element.innerText || element.textContent || "";
  return text.replace(/\s+/gu, " ").trim().slice(0, 240) || undefined;
}

function roundRect(rect) {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

function selectorFor(element) {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const parts = [];
  let cursor = element;
  while (cursor && cursor.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
    let part = cursor.tagName.toLowerCase();
    if (cursor.classList.length) {
      part += `.${[...cursor.classList].slice(0, 3).map((item) => CSS.escape(item)).join(".")}`;
    }
    const parent = cursor.parentElement;
    if (parent) {
      const siblings = [...parent.children].filter((child) => child.tagName === cursor.tagName);
      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(cursor) + 1})`;
      }
    }
    parts.unshift(part);
    cursor = parent;
  }
  return parts.join(" > ");
}

function installConsoleCapture() {
  const key = "__browserMcpAutomatonConsole";
  const maxEntries = 2000;
  const existing = window[key];
  if (existing?.installed) {
    existing.capturing = true;
    return { installed: false, capturing: true, count: existing.logs.length };
  }

  const originalConsole = {};
  const state = {
    installed: true,
    capturing: true,
    logs: [],
    originalConsole,
    onError: null,
    onUnhandledRejection: null
  };

  const serializeValue = (value, depth = 0) => {
    if (depth > 2) return "[MaxDepth]";
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack
      };
    }
    if (value === null || typeof value !== "object") {
      if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
      if (typeof value === "undefined") return "[undefined]";
      return value;
    }
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => serializeValue(item, depth + 1));
    const output = {};
    for (const [entryKey, entryValue] of Object.entries(value).slice(0, 30)) {
      output[entryKey] = serializeValue(entryValue, depth + 1);
    }
    return output;
  };

  const push = (entry) => {
    if (!state.capturing) return;
    state.logs.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: Date.now(),
      url: location.href,
      ...entry
    });
    while (state.logs.length > maxEntries) state.logs.shift();
  };

  for (const level of ["debug", "log", "info", "warn", "error"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => {
      push({
        source: "console",
        level,
        args: args.map((arg) => serializeValue(arg)),
        text: args
          .map((arg) => {
            if (typeof arg === "string") return arg;
            try {
              return JSON.stringify(serializeValue(arg));
            } catch {
              return String(arg);
            }
          })
          .join(" ")
      });
      return originalConsole[level].apply(console, args);
    };
  }

  state.onError = (event) => {
    push({
      source: "error",
      level: "error",
      text: event.message,
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
      error: serializeValue(event.error)
    });
  };

  state.onUnhandledRejection = (event) => {
    push({
      source: "unhandledrejection",
      level: "error",
      text: "Unhandled promise rejection",
      reason: serializeValue(event.reason)
    });
  };

  window.addEventListener("error", state.onError);
  window.addEventListener("unhandledrejection", state.onUnhandledRejection);
  window[key] = state;
  return { installed: true, capturing: true, count: 0 };
}

function stopConsoleCapture() {
  const state = window.__browserMcpAutomatonConsole;
  if (!state?.installed) return { capturing: false, count: 0 };
  state.capturing = false;
  return { capturing: false, count: state.logs.length };
}

function getConsoleLogs(limit) {
  const state = window.__browserMcpAutomatonConsole;
  if (!state?.installed) return { capturing: false, count: 0, logs: [] };
  const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 1000));
  return {
    capturing: Boolean(state.capturing),
    count: state.logs.length,
    logs: state.logs.slice(-safeLimit)
  };
}

function clearConsoleLogs() {
  const state = window.__browserMcpAutomatonConsole;
  if (!state?.installed) return { capturing: false, count: 0 };
  state.logs.length = 0;
  return { capturing: Boolean(state.capturing), count: 0 };
}
