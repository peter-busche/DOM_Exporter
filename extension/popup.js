// The Export button: full page export of the active tab. capturePage lives in
// capture.js, which is injected into the page before it is called.

function download(content, filename, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  return chrome.downloads.download({ url, filename, saveAs: false }).finally(() => {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
}

const button = document.getElementById("export");
const status = document.getElementById("status");

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

    await download(JSON.stringify(summary, null, 2), `${base}.json`, "application/json");
    await download(html, `${base}.html`, "text/html");

    const c = summary.counts;
    const warnings = [];
    if (c.treeTruncated) warnings.push("tree truncated");
    if (c.stylesheetsUnreadable) warnings.push(`${c.stylesheetsUnreadable} stylesheet(s) unreadable`);
    status.textContent =
      `Saved ${base}.json and .html: ${c.elements} elements, ${c.stylesheets} stylesheet(s), ${c.images} image(s).` +
      (warnings.length ? ` Warning: ${warnings.join(", ")}.` : "");
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  } finally {
    button.disabled = false;
  }
});
