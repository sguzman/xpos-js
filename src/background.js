const EXT_VERSION = chrome.runtime.getManifest().version;

const DEFAULT_CONFIG = Object.freeze({
  endpoint: "ws://127.0.0.1:17373/ws",
  reconnectMs: 2500,
  maxHtmlBytes: 2_000_000,
  maxTextBytes: 500_000,
  includeText: true,
  includeSelection: true,
  includeHtml: true
});

const STORAGE_KEY = "xposeConfig";

let runtimeConfig = { ...DEFAULT_CONFIG };
let socket = null;
let reconnectTimer = null;
let connectionSeq = 0;
let outboundSeq = 0;

function nowIso() {
  return new Date().toISOString();
}

function nextTraceId(label) {
  return `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function log(level, event, details = {}, traceId = "") {
  const entry = {
    ts: nowIso(),
    level,
    event,
    traceId,
    details
  };
  const line = `[xpose][${entry.level}] ${entry.event} trace=${entry.traceId || "none"}`;

  if (level === "error") {
    console.error(line, entry);
  } else if (level === "warn") {
    console.warn(line, entry);
  } else {
    console.log(line, entry);
  }

  if (socket && socket.readyState === WebSocket.OPEN) {
    safeSend({
      type: "log",
      seq: ++outboundSeq,
      payload: entry
    });
  }
}

async function loadConfig() {
  const traceId = nextTraceId("cfg-load");
  try {
    const store = await chrome.storage.local.get(STORAGE_KEY);
    runtimeConfig = { ...DEFAULT_CONFIG, ...(store[STORAGE_KEY] || {}) };
    log("info", "config.loaded", { runtimeConfig }, traceId);
  } catch (error) {
    runtimeConfig = { ...DEFAULT_CONFIG };
    log("error", "config.load_failed", { error: String(error) }, traceId);
  }
}

async function saveConfig(partial) {
  const traceId = nextTraceId("cfg-save");
  runtimeConfig = { ...runtimeConfig, ...partial };
  await chrome.storage.local.set({ [STORAGE_KEY]: runtimeConfig });
  log("info", "config.saved", { runtimeConfig }, traceId);
}

function normalizeUrl(url) {
  try {
    const value = new URL(url);
    if (!value.protocol.startsWith("ws")) {
      throw new Error("Endpoint must use ws:// or wss://");
    }
    return value.toString();
  } catch (error) {
    throw new Error(`Invalid endpoint URL: ${String(error)}`);
  }
}

function trimByBytes(input, maxBytes) {
  const text = String(input || "");
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) {
    return { text, truncated: false, bytes: bytes.length };
  }

  // Fast path to avoid costly slicing loops for very long pages.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const chunkBytes = encoder.encode(text.slice(0, mid)).length;
    if (chunkBytes <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  const trimmed = text.slice(0, low);
  return {
    text: trimmed,
    truncated: true,
    bytes: encoder.encode(trimmed).length
  };
}

function mapWindow(win) {
  return {
    id: win.id,
    focused: win.focused,
    incognito: win.incognito,
    type: win.type,
    state: win.state,
    top: win.top,
    left: win.left,
    width: win.width,
    height: win.height
  };
}

function mapTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title,
    url: tab.url,
    status: tab.status,
    active: tab.active,
    pinned: tab.pinned,
    audible: tab.audible,
    discarded: tab.discarded,
    autoDiscardable: tab.autoDiscardable,
    index: tab.index,
    favIconUrl: tab.favIconUrl,
    lastAccessed: tab.lastAccessed
  };
}

async function listWindows() {
  const windows = await chrome.windows.getAll({ populate: false, windowTypes: ["normal"] });
  return windows.map(mapWindow);
}

async function listTabs(args = {}) {
  const queryInfo = {};
  if (Number.isInteger(args.windowId)) {
    queryInfo.windowId = args.windowId;
  }
  const tabs = await chrome.tabs.query(queryInfo);
  return tabs.map(mapTab);
}

function collectorMain(args) {
  const startedAt = new Date().toISOString();
  const includeHtml = Boolean(args?.includeHtml);
  const includeText = Boolean(args?.includeText);
  const includeSelection = Boolean(args?.includeSelection);

  const html = includeHtml ? document.documentElement.outerHTML : "";
  const text = includeText ? (document.body ? document.body.innerText : "") : "";
  const selection = includeSelection ? String(window.getSelection?.() || "") : "";

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    title: document.title,
    url: location.href,
    lang: document.documentElement.lang || "",
    html,
    text,
    selection,
    readyState: document.readyState
  };
}

async function snapshotTab(args = {}) {
  const tabId = Number(args.tabId);
  if (!Number.isInteger(tabId)) {
    throw new Error("snapshot_tab requires numeric tabId");
  }

  const includeHtml = args.includeHtml ?? runtimeConfig.includeHtml;
  const includeText = args.includeText ?? runtimeConfig.includeText;
  const includeSelection = args.includeSelection ?? runtimeConfig.includeSelection;

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: collectorMain,
    args: [{ includeHtml, includeText, includeSelection }]
  });

  if (!result || !result.result) {
    throw new Error("No snapshot result from executeScript");
  }

  const payload = result.result;
  const html = trimByBytes(payload.html, runtimeConfig.maxHtmlBytes);
  const text = trimByBytes(payload.text, runtimeConfig.maxTextBytes);
  const selection = trimByBytes(payload.selection, runtimeConfig.maxTextBytes);

  return {
    tabId,
    title: payload.title,
    url: payload.url,
    lang: payload.lang,
    readyState: payload.readyState,
    startedAt: payload.startedAt,
    completedAt: payload.completedAt,
    includeHtml,
    includeText,
    includeSelection,
    html: html.text,
    text: text.text,
    selection: selection.text,
    truncation: {
      html: { truncated: html.truncated, bytes: html.bytes, maxBytes: runtimeConfig.maxHtmlBytes },
      text: { truncated: text.truncated, bytes: text.bytes, maxBytes: runtimeConfig.maxTextBytes },
      selection: { truncated: selection.truncated, bytes: selection.bytes, maxBytes: runtimeConfig.maxTextBytes }
    }
  };
}

function safeSend(data) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  socket.send(JSON.stringify(data));
  return true;
}

function sendEvent(name, payload) {
  const traceId = nextTraceId("evt");
  const ok = safeSend({
    type: "event",
    name,
    traceId,
    ts: nowIso(),
    seq: ++outboundSeq,
    payload
  });

  if (!ok) {
    log("warn", "event.drop.socket_not_ready", { name }, traceId);
  }
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSocket();
  }, runtimeConfig.reconnectMs);
}

async function handleCommand(message) {
  const traceId = message.traceId || nextTraceId("cmd");
  const id = message.id || `cmd-${Date.now()}`;
  const command = String(message.command || "");
  const args = message.args || {};
  log("info", "command.received", { id, command, args }, traceId);

  try {
    let result;
    if (command === "ping") {
      result = { pong: true, ts: nowIso(), version: EXT_VERSION };
    } else if (command === "list_tabs") {
      result = { tabs: await listTabs(args) };
    } else if (command === "list_windows") {
      result = { windows: await listWindows() };
    } else if (command === "snapshot_tab") {
      result = await snapshotTab(args);
    } else if (command === "get_state") {
      result = {
        version: EXT_VERSION,
        socketOpen: socket?.readyState === WebSocket.OPEN,
        endpoint: runtimeConfig.endpoint,
        config: runtimeConfig
      };
    } else if (command === "set_config") {
      const next = {};
      if (typeof args.endpoint === "string") {
        next.endpoint = normalizeUrl(args.endpoint);
      }
      if (Number.isInteger(args.reconnectMs) && args.reconnectMs > 99) {
        next.reconnectMs = args.reconnectMs;
      }
      if (Number.isInteger(args.maxHtmlBytes) && args.maxHtmlBytes > 9_999) {
        next.maxHtmlBytes = args.maxHtmlBytes;
      }
      if (Number.isInteger(args.maxTextBytes) && args.maxTextBytes > 1_000) {
        next.maxTextBytes = args.maxTextBytes;
      }
      if (Object.hasOwn(args, "includeHtml")) {
        next.includeHtml = Boolean(args.includeHtml);
      }
      if (Object.hasOwn(args, "includeText")) {
        next.includeText = Boolean(args.includeText);
      }
      if (Object.hasOwn(args, "includeSelection")) {
        next.includeSelection = Boolean(args.includeSelection);
      }

      await saveConfig(next);
      result = { config: runtimeConfig };
      if (next.endpoint || next.reconnectMs) {
        if (socket) {
          socket.close();
        }
      }
    } else {
      throw new Error(`Unknown command: ${command}`);
    }

    safeSend({
      type: "response",
      id,
      traceId,
      ts: nowIso(),
      seq: ++outboundSeq,
      ok: true,
      result
    });
    log("info", "command.ok", { id, command }, traceId);
  } catch (error) {
    safeSend({
      type: "response",
      id,
      traceId,
      ts: nowIso(),
      seq: ++outboundSeq,
      ok: false,
      error: {
        code: "COMMAND_FAILED",
        message: String(error?.message || error)
      }
    });
    log("error", "command.failed", { id, command, error: String(error) }, traceId);
  }
}

async function connectSocket() {
  const traceId = nextTraceId("sock");
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    log("info", "socket.connect.skip_already_active", { readyState: socket.readyState }, traceId);
    return;
  }

  const endpoint = runtimeConfig.endpoint;
  connectionSeq += 1;
  log("info", "socket.connect.start", { endpoint, connectionSeq }, traceId);

  try {
    socket = new WebSocket(endpoint);
  } catch (error) {
    log("error", "socket.connect.throw", { endpoint, error: String(error) }, traceId);
    scheduleReconnect();
    return;
  }

  socket.onopen = async () => {
    log("info", "socket.open", { endpoint }, traceId);
    const [windows, tabs] = await Promise.all([listWindows(), listTabs()]);
    safeSend({
      type: "hello",
      traceId,
      ts: nowIso(),
      seq: ++outboundSeq,
      payload: {
        extension: "xpose",
        version: EXT_VERSION,
        userAgent: navigator.userAgent,
        windows,
        tabs,
        config: runtimeConfig
      }
    });
  };

  socket.onmessage = async (event) => {
    const msgTrace = nextTraceId("sock-msg");
    try {
      const message = JSON.parse(String(event.data || "{}"));
      if (message.type !== "command") {
        log("warn", "socket.message.ignored_unknown_type", { type: message.type }, msgTrace);
        return;
      }
      await handleCommand(message);
    } catch (error) {
      log("error", "socket.message.parse_failed", { error: String(error) }, msgTrace);
    }
  };

  socket.onclose = (event) => {
    log(
      "warn",
      "socket.closed",
      { code: event.code, reason: event.reason, wasClean: event.wasClean, reconnectMs: runtimeConfig.reconnectMs },
      traceId
    );
    socket = null;
    scheduleReconnect();
  };

  socket.onerror = (event) => {
    log("error", "socket.error", { eventType: event.type }, traceId);
  };
}

function registerEventBridge() {
  chrome.tabs.onCreated.addListener((tab) => sendEvent("tab.created", mapTab(tab)));
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) =>
    sendEvent("tab.updated", { tabId, changeInfo, tab: mapTab(tab) })
  );
  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => sendEvent("tab.removed", { tabId, removeInfo }));
  chrome.tabs.onMoved.addListener((tabId, moveInfo) => sendEvent("tab.moved", { tabId, moveInfo }));
  chrome.tabs.onActivated.addListener((activeInfo) => sendEvent("tab.activated", activeInfo));
  chrome.tabs.onDetached.addListener((tabId, detachInfo) => sendEvent("tab.detached", { tabId, detachInfo }));
  chrome.tabs.onAttached.addListener((tabId, attachInfo) => sendEvent("tab.attached", { tabId, attachInfo }));
  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) =>
    sendEvent("tab.replaced", { addedTabId, removedTabId })
  );

  chrome.windows.onCreated.addListener((window) => sendEvent("window.created", mapWindow(window)));
  chrome.windows.onRemoved.addListener((windowId) => sendEvent("window.removed", { windowId }));
  chrome.windows.onFocusChanged.addListener((windowId) => sendEvent("window.focus_changed", { windowId }));
}

async function bootstrap() {
  const traceId = nextTraceId("boot");
  log("info", "bootstrap.start", { version: EXT_VERSION }, traceId);
  await loadConfig();
  registerEventBridge();
  await connectSocket();
  log("info", "bootstrap.ready", {}, traceId);
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const traceId = nextTraceId("lifecycle");
  log("info", "runtime.installed", details, traceId);
  await loadConfig();
  await saveConfig(runtimeConfig);
});

chrome.runtime.onStartup.addListener(() => {
  const traceId = nextTraceId("lifecycle");
  log("info", "runtime.startup", {}, traceId);
  void bootstrap();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const traceId = nextTraceId("msg");

  if (message?.type === "get_config") {
    sendResponse({ ok: true, config: runtimeConfig });
    return;
  }

  if (message?.type === "set_config") {
    (async () => {
      try {
        const next = {
          endpoint: normalizeUrl(message.config.endpoint),
          reconnectMs: Number(message.config.reconnectMs),
          maxHtmlBytes: Number(message.config.maxHtmlBytes),
          maxTextBytes: Number(message.config.maxTextBytes),
          includeHtml: Boolean(message.config.includeHtml),
          includeText: Boolean(message.config.includeText),
          includeSelection: Boolean(message.config.includeSelection)
        };

        await saveConfig(next);
        if (socket) {
          socket.close();
        }
        sendResponse({ ok: true, config: runtimeConfig });
      } catch (error) {
        log("error", "msg.set_config.failed", { error: String(error) }, traceId);
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
    return true;
  }

  sendResponse({ ok: false, error: "Unknown message" });
  return false;
});

void bootstrap();
