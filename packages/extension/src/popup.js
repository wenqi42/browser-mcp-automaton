const fields = {
  serverUrl: document.querySelector("#serverUrl"),
  token: document.querySelector("#token"),
  allowedHosts: document.querySelector("#allowedHosts"),
  allowScriptExecution: document.querySelector("#allowScriptExecution"),
  allowNetworkCapture: document.querySelector("#allowNetworkCapture"),
  includeRequestHeaders: document.querySelector("#includeRequestHeaders"),
  status: document.querySelector("#status")
};

document.querySelector("#save").addEventListener("click", () => void save());
document.querySelector("#connect").addEventListener("click", async () => {
  await save();
  await chrome.runtime.sendMessage({ type: "bridge.connect" });
  await refresh();
});
document.querySelector("#disconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "bridge.disconnect" });
  await refresh();
});

await refresh();

async function refresh() {
  const response = await chrome.runtime.sendMessage({ type: "settings.get" });
  if (!response?.ok) return;
  const settings = response.settings;
  fields.serverUrl.value = settings.serverUrl ?? "";
  fields.token.value = settings.token ?? "";
  fields.allowedHosts.value = (settings.allowedHosts ?? []).join("\n");
  fields.allowScriptExecution.checked = Boolean(settings.allowScriptExecution);
  fields.allowNetworkCapture.checked = Boolean(settings.allowNetworkCapture);
  fields.includeRequestHeaders.checked = Boolean(settings.includeRequestHeaders);
  fields.status.textContent = response.connected ? "Connected" : "Disconnected";
}

async function save() {
  const settings = {
    serverUrl: fields.serverUrl.value.trim(),
    token: fields.token.value.trim(),
    allowedHosts: fields.allowedHosts.value,
    allowScriptExecution: fields.allowScriptExecution.checked,
    allowNetworkCapture: fields.allowNetworkCapture.checked,
    includeRequestHeaders: fields.includeRequestHeaders.checked
  };
  await chrome.runtime.sendMessage({ type: "settings.save", settings });
}
