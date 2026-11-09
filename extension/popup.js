// The popup: full page export of the active tab, plus the save-location
// summary and subfolder field. capturePage lives in capture.js, which is
// injected into the page before it is called. DXStore lives in filestore.js.

const button = document.getElementById("export");
const status = document.getElementById("status");
const locationEl = document.getElementById("location");
const warningEl = document.getElementById("warning");
const labelInput = document.getElementById("label");
const settingsButton = document.getElementById("settings");

async function refreshLocation() {
  const info = await DXStore.describe();
  const lapsed = info.mode === "folder" && info.permission !== "granted";
  // Show where files will really go right now.
  locationEl.textContent = lapsed ? "Downloads" + (info.label ? "/" + info.label : "") : info.display;
  warningEl.hidden = !lapsed;
  warningEl.textContent = lapsed
    ? `Chrome needs you to re-approve the folder "${info.folderName}". Click "Change folder…" and then "Re-allow access".`
    : "";
  return info;
}

settingsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());

labelInput.addEventListener("input", async () => {
  await DXStore.setLabel(labelInput.value);
  await refreshLocation();
});

// Saves to the chosen folder, or to Downloads when that is not possible.
async function saveFiles(files) {
  const result = await DXStore.writeFiles(files);
  if (!result.saved) {
    for (const file of files) {
      const url = URL.createObjectURL(new Blob([file.text], { type: file.mime }));
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      await chrome.downloads.download({ url, filename: DXStore.downloadsPath(result, file.name), saveAs: false });
    }
  }
  return DXStore.resultText(result, files.length);
}

button.addEventListener("click", async () => {
  button.disabled = true;
  status.textContent = "Capturing...";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error("No active tab found.");
    if (!/^https?:/.test(tab.url || "")) throw new Error("Only http(s) pages can be exported.");

    // Injecting the file is harmless if the content script already loaded it,
    // and covers tabs opened before the extension was installed or reloaded.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["capture.js"],
    });
    // Return a JSON string, not an object: Chrome re-serializes objects returned
    // from injected scripts with their keys sorted alphabetically, which would
    // put each node's children before its tag and scatter the header fields.
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => JSON.stringify(await capturePage()),
    });
    if (!result || typeof result.result !== "string") throw new Error("The page returned no data.");
    const { html, summary } = JSON.parse(result.result);

    const host = new URL(summary.url).hostname.replace(/[^a-z0-9.-]/gi, "_");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = `dom-export-${host}-${stamp}`;

    const where = await saveFiles([
      { name: `${base}.json`, text: JSON.stringify(summary, null, 2), mime: "application/json" },
      { name: `${base}.html`, text: html, mime: "text/html" },
    ]);

    const c = summary.counts;
    const warnings = [];
    if (c.treeTruncated) warnings.push("tree truncated");
    if (c.stylesheetsUnreadable) warnings.push(`${c.stylesheetsUnreadable} stylesheet(s) unreadable`);
    status.textContent =
      `${where} ${base}: ${c.elements} elements, ${c.stylesheets} stylesheet(s), ${c.images} image(s).` +
      (warnings.length ? ` Warning: ${warnings.join(", ")}.` : "");
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  } finally {
    button.disabled = false;
    refreshLocation().catch(() => {});
  }
});

(async () => {
  const info = await refreshLocation();
  labelInput.value = info.label;
})().catch(err => { locationEl.textContent = "Downloads"; console.error(err); });
