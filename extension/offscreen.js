// Offscreen document: saves files on behalf of the background worker. It tries
// the folder the user chose (see filestore.js); if that is not possible it
// returns blob: URLs so the background worker can use chrome.downloads, which
// a service worker cannot do on its own for large files.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "dom-export-offscreen") return;
  if (message.type === "save-files") {
    saveFiles(message.files)
      .then(sendResponse)
      .catch(err => {
        const result = { saved: false, reason: "error", error: err.message || String(err), label: "", folderName: null };
        result.message = DXStore.resultText(result, message.files.length);
        result.fallback = blobUrls(message.files).map(f => ({ url: f.url, filename: f.name }));
        sendResponse(result);
      });
    return true; // async response
  }
});

function blobUrls(files) {
  return files.map(file => {
    const url = URL.createObjectURL(new Blob([file.text], { type: file.mime }));
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
    return { name: file.name, url };
  });
}

async function saveFiles(files) {
  const result = await DXStore.writeFiles(files);
  result.message = DXStore.resultText(result, files.length);
  if (!result.saved) {
    result.fallback = blobUrls(files).map(f => ({ url: f.url, filename: DXStore.downloadsPath(result, f.name) }));
  }
  return result;
}
