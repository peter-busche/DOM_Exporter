// Save-location logic shared by the popup, the settings page and the offscreen
// document. Remembers the folder the user picked (a FileSystemDirectoryHandle,
// kept in IndexedDB) plus an optional subfolder label, and writes export files
// there. Callers fall back to the Downloads folder when writeFiles() reports
// saved: false.
var DXStore = (() => {
  const DB_NAME = "dom-export";
  const STORE = "config";
  const KEY_FOLDER = "folder";
  const KEY_LABEL = "label";

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function tx(mode, run) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    } finally {
      db.close();
    }
  }

  const get = key => tx("readonly", s => s.get(key));
  const set = (key, value) => tx("readwrite", s => s.put(value, key));
  const del = key => tx("readwrite", s => s.delete(key));

  // "My Task / nav: color" -> "My Task/nav- color". Each path segment keeps
  // letters, digits, spaces, dots, dashes and underscores; anything else
  // becomes a dash. Empty, "." and ".." segments are dropped.
  function cleanLabel(raw) {
    return String(raw || "")
      .split(/[\\/]+/)
      .map(seg => seg.replace(/[^A-Za-z0-9 ._-]/g, "-").replace(/^[ .]+|[ .]+$/g, "").slice(0, 80))
      .filter(seg => seg && seg !== "." && seg !== "..")
      .slice(0, 6)
      .join("/");
  }

  async function getConfig() {
    const [handle, label] = await Promise.all([get(KEY_FOLDER), get(KEY_LABEL)]);
    return { handle: handle || null, label: cleanLabel(label) };
  }

  const setFolder = handle => set(KEY_FOLDER, handle);
  const clearFolder = () => del(KEY_FOLDER);
  const setLabel = label => set(KEY_LABEL, cleanLabel(label));

  // "granted" | "prompt" | "denied"
  async function permissionOf(handle) {
    try {
      return await handle.queryPermission({ mode: "readwrite" });
    } catch (e) {
      return "denied";
    }
  }

  // Must be called from a user gesture (a click) in a visible extension page.
  async function requestPermission(handle) {
    try {
      return await handle.requestPermission({ mode: "readwrite" });
    } catch (e) {
      return "denied";
    }
  }

  // Current save location, for display.
  async function describe() {
    const { handle, label } = await getConfig();
    if (!handle) {
      return { mode: "downloads", label, folderName: null, permission: null, display: "Downloads" + (label ? "/" + label : "") };
    }
    const permission = await permissionOf(handle);
    return {
      mode: "folder",
      label,
      folderName: handle.name,
      permission,
      display: handle.name + (label ? "/" + label : ""),
    };
  }

  async function writeOne(dir, name, text) {
    const file = await dir.getFileHandle(name, { create: true });
    const writable = await file.createWritable();
    try {
      await writable.write(text);
    } finally {
      await writable.close();
    }
  }

  // files: [{ name, text, mime }]
  // Resolves to { saved: true, location, ... } when everything was written to
  // the chosen folder; otherwise { saved: false, reason, ... } and the caller
  // should save to Downloads instead. Never throws.
  async function writeFiles(files) {
    let config;
    try {
      config = await getConfig();
    } catch (e) {
      return { saved: false, reason: "no-folder", label: "", folderName: null, error: e.message };
    }
    const { handle, label } = config;
    const base = { label, folderName: handle ? handle.name : null };
    if (!handle) return { saved: false, reason: "no-folder", ...base };

    const permission = await permissionOf(handle);
    if (permission !== "granted") return { saved: false, reason: "needs-permission", ...base };

    try {
      let dir = handle;
      for (const segment of label ? label.split("/") : []) {
        dir = await dir.getDirectoryHandle(segment, { create: true });
      }
      for (const file of files) await writeOne(dir, file.name, file.text);
      return { saved: true, location: handle.name + (label ? "/" + label : ""), names: files.map(f => f.name), ...base };
    } catch (e) {
      return { saved: false, reason: "write-failed", error: e.message || String(e), ...base };
    }
  }

  // Relative path to use with chrome.downloads when falling back.
  function downloadsPath(result, name) {
    return (result && result.label ? result.label + "/" : "") + name;
  }

  // One sentence telling the user where the files went, and why if it was not
  // the folder they chose.
  function resultText(result, count) {
    const n = `${count} file${count === 1 ? "" : "s"}`;
    if (result.saved) return `Saved ${n} to ${result.location}.`;
    const downloads = "Downloads" + (result.label ? "/" + result.label : "");
    if (result.reason === "needs-permission") {
      return `Saved ${n} to ${downloads}, because Chrome needs you to re-approve access to the folder "${result.folderName}". Open DOM Export settings to allow it.`;
    }
    if (result.reason === "write-failed") {
      return `Saved ${n} to ${downloads}, because writing to the folder "${result.folderName}" failed (${result.error}). Open DOM Export settings to check the folder.`;
    }
    return `Saved ${n} to ${downloads}.`;
  }

  // Proves the folder is writable by creating and removing a scratch file.
  async function verifyWritable(handle) {
    const name = ".dom-export-write-test";
    try {
      await writeOne(handle, name, "ok");
      await handle.removeEntry(name);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  return {
    cleanLabel, getConfig, setFolder, clearFolder, setLabel,
    permissionOf, requestPermission, describe, writeFiles,
    downloadsPath, resultText, verifyWritable,
  };
})();
