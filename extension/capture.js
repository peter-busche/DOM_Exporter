// capturePage runs inside the inspected page via chrome.scripting.executeScript.
// It is serialized and injected, so it must be fully self-contained: no
// references to anything outside the function body.
async function capturePage() {
  const FORMAT_VERSION = 2;
  const MAX_NODES = 20000;
  const MAX_TEXT = 200;
  const MAX_ATTR = 300;
  const MAX_CSS_CHARS = 3000000;

  // Inherited properties are recorded only where they differ from the parent.
  const INHERITED = [
    "color", "font-family", "font-size", "font-weight", "font-style",
    "line-height", "letter-spacing", "text-align", "text-transform",
    "visibility", "cursor",
  ];
  // Non-inherited properties are recorded only where they differ from the
  // browser default for that tag.
  const OWN = [
    "display", "position", "background-color", "background-image",
    "margin", "padding", "border-radius", "box-shadow", "opacity",
    "text-decoration-line", "flex-direction", "justify-content",
    "align-items", "gap", "grid-template-columns", "overflow", "z-index",
  ];
  const SIDES = ["top", "right", "bottom", "left"];
  const SKIP_TAGS = new Set(["script", "style", "noscript", "link", "meta", "head", "template", "base", "title"]);
  const INTERACTIVE = 'button, a, [role="button"], input[type="submit"], input[type="button"], select, textarea, input';
  const INTERACTIVE_STYLES = [
    "color", "background-color", "font-family", "font-size", "font-weight",
    "padding", "border-radius",
  ];

  // Take the raw markup first, before this function touches the page.
  const html = "<!DOCTYPE html>\n" + document.documentElement.outerHTML;

  // --- Browser-default styles per tag, measured in a blank iframe -----------
  let frame = null;
  let frameDoc = null;
  let frameFailed = false;
  const defaultCache = new Map();

  function defaultsFor(el) {
    const key = el.namespaceURI + "|" + el.localName;
    if (defaultCache.has(key)) return defaultCache.get(key);
    let result = null;
    try {
      if (!frame && !frameFailed) {
        frame = document.createElement("iframe");
        frame.setAttribute("aria-hidden", "true");
        frame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
        document.documentElement.appendChild(frame);
        frameDoc = frame.contentDocument;
        if (!frameDoc || !frameDoc.body) throw new Error("no iframe document");
      }
      if (frameDoc) {
        const probe = frameDoc.createElementNS(el.namespaceURI, el.localName);
        frameDoc.body.appendChild(probe);
        const cs = frameDoc.defaultView.getComputedStyle(probe);
        result = {};
        for (const p of OWN) result[p] = cs.getPropertyValue(p);
        probe.remove();
      }
    } catch (e) {
      frameFailed = true;
      frameDoc = null;
      result = null;
    }
    defaultCache.set(key, result);
    return result;
  }

  function stylesFor(el, parentInherited) {
    const cs = getComputedStyle(el);
    const styles = {};
    const inherited = {};
    for (const p of INHERITED) {
      const v = cs.getPropertyValue(p);
      inherited[p] = v;
      if (!parentInherited || parentInherited[p] !== v) styles[p] = v;
    }
    const defaults = defaultsFor(el);
    for (const p of OWN) {
      const v = cs.getPropertyValue(p);
      if (!defaults || defaults[p] !== v) styles[p] = v;
    }
    const borders = borderStyles(cs);
    Object.assign(styles, borders);
    return { styles, inherited, borders, cs };
  }

  // Visible borders only: one "border" entry when all four sides match,
  // otherwise one entry per side that has a border.
  function borderStyles(cs) {
    const out = {};
    const sides = SIDES.map(s =>
      cs.getPropertyValue(`border-${s}-style`) === "none" ? null : cs.getPropertyValue(`border-${s}`));
    if (sides.every(b => b && b === sides[0])) {
      out["border"] = sides[0];
    } else {
      SIDES.forEach((s, i) => { if (sides[i]) out[`border-${s}`] = sides[i]; });
    }
    return out;
  }

  // --- Element tree ----------------------------------------------------------
  let nodeCount = 0;
  let truncated = false;
  const images = [];
  const interactiveElements = [];

  function ownText(el) {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.nodeValue;
    return t.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  }

  function pathStep(el) {
    let step = el.localName;
    if (el.id) {
      step += "#" + el.id;
    } else if (el.classList.length) {
      step += "." + [...el.classList].slice(0, 3).join(".");
    }
    const parent = el.parentElement;
    if (parent && !el.id) {
      const same = [...parent.children].filter(c => c.localName === el.localName);
      if (same.length > 1) step += `:nth-of-type(${same.indexOf(el) + 1})`;
    }
    return step;
  }

  function boxOf(el) {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + window.scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  }

  function walk(el, parentInherited, parentPath, inShadow) {
    if (nodeCount >= MAX_NODES) { truncated = true; return null; }
    nodeCount++;

    const tag = el.localName;
    const path = parentPath ? `${parentPath} > ${pathStep(el)}` : pathStep(el);
    const node = { tag };
    if (inShadow) node.inShadowRoot = true;
    if (el.id) node.id = el.id;
    if (el.classList.length) node.classes = [...el.classList];

    const attrs = {};
    for (const a of el.attributes) {
      if (a.name === "id" || a.name === "class") continue;
      attrs[a.name] = a.value.slice(0, MAX_ATTR);
    }
    if (Object.keys(attrs).length) node.attrs = attrs;

    const text = ownText(el);
    if (text) node.text = text;

    const { styles, inherited, borders, cs } = stylesFor(el, parentInherited);
    if (Object.keys(styles).length) node.styles = styles;
    const box = boxOf(el);
    node.box = box;

    if (tag === "img") {
      images.push({
        path, kind: "img",
        src: el.currentSrc || el.src || null,
        alt: el.getAttribute("alt"),
        naturalWidth: el.naturalWidth, naturalHeight: el.naturalHeight,
        box,
      });
    } else if (tag === "svg") {
      images.push({
        path, kind: "inline-svg",
        ariaLabel: el.getAttribute("aria-label"),
        viewBox: el.getAttribute("viewBox"),
        box,
      });
    }
    const bg = cs.getPropertyValue("background-image");
    if (bg && bg !== "none") {
      images.push({ path, kind: "background-image", value: bg.slice(0, MAX_ATTR), box });
    }

    if (el.matches(INTERACTIVE)) {
      const computed = {};
      for (const p of INTERACTIVE_STYLES) computed[p] = cs.getPropertyValue(p);
      Object.assign(computed, borders);
      interactiveElements.push({
        path, tag,
        id: el.id || null,
        classes: [...el.classList],
        text: (el.innerText || el.value || "").trim().slice(0, MAX_TEXT),
        ariaLabel: el.getAttribute("aria-label"),
        href: el.getAttribute("href"),
        computedStyles: computed,
      });
    }

    // Inline SVG internals are mostly path data; record the count and stop.
    if (tag === "svg") {
      node.childElementCount = el.childElementCount;
      return node;
    }

    const children = [];
    const visit = (child, shadow) => {
      if (child === frame || SKIP_TAGS.has(child.localName)) return;
      const c = walk(child, inherited, path, shadow);
      if (c) children.push(c);
    };
    if (el.shadowRoot) for (const child of [...el.shadowRoot.children]) visit(child, true);
    for (const child of [...el.children]) visit(child, false);
    if (children.length) node.children = children;
    return node;
  }

  const tree = walk(document.documentElement, null, "", false);
  if (frame) frame.remove();

  // --- Stylesheets -------------------------------------------------------------
  const stylesheets = [];
  const cssVariables = [];
  let cssChars = 0;

  function collectVariables(rules, conditions, source) {
    for (const rule of rules) {
      if (rule.style && rule.selectorText) {
        const variables = {};
        for (let i = 0; i < rule.style.length; i++) {
          const name = rule.style[i];
          if (name.startsWith("--")) variables[name] = rule.style.getPropertyValue(name).trim();
        }
        if (Object.keys(variables).length) {
          const entry = { selector: rule.selectorText, variables, stylesheet: source };
          if (conditions.length) entry.conditions = conditions;
          cssVariables.push(entry);
        }
      }
      if (rule.cssRules && rule.cssRules.length) {
        const brace = rule.cssText.indexOf("{");
        const label = (brace > 0 ? rule.cssText.slice(0, brace) : rule.cssText).trim().slice(0, MAX_ATTR);
        collectVariables(rule.cssRules, [...conditions, label], source);
      }
    }
  }

  async function readSheet(sheet, origin, seen) {
    if (seen.has(sheet)) return;
    seen.add(sheet);
    const source = sheet.href || origin;
    const info = { source };
    const media = sheet.media && sheet.media.mediaText;
    if (media) info.media = media;
    if (sheet.disabled) info.disabled = true;

    let rules = null;
    try { rules = sheet.cssRules; } catch (e) { /* cross-origin sheet */ }

    let text = null;
    if (rules) {
      text = [...rules].map(r => r.cssText).join("\n");
      info.readVia = "cssRules";
      try { collectVariables(rules, [], source); } catch (e) { /* ignore */ }
    } else if (sheet.href) {
      try {
        const res = await fetch(sheet.href);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await res.text();
        info.readVia = "fetch";
      } catch (e) {
        info.error = `Cross-origin stylesheet could not be read (${e.message}). Open the URL directly to see it.`;
      }
    }
    if (text !== null) {
      const room = Math.max(0, MAX_CSS_CHARS - cssChars);
      if (text.length > room) { text = text.slice(0, room); info.truncated = true; }
      cssChars += text.length;
      info.text = text;
    }
    stylesheets.push(info);

    if (rules) {
      for (const rule of rules) {
        if (rule.styleSheet) await readSheet(rule.styleSheet, `@import in ${source}`, seen);
      }
    }
  }

  const seenSheets = new Set();
  let inlineIndex = 0;
  for (const sheet of document.styleSheets) {
    await readSheet(sheet, `inline <style> #${++inlineIndex}`, seenSheets);
  }
  for (const sheet of document.adoptedStyleSheets || []) {
    await readSheet(sheet, "adopted stylesheet (constructed in JS)", seenSheets);
  }

  // --- Fonts -------------------------------------------------------------------
  const fonts = [];
  try {
    for (const f of document.fonts) {
      fonts.push({ family: f.family, weight: f.weight, style: f.style, status: f.status });
    }
  } catch (e) { /* ignore */ }

  const summary = {
    formatVersion: FORMAT_VERSION,
    url: location.href,
    title: document.title,
    capturedAt: new Date().toISOString(),
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
    colorScheme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    howToRead: [
      "tree is the full rendered element tree for this one URL, as nested nodes: tag, id, classes, attrs, text (the element's own text), styles, box (page position and size in px), children.",
      "styles holds computed values, kept only where they add information: inherited properties (color, font-family, font-size, ...) appear only where they differ from the parent, so walk up the tree to find the value an element inherits; other properties appear only where they differ from the browser default for that tag. The <html> node lists every inherited property.",
      "Computed values are resolved (var(--bg) shows as an rgb() color). Use cssVariables and stylesheets[].text to see the rules and variables as authored, including hover, dark-mode and breakpoint rules that were not active during capture.",
      "This is the rendered output, not source code. Class names, text, ids and data attributes are the best strings to search for in the repo.",
    ],
    limitations: [
      "Only the current URL in its current state is captured: other routes, logged-in views, open menus and modals need separate exports.",
      "Computed styles reflect the colorScheme and viewport listed above only.",
      "No JavaScript, event handlers, API calls or application state are captured.",
      "Image and font files are referenced by URL, not embedded.",
      "Iframe contents, closed shadow roots and styles inside shadow roots are not captured.",
    ],
    counts: {
      elements: nodeCount,
      treeTruncated: truncated,
      interactiveElements: interactiveElements.length,
      images: images.length,
      stylesheets: stylesheets.length,
      stylesheetsUnreadable: stylesheets.filter(s => s.error).length,
    },
    fonts,
    cssVariables,
    images,
    interactiveElements,
    tree,
    stylesheets,
  };

  return { html, summary };
}
