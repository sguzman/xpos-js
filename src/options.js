const form = document.querySelector("#settings-form");
const statusEl = document.querySelector("#status");
const reconnectButton = document.querySelector("#reload");

function log(message, details = {}) {
  const line = {
    ts: new Date().toISOString(),
    message,
    details
  };
  statusEl.textContent = `${line.ts} ${line.message}\n${JSON.stringify(line.details, null, 2)}`;
  console.log("[xpose][options]", line);
}

function setForm(config) {
  form.endpoint.value = config.endpoint;
  form.reconnectMs.value = String(config.reconnectMs);
  form.maxHtmlBytes.value = String(config.maxHtmlBytes);
  form.maxTextBytes.value = String(config.maxTextBytes);
  form.includeHtml.checked = Boolean(config.includeHtml);
  form.includeText.checked = Boolean(config.includeText);
  form.includeSelection.checked = Boolean(config.includeSelection);
}

function getForm() {
  return {
    endpoint: form.endpoint.value.trim(),
    reconnectMs: Number(form.reconnectMs.value),
    maxHtmlBytes: Number(form.maxHtmlBytes.value),
    maxTextBytes: Number(form.maxTextBytes.value),
    includeHtml: form.includeHtml.checked,
    includeText: form.includeText.checked,
    includeSelection: form.includeSelection.checked
  };
}

async function load() {
  const response = await chrome.runtime.sendMessage({ type: "get_config" });
  if (!response?.ok) {
    throw new Error(response?.error || "Failed to load config");
  }
  setForm(response.config);
  log("Loaded config", response.config);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const response = await chrome.runtime.sendMessage({
      type: "set_config",
      config: getForm()
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Failed to save config");
    }

    setForm(response.config);
    log("Saved config", response.config);
  } catch (error) {
    log("Save failed", { error: String(error?.message || error) });
  }
});

reconnectButton.addEventListener("click", async () => {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "set_config",
      config: getForm()
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Reconnect failed");
    }

    log("Reconnect requested", response.config);
  } catch (error) {
    log("Reconnect request failed", { error: String(error?.message || error) });
  }
});

void load();
