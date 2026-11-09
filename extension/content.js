// Content script: remembers the element under the last right-click, and on
// request from the background worker records it. Relies on capture.js, which
// the manifest loads first.
(() => {
  if (globalThis.__domExportContentLoaded) return;
  globalThis.__domExportContentLoaded = true;

  const UI_ATTR = "data-dom-export-ui";
  let lastTarget = null;
  let lastClick = null;

  document.addEventListener("contextmenu", event => {
    const path = event.composedPath ? event.composedPath() : [];
    let target = path.length ? path[0] : event.target;
    if (target && target.nodeType !== Node.ELEMENT_NODE) target = target.parentElement;
    lastTarget = target || null;
    lastClick = {
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
      pageX: Math.round(event.pageX),
      pageY: Math.round(event.pageY),
    };
  }, true);

  function removeUi() {
    for (const node of document.querySelectorAll(`[${UI_ATTR}]`)) node.remove();
  }

  function toast(text, isError) {
    for (const node of document.querySelectorAll(`[${UI_ATTR}="toast"]`)) node.remove();
    const box = document.createElement("div");
    box.setAttribute(UI_ATTR, "toast");
    box.textContent = text;
    box.style.cssText = [
      "all: initial", "position: fixed", "right: 16px", "bottom: 16px",
      "z-index: 2147483647", "max-width: 420px", "padding: 10px 14px",
      "border-radius: 8px", "font: 13px/1.4 system-ui, sans-serif",
      "color: #fff", `background: ${isError ? "#b3261e" : "#1f1f1f"}`,
      "box-shadow: 0 4px 16px rgba(0,0,0,.3)", "word-break: break-word",
      "pointer-events: none",
    ].join(";");
    document.documentElement.appendChild(box);
    setTimeout(() => box.remove(), isError ? 7000 : 4500);
  }

  // Outline drawn as an overlay so the recorded element itself is never modified.
  function flash(el) {
    const r = el.getBoundingClientRect();
    const overlay = document.createElement("div");
    overlay.setAttribute(UI_ATTR, "outline");
    overlay.style.cssText = [
      "all: initial", "position: fixed", "z-index: 2147483646",
      `left: ${r.left - 2}px`, `top: ${r.top - 2}px`,
      `width: ${r.width}px`, `height: ${r.height}px`,
      "border: 2px solid #e8590c", "background: rgba(232, 89, 12, 0.15)",
      "border-radius: 2px", "pointer-events: none",
    ].join(";");
    document.documentElement.appendChild(overlay);
    setTimeout(() => overlay.remove(), 1500);
  }

  async function record() {
    if (!lastTarget || !lastTarget.isConnected) {
      toast("DOM Export could not tell which element was right-clicked. Refresh this page once, then right-click the element again.", true);
      return { ok: false, reason: "no-target" };
    }
    removeUi(); // keep our own toast/outline out of the capture
    const described = describeSelection(lastTarget, lastClick);
    if (!described) {
      toast("DOM Export could not record that element. Try right-clicking it again.", true);
      return { ok: false, reason: "unresolvable-target" };
    }
    const { html, summary } = await capturePage({ selected: described.el });
    flash(described.el);
    return { ok: true, selection: described.record, summary, html };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return;
    if (message.type === "dom-export-record-selection") {
      record()
        .then(sendResponse)
        .catch(err => {
          toast(`DOM Export failed: ${err.message}`, true);
          sendResponse({ ok: false, reason: "error", error: err.message });
        });
      return true; // async response
    }
    if (message.type === "dom-export-toast") {
      toast(message.text, Boolean(message.isError));
      sendResponse({ ok: true });
    }
  });
})();
