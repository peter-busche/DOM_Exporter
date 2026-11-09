// Offscreen document: turns text into blob: URLs for the background worker,
// which has no access to URL.createObjectURL.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "dom-export-offscreen") return;
  if (message.type === "make-blob-url") {
    const url = URL.createObjectURL(new Blob([message.text], { type: message.mime }));
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
    sendResponse({ url });
  }
});
