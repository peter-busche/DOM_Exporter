// Settings page: pick the save folder, re-approve access, set the subfolder.
// The folder picker lives here, not in the popup, because opening a system
// dialog closes an extension popup and discards the result.

const els = {
  location: document.getElementById("location"),
  badge: document.getElementById("badge"),
  detail: document.getElementById("detail"),
  choose: document.getElementById("choose"),
  allow: document.getElementById("allow"),
  clear: document.getElementById("clear"),
  message: document.getElementById("message"),
  label: document.getElementById("label"),
};

const pickerSupported = typeof window.showDirectoryPicker === "function";

function say(text, isError) {
  els.message.textContent = text || "";
  els.message.classList.toggle("error", Boolean(isError));
}

function setBadge(text, kind) {
  els.badge.hidden = !text;
  els.badge.textContent = text || "";
  els.badge.className = "badge" + (kind ? " " + kind : "");
}

async function refresh() {
  const info = await DXStore.describe();
  els.location.textContent = info.display;
  els.clear.hidden = info.mode !== "folder";
  els.allow.hidden = !(info.mode === "folder" && info.permission !== "granted");

  if (info.mode === "downloads") {
    setBadge("", "");
    els.detail.textContent = pickerSupported
      ? "No folder chosen, so files are saved to your browser's Downloads folder."
      : "This browser does not support choosing a folder, so files are saved to your Downloads folder.";
  } else if (info.permission === "granted") {
    setBadge("Access allowed", "ok");
    els.detail.textContent = `Files are written directly into the folder "${info.folderName}"` + (info.label ? `, in the subfolder "${info.label}".` : ".");
  } else {
    setBadge("Needs re-approval", "warn");
    els.detail.textContent = `Chrome needs you to approve access to "${info.folderName}" again. Until you do, files are saved to Downloads` + (info.label ? `/${info.label}.` : ".");
  }
  els.choose.disabled = !pickerSupported;
  els.choose.textContent = info.mode === "folder" ? "Choose a different folder…" : "Choose folder…";
  return info;
}

els.choose.addEventListener("click", async () => {
  say("");
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: "dom-export", mode: "readwrite" });
  } catch (e) {
    if (e && e.name === "AbortError") return; // dialog cancelled
    say(`Could not open the folder picker: ${e.message}`, true);
    return;
  }
  const permission = await DXStore.permissionOf(handle);
  if (permission !== "granted") {
    say(`Chrome did not grant write access to "${handle.name}", so the save location was not changed.`, true);
    return;
  }
  const check = await DXStore.verifyWritable(handle);
  if (!check.ok) {
    say(`"${handle.name}" was chosen but a test write failed (${check.error}), so the save location was not changed.`, true);
    return;
  }
  await DXStore.setFolder(handle);
  await refresh();
  say(`Exports will now be saved to "${handle.name}". A test write succeeded.`);
});

els.allow.addEventListener("click", async () => {
  say("");
  const { handle } = await DXStore.getConfig();
  if (!handle) { await refresh(); return; }
  const permission = await DXStore.requestPermission(handle);
  await refresh();
  if (permission === "granted") say(`Access to "${handle.name}" allowed.`);
  else say(`Access to "${handle.name}" was not allowed. Exports will keep going to Downloads.`, true);
});

els.clear.addEventListener("click", async () => {
  await DXStore.clearFolder();
  await refresh();
  say("Exports will be saved to your Downloads folder.");
});

let labelTimer = null;
els.label.addEventListener("input", () => {
  clearTimeout(labelTimer);
  labelTimer = setTimeout(async () => {
    await DXStore.setLabel(els.label.value);
    await refresh();
  }, 200);
});
els.label.addEventListener("blur", async () => {
  clearTimeout(labelTimer);
  await DXStore.setLabel(els.label.value);
  const info = await refresh();
  els.label.value = info.label; // show the cleaned-up form
});

(async () => {
  const info = await refresh();
  els.label.value = info.label;
})();

// Keep the display current if the popup changes the subfolder while this tab is open.
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") return;
  const info = await refresh();
  if (document.activeElement !== els.label) els.label.value = info.label;
});
