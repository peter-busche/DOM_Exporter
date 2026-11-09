// Background service worker: owns the right-click menu item and saves the files.

const MENU_ID = "dom-export-record-element";
const MENU_CONTEXTS = ["page", "frame", "selection", "link", "editable", "image", "video", "audio"];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "DOM Export: record this element",
      contexts: MENU_CONTEXTS,
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id === undefined) return;
  recordSelection(tab.id, info.frameId || 0).catch(err => {
    console.error("DOM Export: record failed", err);
    notify(tab.id, info.frameId || 0, `DOM Export failed: ${err.message}`, true);
  });
});

function notify(tabId, frameId, text, isError) {
  return chrome.tabs
    .sendMessage(tabId, { type: "dom-export-toast", text, isError }, { frameId })
    .catch(() => {});
}

async function askContentScript(tabId, frameId) {
  const message = { type: "dom-export-record-selection" };
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId });
  } catch (err) {
    // No content script yet: the tab was open before the extension was
    // installed or reloaded. Inject it; it will tell the user to refresh,
    // because the right-click it needed to observe has already happened.
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ["capture.js", "content.js"],
    });
    return await chrome.tabs.sendMessage(tabId, message, { frameId });
  }
}

async function recordSelection(tabId, frameId) {
  const result = await askContentScript(tabId, frameId);
  if (!result || !result.ok) return result; // the content script already told the user why

  const { selection, summary, html } = result;
  const host = new URL(summary.url).hostname.replace(/[^a-z0-9.-]/gi, "_") || "page";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `dom-export-${host}-${stamp}`;

  selection.fullExportFile = `${base}.json`;
  selection.htmlFile = `${base}.html`;
  if (summary.selection) summary.selection.selectionFile = `${base}.selection.json`;

  await download(JSON.stringify(selection, null, 2), `${base}.selection.json`, "application/json");
  await download(JSON.stringify(summary, null, 2), `${base}.json`, "application/json");
  await download(html, `${base}.html`, "text/html");

  await notify(tabId, frameId, `Recorded ${selection.path}. Saved ${base}.selection.json, .json and .html to Downloads.`, false);
  return result;
}

// --- Downloads ------------------------------------------------------------------
// A service worker cannot create blob: URLs, and data: URLs stop working around
// 2 MB, so an offscreen document turns the text into a blob: URL.

let offscreenReady = null;

function ensureOffscreen() {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      if (await chrome.offscreen.hasDocument()) return;
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification: "Create blob URLs so exported files can be downloaded.",
      });
    })().catch(err => { offscreenReady = null; throw err; });
  }
  return offscreenReady;
}

async function download(text, filename, mime) {
  await ensureOffscreen();
  const reply = await chrome.runtime.sendMessage({ target: "dom-export-offscreen", type: "make-blob-url", text, mime });
  if (!reply || !reply.url) throw new Error("Could not prepare the file for download.");
  return chrome.downloads.download({ url: reply.url, filename, saveAs: false });
}
