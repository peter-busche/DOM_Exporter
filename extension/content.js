// Content script: highlights and remembers the element under the last
// right-click, and on request from the background worker records it. Relies on
// capture.js, which the manifest loads first.
(() => {
  if (globalThis.__domExportContentLoaded) return;
  globalThis.__domExportContentLoaded = true;

  const UI_ATTR = "data-dom-export-ui";
  let lastTarget = null;
  let lastClick = null;

  // The element an event really landed on, looking through open shadow roots.
  function targetOf(event) {
    const path = event.composedPath ? event.composedPath() : [];
    let target = path.length ? path[0] : event.target;
    if (target && target.nodeType !== Node.ELEMENT_NODE) target = target.parentElement;
    return target || null;
  }

  // --- Right-click preview highlight ------------------------------------------
  // Shows which element "record this element" would capture, from the moment
  // the right button goes down until the menu is dismissed. It is drawn as an
  // overlay (never by styling the element) and is removed before any capture.

  let highlight = null; // { el, nodes, at, x, y }
  // True once the contextmenu event has fired for the current right-click. From
  // then on the element to record is fixed, so the highlight must not move.
  let highlightLocked = false;

  function hideHighlight() {
    if (!highlight) return;
    for (const node of highlight.nodes) node.remove();
    highlight = null;
  }

  function showHighlight(target, x, y) {
    // Resolve exactly as recording does, so the preview matches the result
    // (e.g. a click inside an inline SVG resolves to the <svg>).
    const resolved = target && typeof dxResolveTarget === "function" ? dxResolveTarget(target) : null;
    if (!resolved) { hideHighlight(); return; }
    const el = resolved.el;
    if (highlight && highlight.el === el) { highlight.x = x; highlight.y = y; return; }
    hideHighlight();

    const r = el.getBoundingClientRect();
    const box = document.createElement("div");
    box.setAttribute(UI_ATTR, "highlight");
    box.style.cssText = [
      "all: initial", "position: fixed", "z-index: 2147483646", "box-sizing: border-box",
      `left: ${r.left}px`, `top: ${r.top}px`,
      `width: ${r.width}px`, `height: ${r.height}px`,
      "outline: 2px solid #1a73e8", "background: rgba(26, 115, 232, 0.18)",
      "pointer-events: none",
    ].join(";");

    const name = el.localName
      + (el.id ? "#" + el.id : "")
      + [...el.classList].slice(0, 3).map(c => "." + c).join("");
    const label = document.createElement("div");
    label.setAttribute(UI_ATTR, "highlight-label");
    label.textContent = `${name}   ${Math.round(r.width)} × ${Math.round(r.height)}`;
    const above = r.top >= 26;
    label.style.cssText = [
      "all: initial", "position: fixed", "z-index: 2147483647",
      `left: ${Math.max(2, Math.min(r.left, window.innerWidth - 60))}px`,
      `top: ${above ? r.top - 24 : Math.max(2, r.top + 2)}px`,
      "max-width: min(520px, 90vw)", "padding: 3px 7px", "border-radius: 4px",
      "font: 12px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace",
      "color: #fff", "background: #1a73e8", "white-space: nowrap",
      "overflow: hidden", "text-overflow: ellipsis", "pointer-events: none",
    ].join(";");

    document.documentElement.appendChild(box);
    document.documentElement.appendChild(label);
    highlight = { el, nodes: [box, label], at: performance.now(), x, y };
  }

  // Right button down: highlight straight away. On Windows and Linux the menu
  // opens on release, so the highlight also follows the mouse while it is held.
  document.addEventListener("mousedown", event => {
    highlightLocked = false;
    if (event.button === 2) showHighlight(targetOf(event), event.clientX, event.clientY);
    else hideHighlight();
  }, true);

  document.addEventListener("mousemove", event => {
    if (!highlight) return;
    if (event.buttons & 2) {
      if (!highlightLocked) showHighlight(targetOf(event), event.clientX, event.clientY);
      return;
    }
    // The page gets no mouse events while the menu is open, so real movement
    // here means the menu has closed. Ignore jitter right after the click.
    if (performance.now() - highlight.at < 300) return;
    if (Math.hypot(event.clientX - highlight.x, event.clientY - highlight.y) < 6) return;
    hideHighlight();
  }, true);

  document.addEventListener("contextmenu", event => {
    lastTarget = targetOf(event);
    lastClick = {
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
      pageX: Math.round(event.pageX),
      pageY: Math.round(event.pageY),
    };
    showHighlight(lastTarget, event.clientX, event.clientY);
    highlightLocked = true;
    // A page that replaces the browser menu with its own never shows our item.
    setTimeout(() => { if (event.defaultPrevented) hideHighlight(); }, 0);
  }, true);

  // The overlay is positioned once, so drop it when the page moves under it.
  for (const type of ["keydown", "wheel", "scroll"]) {
    document.addEventListener(type, hideHighlight, { capture: true, passive: true });
  }
  window.addEventListener("resize", hideHighlight, { passive: true });

  function removeUi() {
    hideHighlight();
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
    // Longer messages (e.g. "saved to Downloads because...") stay up longer.
    const readingTime = Math.min(15000, Math.max(4500, text.length * 55));
    setTimeout(() => box.remove(), isError ? Math.max(7000, readingTime) : readingTime);
  }

  // Orange "recorded" confirmation, shown after capture. Drawn as an overlay so
  // the recorded element itself is never modified.
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
