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
const CONNECTION_ALARM_NAME = "xpose-connection-heartbeat";
const CONNECTION_ALARM_MINUTES = 1;
const SOCKET_KEEPALIVE_MS = 20_000;
const DEBUGGER_PROTOCOL_VERSION = "1.3";
const IMPORT_BUNDLE_DEFAULTS = Object.freeze({
  reload: true,
  captureHtml: true,
  captureAssets: true,
  captureText: true,
  captureSelection: true,
  captureScreenshot: false,
  waitForNetworkIdleMs: 1500,
  settleTimeoutMs: 30_000,
  maxAssetBytes: 5_000_000,
  maxTotalBytes: 75_000_000
});
const SNAPSHOT_META_TIMEOUT_MS = 1200;
const SNAPSHOT_HTML_TIMEOUT_MS = 4500;
const SNAPSHOT_TEXT_TIMEOUT_MS = 4500;
const SNAPSHOT_RETRY_META_TIMEOUT_MS = 1800;
const SNAPSHOT_RETRY_HTML_TIMEOUT_MS = 6000;
const SNAPSHOT_RETRY_TEXT_TIMEOUT_MS = 6000;
const SNAPSHOT_WAKE_DELAY_MS = 250;
const TAB_READY_TIMEOUT_MS = 2000;
const TAB_WAKE_READY_TIMEOUT_MS = 4000;

let runtimeConfig = { ...DEFAULT_CONFIG };
let socket = null;
let reconnectTimer = null;
let connectionSeq = 0;
let outboundSeq = 0;
let eventsRegistered = false;
let bootstrapInFlight = null;
let keepaliveTimer = null;
let debuggerListenersRegistered = false;
let importAssetSequence = 0;

const importSessions = new Map();
const importSessionsByTabId = new Map();

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

function pickArg(args, camelKey, snakeKey) {
  if (Object.hasOwn(args, camelKey)) {
    return args[camelKey];
  }
  if (Object.hasOwn(args, snakeKey)) {
    return args[snakeKey];
  }
  return undefined;
}

function hasArg(args, camelKey, snakeKey) {
  return Object.hasOwn(args, camelKey) || Object.hasOwn(args, snakeKey);
}

