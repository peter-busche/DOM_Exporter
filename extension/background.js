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

  const saved = await saveFiles([
    { name: `${base}.selection.json`, text: JSON.stringify(selection, null, 2), mime: "application/json" },
    { name: `${base}.json`, text: JSON.stringify(summary, null, 2), mime: "application/json" },
    { name: `${base}.html`, text: html, mime: "text/html" },
  ]);

  await notify(tabId, frameId, `Recorded ${selection.path}. ${saved.message}`, false);
  return { ...result, saved: { ok: saved.saved, reason: saved.reason || null, message: saved.message } };
}

// --- Saving ---------------------------------------------------------------------
// Files are saved by an offscreen document. It writes them into the folder the
// user chose in settings; when it cannot (no folder chosen, access lapsed, or a
// write error) it hands back blob: URLs and the files go to Downloads instead.
// The offscreen document is needed either way: a service worker cannot create
// blob: URLs, and data: URLs stop working around 2 MB.

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

// files: [{ name, text, mime }]. Resolves to the offscreen document's result,
// whose `message` says where the files went.
async function saveFiles(files) {
  await ensureOffscreen();
  const result = await chrome.runtime.sendMessage({ target: "dom-export-offscreen", type: "save-files", files });
  if (!result) throw new Error("Could not save the files.");
  if (!result.saved) {
    if (!result.fallback) throw new Error("Could not prepare the files for download.");
    for (const file of result.fallback) {
      await chrome.downloads.download({ url: file.url, filename: file.filename, saveAs: false });
    }
  }
  return result;
}