function createImportJobId() {
  return `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function createAssetId() {
  importAssetSequence += 1;
  return `asset_${importAssetSequence.toString(36)}_${Date.now().toString(36)}`;
}

function hashText(input) {
  let hash = 2166136261;
  const text = String(input || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function getImportAssetKey(request) {
  return [
    request.url || "",
    request.documentURL || "",
    request.resourceType || "Other",
    request.frameId || ""
  ].join("|");
}

function createDeterministicAssetId(request) {
  const ordinal = Number(request.assetOrdinal || 1);
  return `asset_${hashText(getImportAssetKey(request))}_${ordinal.toString(36)}`;
}

function normalizeImportOptions(args = {}) {
  const waitForNetworkIdleMs = Number(pickArg(args, "waitForNetworkIdleMs", "wait_for_network_idle_ms"));
  const settleTimeoutMs = Number(pickArg(args, "settleTimeoutMs", "settle_timeout_ms"));
  const maxAssetBytes = Number(pickArg(args, "maxAssetBytes", "max_asset_bytes"));
  const maxTotalBytes = Number(pickArg(args, "maxTotalBytes", "max_total_bytes"));

  return {
    reload: hasArg(args, "reload", "reload") ? Boolean(pickArg(args, "reload", "reload")) : IMPORT_BUNDLE_DEFAULTS.reload,
    captureHtml: hasArg(args, "captureHtml", "capture_html")
      ? Boolean(pickArg(args, "captureHtml", "capture_html"))
      : IMPORT_BUNDLE_DEFAULTS.captureHtml,
    captureAssets: hasArg(args, "captureAssets", "capture_assets")
      ? Boolean(pickArg(args, "captureAssets", "capture_assets"))
      : IMPORT_BUNDLE_DEFAULTS.captureAssets,
    captureText: hasArg(args, "captureText", "capture_text")
      ? Boolean(pickArg(args, "captureText", "capture_text"))
      : IMPORT_BUNDLE_DEFAULTS.captureText,
    captureSelection: hasArg(args, "captureSelection", "capture_selection")
      ? Boolean(pickArg(args, "captureSelection", "capture_selection"))
      : IMPORT_BUNDLE_DEFAULTS.captureSelection,
    captureScreenshot: hasArg(args, "captureScreenshot", "capture_screenshot")
      ? Boolean(pickArg(args, "captureScreenshot", "capture_screenshot"))
      : IMPORT_BUNDLE_DEFAULTS.captureScreenshot,
    waitForNetworkIdleMs:
      Number.isInteger(waitForNetworkIdleMs) && waitForNetworkIdleMs >= 250
        ? waitForNetworkIdleMs
        : IMPORT_BUNDLE_DEFAULTS.waitForNetworkIdleMs,
    settleTimeoutMs:
      Number.isInteger(settleTimeoutMs) && settleTimeoutMs >= 5_000
        ? settleTimeoutMs
        : IMPORT_BUNDLE_DEFAULTS.settleTimeoutMs,
    maxAssetBytes:
      Number.isInteger(maxAssetBytes) && maxAssetBytes >= 10_000
        ? maxAssetBytes
        : IMPORT_BUNDLE_DEFAULTS.maxAssetBytes,
    maxTotalBytes:
      Number.isInteger(maxTotalBytes) && maxTotalBytes >= 100_000
        ? maxTotalBytes
        : IMPORT_BUNDLE_DEFAULTS.maxTotalBytes
  };
}

function makeImportSession(tabId, options) {
  return {
    jobId: createImportJobId(),
    tabId,
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    completedAt: null,
    error: null,
    options,
    attached: false,
    loadEventFiredAt: null,
    lastNetworkActivityAt: Date.now(),
    inflightRequests: new Set(),
    requests: new Map(),
    assetsById: new Map(),
    requestToAssetId: new Map(),
    assetKeyCounts: new Map(),
    totalAssetBytes: 0,
    finalSnapshot: null,
    screenshot: null,
    wake: { previousActiveTabId: undefined, didSwitch: false },
    detachedReason: null
  };
}

function summarizeImportSession(session) {
  return {
    jobId: session.jobId,
    tabId: session.tabId,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    error: session.error,
    options: session.options,
    capture: {
      attached: session.attached,
      loadEventFiredAt: session.loadEventFiredAt ? new Date(session.loadEventFiredAt).toISOString() : null,
      detachedReason: session.detachedReason
    },
    stats: {
      requestsObserved: session.requests.size,
      inflightRequests: session.inflightRequests.size,
      assetsCaptured: session.assetsById.size,
      totalAssetBytes: session.totalAssetBytes
    }
  };
}

function serializeAsset(asset) {
  return {
    assetId: asset.assetId,
    requestId: asset.requestId,
    url: asset.url,
    documentURL: asset.documentURL,
    resourceType: asset.resourceType,
    mimeType: asset.mimeType,
    status: asset.status,
    assetOrdinal: asset.assetOrdinal,
    servedFromCache: asset.servedFromCache,
    fromDiskCache: asset.fromDiskCache,
    fromServiceWorker: asset.fromServiceWorker,
    base64Encoded: asset.base64Encoded,
    bytes: asset.bytes,
    headers: asset.headers,
    bodyAvailable: typeof asset.body === "string",
    error: asset.error
  };
}

async function withTimeout(promise, ms, label) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function waitForTabComplete(tabId, timeoutMs) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") {
    return tab;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      try {
        const latest = await chrome.tabs.get(tabId);
        resolve(latest);
      } catch (error) {
        reject(error);
      }
    }, timeoutMs);

    async function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId) {
        return;
      }
      if (changeInfo.status !== "complete") {
        return;
      }
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      try {
        const latest = await chrome.tabs.get(tabId);
        resolve(latest);
      } catch (error) {
        reject(error);
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isHostPermissionError(error) {
  const message = String(error?.message || error || "");
  return message.includes("Cannot access contents of the page");
}

function getCommandErrorCode(error) {
  if (isHostPermissionError(error)) {
    return "HOST_PERMISSION_DENIED";
  }

  const message = String(error?.message || error || "");
  if (message.includes("Unsupported tab URL")) {
    return "UNSUPPORTED_TAB_URL";
  }
  if (message.includes("timed out")) {
    return "SNAPSHOT_TIMEOUT";
  }

  return "COMMAND_FAILED";
}

function getImportErrorCode(error) {
  if (isHostPermissionError(error)) {
    return "HOST_PERMISSION_DENIED";
  }

  const message = String(error?.message || error || "");
  if (message.includes("Unsupported tab URL")) {
    return "UNSUPPORTED_TAB_URL";
  }
  if (message.includes("already attached") || message.includes("Cannot attach")) {
    return "IMPORT_BUNDLE_ATTACH_FAILED";
  }
  if (message.includes("waiting for network idle") || message.includes("timed out")) {
    return "IMPORT_BUNDLE_TIMEOUT";
  }
  if (message.includes("cancelled")) {
    return "IMPORT_BUNDLE_CANCELLED";
  }
  if (message.includes("reload")) {
    return "IMPORT_BUNDLE_RELOAD_FAILED";
  }
  return "COMMAND_FAILED";
}

async function hasHostPermissionForUrl(url) {
  if (!/^https?:/i.test(url)) {
    return false;
  }

  const parsed = new URL(url);
  return chrome.permissions.contains({
    origins: [`${parsed.origin}/*`]
  });
}

async function wakeTabForSnapshot(tab) {
  const windowId = tab.windowId;
  const activeTabs = await chrome.tabs.query({ active: true, windowId });
  const previousActiveTab = activeTabs[0];
  const shouldSwitch = previousActiveTab && previousActiveTab.id !== tab.id;

  if (shouldSwitch) {
    await chrome.tabs.update(tab.id, { active: true });
    await sleep(SNAPSHOT_WAKE_DELAY_MS);
  }

  return { previousActiveTabId: previousActiveTab?.id, didSwitch: Boolean(shouldSwitch) };
}

async function restorePreviouslyActiveTab(windowId, previousActiveTabId, didSwitch) {
  if (!didSwitch || !Number.isInteger(previousActiveTabId)) {
    return;
  }

  try {
    await chrome.tabs.update(previousActiveTabId, { active: true });
  } catch (error) {
    log("warn", "snapshot.restore_previous_tab.failed", { previousActiveTabId, windowId, error: String(error) });
  }
}

async function prepareTabForSnapshot(tab) {
  let currentTab = tab;
  let wake = { previousActiveTabId: undefined, didSwitch: false };

  if (tab.discarded || tab.status !== "complete" || !tab.active) {
    wake = await wakeTabForSnapshot(tab);
    currentTab = await chrome.tabs.get(tab.id);
  }

  if (currentTab.discarded) {
    log("info", "snapshot.tab.discarded_reload", { tabId: tab.id, url: currentTab.url || "" });
    await chrome.tabs.reload(tab.id);
    currentTab = await waitForTabComplete(tab.id, TAB_WAKE_READY_TIMEOUT_MS);
  } else if (currentTab.status !== "complete") {
    currentTab = await waitForTabComplete(tab.id, TAB_READY_TIMEOUT_MS);
  }

  return { tab: currentTab, wake };
}

async function reloadTabForSnapshot(tabId) {
  await chrome.tabs.reload(tabId);
  return waitForTabComplete(tabId, TAB_WAKE_READY_TIMEOUT_MS);
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

function mapTabGroup(group) {
  return {
    id: group.id,
    windowId: group.windowId,
    collapsed: group.collapsed,
    color: group.color,
    title: group.title
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
    highlighted: tab.highlighted,
    discarded: tab.discarded,
    autoDiscardable: tab.autoDiscardable,
    index: tab.index,
    groupId: tab.groupId,
    mutedInfo: tab.mutedInfo,
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
  const windowId = Number(pickArg(args, "windowId", "window_id"));
  if (Number.isInteger(windowId)) {
    queryInfo.windowId = windowId;
  }
  const tabs = await chrome.tabs.query(queryInfo);
  return tabs.map(mapTab);
}

async function getTabState(args = {}) {
  const tabId = Number(pickArg(args, "tabId", "tab_id"));
  if (!Number.isInteger(tabId)) {
    throw new Error("get_tab_state requires numeric tabId");
  }

  const tab = await chrome.tabs.get(tabId);
  return { tab: mapTab(tab) };
}

async function getActiveTab(args = {}) {
  const queryInfo = { active: true };
  const windowId = Number(pickArg(args, "windowId", "window_id"));

  if (Number.isInteger(windowId)) {
    queryInfo.windowId = windowId;
  } else {
    queryInfo.lastFocusedWindow = true;
  }

  const [tab] = await chrome.tabs.query(queryInfo);
  if (!tab) {
    throw new Error("No active tab found");
  }

  return { tab: mapTab(tab) };
}

async function openTab(args = {}) {
  const url = String(pickArg(args, "url", "url") || "").trim();
  if (!url) {
    throw new Error("open_tab requires url");
  }

  const createProperties = {
    url,
    active: hasArg(args, "active", "active") ? Boolean(pickArg(args, "active", "active")) : true
  };

  const windowId = Number(pickArg(args, "windowId", "window_id"));
  if (Number.isInteger(windowId)) {
    createProperties.windowId = windowId;
  }

  const index = Number(pickArg(args, "index", "index"));
  if (Number.isInteger(index) && index >= 0) {
    createProperties.index = index;
  }

  const openerTabId = Number(pickArg(args, "openerTabId", "opener_tab_id"));
  if (Number.isInteger(openerTabId)) {
    createProperties.openerTabId = openerTabId;
  }

  const tab = await chrome.tabs.create(createProperties);
  return { tab: mapTab(tab) };
}

async function closeTab(args = {}) {
  const tabId = Number(pickArg(args, "tabId", "tab_id"));
  if (!Number.isInteger(tabId)) {
    throw new Error("close_tab requires numeric tabId");
  }

  await chrome.tabs.remove(tabId);
  return { closedTabId: tabId };
}

async function focusTab(args = {}) {
  const tabId = Number(pickArg(args, "tabId", "tab_id"));
  if (!Number.isInteger(tabId)) {
    throw new Error("focus_tab requires numeric tabId");
  }

  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  const updated = await chrome.tabs.update(tabId, { active: true });
  const win = await chrome.windows.get(updated.windowId);
  return { tab: mapTab(updated), window: mapWindow(win) };
}

async function moveTab(args = {}) {
  const tabId = Number(pickArg(args, "tabId", "tab_id"));
  const index = Number(pickArg(args, "index", "index"));
  if (!Number.isInteger(tabId) || !Number.isInteger(index) || index < 0) {
    throw new Error("move_tab requires numeric tabId and non-negative index");
  }

  const moveProperties = { index };
  const windowId = Number(pickArg(args, "windowId", "window_id"));
  if (Number.isInteger(windowId)) {
    moveProperties.windowId = windowId;
  }

  const moved = await chrome.tabs.move(tabId, moveProperties);
  const tab = Array.isArray(moved) ? moved[0] : moved;
  return { tab: mapTab(tab) };
}

async function reloadTab(args = {}) {
  const tabId = Number(pickArg(args, "tabId", "tab_id"));
  if (!Number.isInteger(tabId)) {
    throw new Error("reload_tab requires numeric tabId");
  }

  const bypassCache = Boolean(pickArg(args, "bypassCache", "bypass_cache"));
  const waitForComplete = Boolean(pickArg(args, "waitForComplete", "wait_for_complete"));
  await chrome.tabs.reload(tabId, { bypassCache });
  const tab = waitForComplete ? await waitForTabComplete(tabId, TAB_WAKE_READY_TIMEOUT_MS) : await chrome.tabs.get(tabId);
  return { tab: mapTab(tab), reloaded: true, waitForComplete };
}

async function groupTabs(args = {}) {
  const rawTabIds = pickArg(args, "tabIds", "tab_ids");
  const tabIds = Array.isArray(rawTabIds) ? rawTabIds.map((value) => Number(value)).filter(Number.isInteger) : [];
  if (tabIds.length === 0) {
    throw new Error("group_tabs requires non-empty tabIds");
  }

  const groupIdArg = Number(pickArg(args, "groupId", "group_id"));
  const createProperties = pickArg(args, "createProperties", "create_properties") || {};
  const groupProperties = pickArg(args, "groupProperties", "group_properties") || {};

  const groupCall = { tabIds };
  if (Number.isInteger(groupIdArg) && groupIdArg >= 0) {
    groupCall.groupId = groupIdArg;
  } else {
    const createWindowId = Number(pickArg(createProperties, "windowId", "window_id"));
    if (Number.isInteger(createWindowId)) {
      groupCall.createProperties = { windowId: createWindowId };
    }
  }

  const groupId = await chrome.tabs.group(groupCall);
  const updateProperties = {};
  if (typeof groupProperties.title === "string") {
    updateProperties.title = groupProperties.title;
  }
  if (typeof groupProperties.color === "string") {
    updateProperties.color = groupProperties.color;
  }
  if (Object.hasOwn(groupProperties, "collapsed")) {
    updateProperties.collapsed = Boolean(groupProperties.collapsed);
  }
  if (Object.keys(updateProperties).length > 0) {
    await chrome.tabGroups.update(groupId, updateProperties);
  }

  const tabs = await Promise.all(tabIds.map((tabId) => chrome.tabs.get(tabId)));
  const group = await chrome.tabGroups.get(groupId);
  return {
    groupId,
    group: mapTabGroup(group),
    tabs: tabs.map(mapTab)
  };
}

function shouldCaptureAssetFromRequest(request) {
  if (!request || !request.url) {
    return false;
  }
  if (!/^https?:/i.test(request.url)) {
    return false;
  }
  return request.resourceType !== "WebSocket";
}

async function sendDebuggerCommand(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

function getImportSessionByTabId(tabId) {
  const jobId = importSessionsByTabId.get(tabId);
  return jobId ? importSessions.get(jobId) : null;
}

function markImportSessionUpdated(session, status) {
  session.updatedAt = nowIso();
  if (status) {
    session.status = status;
  }
}

function finalizeImportSession(session, status, error = null) {
  session.status = status;
  session.error = error;
  session.updatedAt = nowIso();
  session.completedAt = nowIso();
}

function ensureImportDebuggerListenersRegistered() {
  if (debuggerListenersRegistered) {
    return;
  }

  chrome.debugger.onEvent.addListener(async (source, method, params) => {
    const tabId = Number(source?.tabId);
    if (!Number.isInteger(tabId)) {
      return;
    }

    const session = getImportSessionByTabId(tabId);
    if (!session) {
      return;
    }

    session.lastNetworkActivityAt = Date.now();

    if (method === "Network.requestWillBeSent") {
      const requestId = String(params.requestId || "");
      const existing = session.requests.get(requestId) || {};
      const next = {
        ...existing,
        requestId,
        url: params.request?.url || existing.url || "",
        documentURL: params.documentURL || existing.documentURL || "",
        resourceType: params.type || existing.resourceType || "Other",
        frameId: params.frameId || existing.frameId || "",
        loaderId: params.loaderId || existing.loaderId || "",
        initiator: params.initiator || existing.initiator || null
      };
      if (!existing.assetOrdinal && shouldCaptureAssetFromRequest(next)) {
        const assetKey = getImportAssetKey(next);
        const nextOrdinal = (session.assetKeyCounts.get(assetKey) || 0) + 1;
        session.assetKeyCounts.set(assetKey, nextOrdinal);
        next.assetOrdinal = nextOrdinal;
      }
      session.requests.set(requestId, next);
      session.inflightRequests.add(requestId);
      markImportSessionUpdated(session);
      return;
    }

    if (method === "Network.requestServedFromCache") {
      const requestId = String(params.requestId || "");
      const existing = session.requests.get(requestId) || { requestId };
      existing.servedFromCache = true;
      session.requests.set(requestId, existing);
      markImportSessionUpdated(session);
      return;
    }

    if (method === "Network.responseReceived") {
      const requestId = String(params.requestId || "");
      const response = params.response || {};
      const existing = session.requests.get(requestId) || { requestId };
      session.requests.set(requestId, {
        ...existing,
        url: response.url || existing.url || "",
        status: response.status || existing.status || null,
        mimeType: response.mimeType || existing.mimeType || "",
        headers: response.headers || existing.headers || {},
        resourceType: params.type || existing.resourceType || "Other",
        servedFromCache: Boolean(existing.servedFromCache || response.fromDiskCache),
        fromDiskCache: Boolean(response.fromDiskCache),
        fromServiceWorker: Boolean(response.fromServiceWorker)
      });
      markImportSessionUpdated(session);
      return;
    }

    if (method === "Network.loadingFailed") {
      const requestId = String(params.requestId || "");
      const existing = session.requests.get(requestId) || { requestId };
      existing.failed = true;
      existing.error = params.errorText || "loading failed";
      session.requests.set(requestId, existing);
      session.inflightRequests.delete(requestId);
      markImportSessionUpdated(session);
      return;
    }

    if (method === "Network.loadingFinished") {
      const requestId = String(params.requestId || "");
      const existing = session.requests.get(requestId) || { requestId };
      existing.finished = true;
      existing.encodedDataLength = params.encodedDataLength || 0;
      session.requests.set(requestId, existing);
      session.inflightRequests.delete(requestId);
      markImportSessionUpdated(session);

      if (!session.options.captureAssets || !shouldCaptureAssetFromRequest(existing)) {
        return;
      }

      if (session.totalAssetBytes >= session.options.maxTotalBytes) {
        existing.error = "max total asset bytes exceeded";
        session.requests.set(requestId, existing);
        return;
      }

      try {
        const body = await sendDebuggerCommand(tabId, "Network.getResponseBody", { requestId });
        const text = String(body?.body || "");
        const bytes = new TextEncoder().encode(text).length;
        if (bytes > session.options.maxAssetBytes) {
          existing.error = `asset exceeds maxAssetBytes (${session.options.maxAssetBytes})`;
          session.requests.set(requestId, existing);
          return;
        }
        if (session.totalAssetBytes + bytes > session.options.maxTotalBytes) {
          existing.error = `asset exceeds remaining total budget (${session.options.maxTotalBytes})`;
          session.requests.set(requestId, existing);
          return;
        }

        const assetId = session.requestToAssetId.get(requestId) || createDeterministicAssetId(existing) || createAssetId();
        session.requestToAssetId.set(requestId, assetId);
        const asset = {
          assetId,
          requestId,
          url: existing.url || "",
          documentURL: existing.documentURL || "",
          resourceType: existing.resourceType || "Other",
          mimeType: existing.mimeType || "application/octet-stream",
          status: existing.status || null,
          assetOrdinal: Number(existing.assetOrdinal || 1),
          servedFromCache: Boolean(existing.servedFromCache),
          fromDiskCache: Boolean(existing.fromDiskCache),
          fromServiceWorker: Boolean(existing.fromServiceWorker),
          headers: existing.headers || {},
          base64Encoded: Boolean(body?.base64Encoded),
          body: text,
          bytes,
          error: null
        };
        session.assetsById.set(assetId, asset);
        session.totalAssetBytes += bytes;
      } catch (error) {
        existing.error = String(error?.message || error);
        session.requests.set(requestId, existing);
      }
      return;
    }

    if (method === "Page.loadEventFired") {
      session.loadEventFiredAt = Date.now();
      markImportSessionUpdated(session);
    }
  });

  chrome.debugger.onDetach.addListener((source, reason) => {
    const tabId = Number(source?.tabId);
    if (!Number.isInteger(tabId)) {
      return;
    }

    const session = getImportSessionByTabId(tabId);
    if (!session) {
      return;
    }

    session.attached = false;
    session.detachedReason = reason;
    if (!["completed", "failed", "cancelled"].includes(session.status)) {
      finalizeImportSession(session, "failed", {
        code: "IMPORT_BUNDLE_ATTACH_FAILED",
        message: `debugger detached unexpectedly: ${reason}`
      });
    }
  });

  debuggerListenersRegistered = true;
}

async function detachImportDebugger(session) {
  if (!session.attached) {
    return;
  }

  try {
    await chrome.debugger.detach({ tabId: session.tabId });
  } catch (error) {
    log("warn", "import.debugger.detach.failed", { tabId: session.tabId, error: String(error) });
  } finally {
    session.attached = false;
  }
}

async function waitForImportNetworkIdle(session) {
  const deadline = Date.now() + session.options.settleTimeoutMs;
  while (Date.now() < deadline) {
    if (session.status === "cancelled") {
      throw new Error("Import bundle cancelled");
    }

    const idleForMs = Date.now() - session.lastNetworkActivityAt;
    if (session.loadEventFiredAt && session.inflightRequests.size === 0 && idleForMs >= session.options.waitForNetworkIdleMs) {
      return;
    }

    await sleep(150);
  }

  throw new Error(`Import bundle timed out after ${session.options.settleTimeoutMs}ms waiting for network idle`);
}

async function captureImportScreenshot(session) {
  const tab = await chrome.tabs.get(session.tabId);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  return {
    contentType: "image/png",
    dataUrl
  };
}

async function runImportBundleCapture(session) {
  const traceId = nextTraceId("import");
  markImportSessionUpdated(session, "attaching");
  session.startedAt = nowIso();
  log("info", "import.start", { jobId: session.jobId, tabId: session.tabId, options: session.options }, traceId);

  try {
    ensureImportDebuggerListenersRegistered();
    const initialTab = await chrome.tabs.get(session.tabId);
    const prepared = await prepareTabForSnapshot(initialTab);
    session.wake = prepared.wake;

    await chrome.debugger.attach({ tabId: session.tabId }, DEBUGGER_PROTOCOL_VERSION);
    session.attached = true;
    markImportSessionUpdated(session, "capturing");

    await sendDebuggerCommand(session.tabId, "Network.enable");
    await sendDebuggerCommand(session.tabId, "Page.enable");

    if (session.options.reload) {
      await sendDebuggerCommand(session.tabId, "Page.reload", { ignoreCache: false });
    }

    await waitForImportNetworkIdle(session);
    markImportSessionUpdated(session, "finalizing");

    session.finalSnapshot = await snapshotTab({
      tabId: session.tabId,
      includeHtml: session.options.captureHtml,
      includeText: session.options.captureText,
      includeSelection: session.options.captureSelection
    });

    if (session.options.captureScreenshot) {
      try {
        session.screenshot = await captureImportScreenshot(session);
      } catch (error) {
        log("warn", "import.screenshot.failed", { jobId: session.jobId, error: String(error) }, traceId);
      }
    }

    finalizeImportSession(session, "completed");
    log(
      "info",
      "import.completed",
      {
        jobId: session.jobId,
        tabId: session.tabId,
        assetsCaptured: session.assetsById.size,
        totalAssetBytes: session.totalAssetBytes
      },
      traceId
    );
  } catch (error) {
    finalizeImportSession(session, "failed", {
      code: getImportErrorCode(error),
      message: String(error?.message || error)
    });
    log("error", "import.failed", { jobId: session.jobId, tabId: session.tabId, error: String(error) }, traceId);
  } finally {
    await detachImportDebugger(session);
    const finalTab = await chrome.tabs.get(session.tabId).catch(() => null);
    await restorePreviouslyActiveTab(finalTab?.windowId, session.wake.previousActiveTabId, session.wake.didSwitch);
  }
}

async function startImportBundle(args = {}) {
  const tabId = Number(pickArg(args, "tabId", "tab_id"));
  if (!Number.isInteger(tabId)) {
    throw new Error("start_import_bundle requires numeric tabId");
  }
  if (getImportSessionByTabId(tabId) && !["completed", "failed", "cancelled"].includes(getImportSessionByTabId(tabId).status)) {
    throw new Error(`Import bundle already running for tab ${tabId}`);
  }

  const options = normalizeImportOptions(args);
  const session = makeImportSession(tabId, options);
  importSessions.set(session.jobId, session);
  importSessionsByTabId.set(tabId, session.jobId);
  void runImportBundleCapture(session);

  return summarizeImportSession(session);
}

async function getImportBundleStatus(args = {}) {
  const jobId = String(pickArg(args, "jobId", "job_id") || "");
  const session = importSessions.get(jobId);
  if (!session) {
    throw new Error(`Unknown import bundle job: ${jobId}`);
  }
  return summarizeImportSession(session);
}

async function getImportBundleManifest(args = {}) {
  const jobId = String(pickArg(args, "jobId", "job_id") || "");
  const session = importSessions.get(jobId);
  if (!session) {
    throw new Error(`Unknown import bundle job: ${jobId}`);
  }
  if (session.status !== "completed") {
    throw new Error(`Import bundle job ${jobId} is not completed`);
  }

  const assets = Array.from(session.assetsById.values())
    .sort((left, right) => {
      const leftKey = `${left.url}\u0000${left.assetOrdinal || 1}\u0000${left.requestId}`;
      const rightKey = `${right.url}\u0000${right.assetOrdinal || 1}\u0000${right.requestId}`;
      return leftKey.localeCompare(rightKey);
    })
    .map(serializeAsset);

  return {
    ...summarizeImportSession(session),
    bundle: {
      tab: session.finalSnapshot
        ? {
            id: session.tabId,
            title: session.finalSnapshot.title,
            url: session.finalSnapshot.url
          }
        : { id: session.tabId },
      document: session.finalSnapshot
        ? {
            contentType: "text/html",
            html: session.finalSnapshot.html,
            text: session.finalSnapshot.text,
            selection: session.finalSnapshot.selection
          }
        : null,
      capture: {
        startedAt: session.startedAt,
        completedAt: session.completedAt,
        loadEventFiredAt: session.loadEventFiredAt ? new Date(session.loadEventFiredAt).toISOString() : null,
        waitForNetworkIdleMs: session.options.waitForNetworkIdleMs,
        settleTimeoutMs: session.options.settleTimeoutMs
      },
      screenshot: session.screenshot
        ? {
            contentType: session.screenshot.contentType,
            available: true
          }
        : null,
      assets
    }
  };
}

async function getImportBundleAsset(args = {}) {
  const jobId = String(pickArg(args, "jobId", "job_id") || "");
  const assetId = String(pickArg(args, "assetId", "asset_id") || "");
  const session = importSessions.get(jobId);
  if (!session) {
    throw new Error(`Unknown import bundle job: ${jobId}`);
  }

  if (assetId === "screenshot" && session.screenshot) {
    return {
      jobId,
      assetId,
      contentType: session.screenshot.contentType,
      base64Encoded: false,
      body: session.screenshot.dataUrl
    };
  }

  const asset = session.assetsById.get(assetId);
  if (!asset) {
    throw new Error(`Unknown import bundle asset: ${assetId}`);
  }

  return {
    jobId,
    asset: serializeAsset(asset),
    contentType: asset.mimeType || "application/octet-stream",
    base64Encoded: asset.base64Encoded,
    body: asset.body
  };
}

async function cancelImportBundle(args = {}) {
  const jobId = String(pickArg(args, "jobId", "job_id") || "");
  const session = importSessions.get(jobId);
  if (!session) {
    throw new Error(`Unknown import bundle job: ${jobId}`);
  }

  finalizeImportSession(session, "cancelled", {
    code: "IMPORT_BUNDLE_CANCELLED",
    message: "Import bundle cancelled by caller"
  });
  await detachImportDebugger(session);
  importSessionsByTabId.delete(session.tabId);
  return summarizeImportSession(session);
}

function collectSnapshotMeta(args) {
  const startedAt = new Date().toISOString();
  const includeSelection = Boolean(args?.includeSelection);
  const maxSelectionChars = Number(args?.maxSelectionChars || 0);
  let selection = includeSelection ? String(window.getSelection?.() || "") : "";
  if (includeSelection && maxSelectionChars > 0 && selection.length > maxSelectionChars) {
    selection = selection.slice(0, maxSelectionChars);
  }

  return {
    startedAt,
    title: document.title,
    url: location.href,
    lang: document.documentElement.lang || "",
    selection,
    readyState: document.readyState
  };
}

function collectSnapshotHtml() {
  return {
    html: document.documentElement.outerHTML
  };
}

function collectSnapshotText(args) {
  const maxTextChars = Number(args?.maxTextChars || 0);
  const root = document.body;
  if (!root) {
    return { text: "" };
  }

  const skipTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "CANVAS", "TEMPLATE"]);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const chunks = [];
  let total = 0;
  let node = walker.nextNode();

  while (node) {
    const parent = node.parentElement;
    if (parent && !skipTags.has(parent.tagName)) {
      const raw = node.nodeValue || "";
      const normalized = raw.replace(/\s+/g, " ").trim();
      if (normalized) {
        const remaining = maxTextChars > 0 ? maxTextChars - total : Infinity;
        if (remaining <= 0) {
          break;
        }
        if (normalized.length <= remaining) {
          chunks.push(normalized);
          total += normalized.length + 1;
        } else {
          chunks.push(normalized.slice(0, remaining));
          break;
        }
      }
    }
    node = walker.nextNode();
  }

  return {
    text: chunks.join(" ")
  };
}

async function snapshotTab(args = {}) {
  const tabId = Number(pickArg(args, "tabId", "tab_id"));
  if (!Number.isInteger(tabId)) {
    throw new Error("snapshot_tab requires numeric tabId");
  }

  const includeHtml = pickArg(args, "includeHtml", "include_html") ?? runtimeConfig.includeHtml;
  const includeText = pickArg(args, "includeText", "include_text") ?? runtimeConfig.includeText;
  const includeSelection = pickArg(args, "includeSelection", "include_selection") ?? runtimeConfig.includeSelection;
  const maxTextChars = Math.max(1000, Math.floor(runtimeConfig.maxTextBytes / 2));
  const initialTab = await chrome.tabs.get(tabId);
  const prepared = await prepareTabForSnapshot(initialTab);
  const tab = prepared.tab;
  const wake = prepared.wake;
  const url = String(tab.url || "");
  if (!/^https?:/i.test(url)) {
    await restorePreviouslyActiveTab(tab.windowId, wake.previousActiveTabId, wake.didSwitch);
    throw new Error(`Unsupported tab URL for snapshot: ${url}`);
  }

  async function executeCollector(func, collectorArgs, timeoutMs, label) {
    const [result] = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        injectImmediately: true,
        func,
        args: collectorArgs ? [collectorArgs] : []
      }),
      timeoutMs,
      label
    );

    if (!result || !result.result) {
      throw new Error(`${label} returned no result`);
    }

    return result.result;
  }

  async function collectSnapshot(timeoutBudget) {
    const meta = await executeCollector(
      collectSnapshotMeta,
      { includeSelection, maxSelectionChars: maxTextChars },
      timeoutBudget.meta,
      "snapshot meta executeScript"
    );

    let html = "";
    if (includeHtml) {
      html = (await executeCollector(
        collectSnapshotHtml,
        null,
        timeoutBudget.html,
        "snapshot html executeScript"
      )).html || "";
    }

    let text = "";
    if (includeText) {
      text = (await executeCollector(
        collectSnapshotText,
        { maxTextChars },
        timeoutBudget.text,
        "snapshot text executeScript"
      )).text || "";
    }

    return {
      ...meta,
      html,
      text,
      completedAt: new Date().toISOString()
    };
  }

  log("info", "snapshot.preflight", {
    tabId,
    url,
    status: tab.status,
    active: tab.active,
    discarded: tab.discarded,
    didSwitch: wake.didSwitch,
    hasHostPermission: await hasHostPermissionForUrl(url)
  });

  let execResult;
  let lastError;
  try {
    execResult = await collectSnapshot({
      meta: SNAPSHOT_META_TIMEOUT_MS,
      html: SNAPSHOT_HTML_TIMEOUT_MS,
      text: SNAPSHOT_TEXT_TIMEOUT_MS
    });
  } catch (error) {
    lastError = error;
    log("warn", "snapshot.first_attempt.failed", { tabId, error: String(error) });

    log("info", "snapshot.wake_tab", { tabId, didSwitch: wake.didSwitch, previousActiveTabId: wake.previousActiveTabId });
    try {
      execResult = await collectSnapshot({
        meta: SNAPSHOT_RETRY_META_TIMEOUT_MS,
        html: SNAPSHOT_RETRY_HTML_TIMEOUT_MS,
        text: SNAPSHOT_RETRY_TEXT_TIMEOUT_MS
      });
    } catch (retryError) {
      lastError = retryError;
      log("error", "snapshot.retry_after_wake.failed", { tabId, error: String(retryError) });
    }
  }

  if (!execResult && isHostPermissionError(lastError)) {
    log("warn", "snapshot.permission_error.retrying_after_reload", { tabId, url, error: String(lastError) });
    try {
      await reloadTabForSnapshot(tabId);
      execResult = await collectSnapshot({
        meta: SNAPSHOT_RETRY_META_TIMEOUT_MS,
        html: SNAPSHOT_RETRY_HTML_TIMEOUT_MS,
        text: SNAPSHOT_RETRY_TEXT_TIMEOUT_MS
      });
    } catch (reloadRetryError) {
      lastError = reloadRetryError;
      log("error", "snapshot.retry_after_reload.failed", { tabId, error: String(reloadRetryError) });
    }
  }

  if (!execResult) {
    await restorePreviouslyActiveTab(tab.windowId, wake.previousActiveTabId, wake.didSwitch);
    throw new Error(String(lastError?.message || lastError || "snapshot collection failed"));
  }

  const payload = execResult;
  const html = trimByBytes(payload.html, runtimeConfig.maxHtmlBytes);
  const text = trimByBytes(payload.text, runtimeConfig.maxTextBytes);
  const selection = trimByBytes(payload.selection, runtimeConfig.maxTextBytes);

  const response = {
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

  await restorePreviouslyActiveTab(tab.windowId, wake.previousActiveTabId, wake.didSwitch);
  return response;
}

function safeSend(data) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  socket.send(JSON.stringify(data));
  return true;
}

function startKeepalive() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
  }

  keepaliveTimer = setInterval(() => {
    safeSend({
      type: "keepalive",
      ts: nowIso(),
      seq: ++outboundSeq
    });
  }, SOCKET_KEEPALIVE_MS);
}

function stopKeepalive() {
  if (!keepaliveTimer) {
    return;
  }

  clearInterval(keepaliveTimer);
  keepaliveTimer = null;
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

async function ensureConnectionAlarm() {
  const traceId = nextTraceId("alarm");
  await chrome.alarms.create(CONNECTION_ALARM_NAME, {
    periodInMinutes: CONNECTION_ALARM_MINUTES
  });
  log("info", "alarm.ensure_connection_heartbeat", { periodInMinutes: CONNECTION_ALARM_MINUTES }, traceId);
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
    } else if (command === "get_active_tab") {
      result = await getActiveTab(args);
    } else if (command === "get_tab_state") {
      result = await getTabState(args);
    } else if (command === "open_tab") {
      result = await openTab(args);
    } else if (command === "close_tab") {
      result = await closeTab(args);
    } else if (command === "focus_tab") {
      result = await focusTab(args);
    } else if (command === "move_tab") {
      result = await moveTab(args);
    } else if (command === "group_tabs") {
      result = await groupTabs(args);
    } else if (command === "reload_tab") {
      result = await reloadTab(args);
    } else if (command === "start_import_bundle") {
      result = await startImportBundle(args);
    } else if (command === "get_import_bundle_status") {
      result = await getImportBundleStatus(args);
    } else if (command === "get_import_bundle_manifest") {
      result = await getImportBundleManifest(args);
    } else if (command === "get_import_bundle_asset") {
      result = await getImportBundleAsset(args);
    } else if (command === "cancel_import_bundle") {
      result = await cancelImportBundle(args);
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
      const endpoint = pickArg(args, "endpoint", "ws_endpoint");
      if (typeof endpoint === "string") {
        next.endpoint = normalizeUrl(endpoint);
      }
      const reconnectMs = Number(pickArg(args, "reconnectMs", "reconnect_ms"));
      if (Number.isInteger(reconnectMs) && reconnectMs > 99) {
        next.reconnectMs = reconnectMs;
      }
      const maxHtmlBytes = Number(pickArg(args, "maxHtmlBytes", "max_html_bytes"));
      if (Number.isInteger(maxHtmlBytes) && maxHtmlBytes > 9_999) {
        next.maxHtmlBytes = maxHtmlBytes;
      }
      const maxTextBytes = Number(pickArg(args, "maxTextBytes", "max_text_bytes"));
      if (Number.isInteger(maxTextBytes) && maxTextBytes > 1_000) {
        next.maxTextBytes = maxTextBytes;
      }
      if (Object.hasOwn(args, "includeHtml") || Object.hasOwn(args, "include_html")) {
        next.includeHtml = Boolean(pickArg(args, "includeHtml", "include_html"));
      }
      if (Object.hasOwn(args, "includeText") || Object.hasOwn(args, "include_text")) {
        next.includeText = Boolean(pickArg(args, "includeText", "include_text"));
      }
      if (Object.hasOwn(args, "includeSelection") || Object.hasOwn(args, "include_selection")) {
        next.includeSelection = Boolean(pickArg(args, "includeSelection", "include_selection"));
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
        code: getCommandErrorCode(error),
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
    startKeepalive();
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
    stopKeepalive();
    socket = null;
    scheduleReconnect();
  };

  socket.onerror = (event) => {
    log("error", "socket.error", { eventType: event.type }, traceId);
  };
}

function registerEventBridge() {
  if (eventsRegistered) {
    log("warn", "events.register.skip_already_registered", {});
    return;
  }

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

  eventsRegistered = true;
  log("info", "events.register.ok", {});
}

async function bootstrap(reason = "default") {
  if (bootstrapInFlight) {
    log("info", "bootstrap.skip_inflight", { reason });
    return bootstrapInFlight;
  }

  const traceId = nextTraceId("boot");
  bootstrapInFlight = (async () => {
    log("info", "bootstrap.start", { version: EXT_VERSION, reason }, traceId);
    await loadConfig();
    registerEventBridge();
    await ensureConnectionAlarm();
    await connectSocket();
    log("info", "bootstrap.ready", { reason }, traceId);
  })();

  try {
    await bootstrapInFlight;
  } finally {
    bootstrapInFlight = null;
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const traceId = nextTraceId("lifecycle");
  log("info", "runtime.installed", details, traceId);
  await loadConfig();
  await saveConfig(runtimeConfig);
  await ensureConnectionAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  const traceId = nextTraceId("lifecycle");
  log("info", "runtime.startup", {}, traceId);
  void bootstrap("runtime.onStartup");
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== CONNECTION_ALARM_NAME) {
    return;
  }

  const traceId = nextTraceId("alarm");
  log("info", "alarm.heartbeat", {}, traceId);
  void connectSocket();
});

chrome.runtime.onSuspend.addListener(() => {
  const traceId = nextTraceId("lifecycle");
  log("warn", "runtime.suspend", {}, traceId);
});

chrome.runtime.onSuspendCanceled?.addListener(() => {
  const traceId = nextTraceId("lifecycle");
  log("info", "runtime.suspend_canceled", {}, traceId);
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

void bootstrap("module.load");
