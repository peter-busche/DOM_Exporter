// Shared capture library for DOM Export.
//
// Loaded into pages as a content script (see manifest.json) and re-injected
// on demand with chrome.scripting.executeScript({files}). Because it can be
// evaluated more than once in the same page, the top level uses only `var`
// and function declarations, which are safe to redeclare.
//
// Entry points:
//   capturePage({selected})        -> { html, summary }   full page export
//   describeSelection(el, click)   -> selection record for one element

var DX = {
  FORMAT_VERSION: 3,
  MAX_NODES: 20000,
  MAX_TEXT: 200,
  MAX_ATTR: 300,
  MAX_CSS_CHARS: 3000000,
  MAX_OUTER_HTML: 5000,
  MAX_DECLARATIONS: 2000,
  MAX_RULES: 300,
  UI_ATTR: "data-dom-export-ui",

  // Inherited properties: in the tree, recorded only where they differ from the parent.
  INHERITED: [
    "color", "font-family", "font-size", "font-weight", "font-style",
    "line-height", "letter-spacing", "text-align", "text-transform",
    "visibility", "cursor",
  ],
  // Non-inherited properties: in the tree, recorded only where they differ
  // from the browser default for that tag.
  OWN: [
    "display", "position", "background-color", "background-image",
    "margin", "padding", "border-radius", "box-shadow", "opacity",
    "text-decoration-line", "flex-direction", "justify-content",
    "align-items", "gap", "grid-template-columns", "overflow", "z-index",
  ],
  // Properties a rule on an ancestor can pass down to the selected element.
  INHERITED_RULE_PROPS: new Set([
    "color", "line-height", "letter-spacing", "word-spacing", "text-align",
    "text-transform", "text-indent", "white-space", "visibility", "cursor",
    "direction", "list-style-type", "list-style-position", "list-style-image",
  ]),
  SIDES: ["top", "right", "bottom", "left"],
  SKIP_TAGS: new Set(["script", "style", "noscript", "link", "meta", "head", "template", "base", "title"]),
  INTERACTIVE: 'button, a, [role="button"], input[type="submit"], input[type="button"], select, textarea, input',
  INTERACTIVE_STYLES: [
    "color", "background-color", "font-family", "font-size", "font-weight",
    "padding", "border-radius",
  ],
  STATE_RE: /:(hover|focus-visible|focus-within|focus|active|visited|disabled|checked)\b/g,
};

// --- Shared helpers ----------------------------------------------------------

function dxOwnText(el) {
  let t = "";
  for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.nodeValue;
  return t.replace(/\s+/g, " ").trim().slice(0, DX.MAX_TEXT);
}

function dxPathStep(el) {
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

// Parent in the exported tree: the DOM parent, or the host for a shadow-root child.
function dxTreeParent(el) {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode && el.getRootNode();
  return root && root.host ? root.host : null;
}

// The children the exported tree keeps for an element, in order. Both the tree
// walk and dxTreePathOf use this, so tree indexes always agree.
function dxTreeChildren(el) {
  if (el.localName === "svg") return []; // inline SVG internals are not exported
  const out = [];
  const add = (child, shadow) => {
    if (DX.SKIP_TAGS.has(child.localName) || child.hasAttribute(DX.UI_ATTR)) return;
    out.push({ el: child, shadow });
  };
  if (el.shadowRoot) for (const child of el.shadowRoot.children) add(child, true);
  for (const child of el.children) add(child, false);
  return out;
}

// [html, ..., el]
function dxChainOf(el) {
  const chain = [];
  for (let n = el; n; n = dxTreeParent(n)) chain.unshift(n);
  return chain;
}

function dxPathOf(el) {
  return dxChainOf(el).map(dxPathStep).join(" > ");
}

// Child indexes from the tree root (<html>) down to el; [] for <html> itself.
// null if el is not part of the exported tree.
function dxTreePathOf(el) {
  const chain = dxChainOf(el);
  if (chain[0] !== document.documentElement) return null;
  const indexes = [];
  for (let i = 1; i < chain.length; i++) {
    const idx = dxTreeChildren(chain[i - 1]).findIndex(c => c.el === chain[i]);
    if (idx < 0) return null;
    indexes.push(idx);
  }
  return indexes;
}

function dxBoxOf(el) {
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.left + window.scrollX),
    y: Math.round(r.top + window.scrollY),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
}

// Visible borders only: one "border" entry when all four sides match,
// otherwise one entry per side that has a border.
function dxBorderStyles(cs) {
  const out = {};
  const sides = DX.SIDES.map(s =>
    cs.getPropertyValue(`border-${s}-style`) === "none" ? null : cs.getPropertyValue(`border-${s}`));
  if (sides.every(b => b && b === sides[0])) {
    out["border"] = sides[0];
  } else {
    DX.SIDES.forEach((s, i) => { if (sides[i]) out[`border-${s}`] = sides[i]; });
  }
  return out;
}

function dxAttrsOf(el) {
  const attrs = {};
  for (const a of el.attributes) {
    if (a.name === "id" || a.name === "class") continue;
    attrs[a.name] = a.value.slice(0, DX.MAX_ATTR);
  }
  return attrs;
}

// Top-level stylesheets with the name the export uses for each.
function dxListSheets() {
  const out = [];
  let inline = 0;
  for (const sheet of document.styleSheets) {
    out.push({ sheet, source: sheet.href || `inline <style> #${++inline}` });
  }
  let adopted = 0;
  for (const sheet of document.adoptedStyleSheets || []) {
    out.push({ sheet, source: `adopted stylesheet #${++adopted} (constructed in JS)` });
  }
  return out;
}

// "@media (min-width: 600px)" from "@media (min-width: 600px) { ... }"
function dxRulePrelude(rule) {
  const text = rule.cssText;
  const brace = text.indexOf("{");
  return (brace > 0 ? text.slice(0, brace) : text).trim().slice(0, DX.MAX_ATTR);
}

function dxCustomProperties(style) {
  const vars = {};
  for (let i = 0; i < style.length; i++) {
    const name = style[i];
    if (name.startsWith("--")) vars[name] = style.getPropertyValue(name).trim();
  }
  return vars;
}

function dxPageInfo() {
  return {
    formatVersion: DX.FORMAT_VERSION,
    url: location.href,
    title: document.title,
    capturedAt: new Date().toISOString(),
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
    colorScheme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  };
}

// --- Full page export ----------------------------------------------------------

async function capturePage(options) {
  const selected = (options && options.selected) || null;

  // Take the raw markup first, before this function touches the page.
  const html = "<!DOCTYPE html>\n" + document.documentElement.outerHTML;

  // Browser-default styles per tag, measured in a blank iframe.
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
        frame.setAttribute(DX.UI_ATTR, "defaults-probe");
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
        for (const p of DX.OWN) result[p] = cs.getPropertyValue(p);
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
    for (const p of DX.INHERITED) {
      const v = cs.getPropertyValue(p);
      inherited[p] = v;
      if (!parentInherited || parentInherited[p] !== v) styles[p] = v;
    }
    const defaults = defaultsFor(el);
    for (const p of DX.OWN) {
      const v = cs.getPropertyValue(p);
      if (!defaults || defaults[p] !== v) styles[p] = v;
    }
    const borders = dxBorderStyles(cs);
    Object.assign(styles, borders);
    return { styles, inherited, borders, cs };
  }

  // --- Element tree ---
  let nodeCount = 0;
  let truncated = false;
  const images = [];
  const interactiveElements = [];

  function walk(el, parentInherited, parentPath, inShadow) {
    if (nodeCount >= DX.MAX_NODES) { truncated = true; return null; }
    nodeCount++;

    const tag = el.localName;
    const path = parentPath ? `${parentPath} > ${dxPathStep(el)}` : dxPathStep(el);
    const node = { tag };
    if (el === selected) node.selected = true;
    if (inShadow) node.inShadowRoot = true;
    if (el.id) node.id = el.id;
    if (el.classList.length) node.classes = [...el.classList];

    const attrs = dxAttrsOf(el);
    if (Object.keys(attrs).length) node.attrs = attrs;

    const text = dxOwnText(el);
    if (text) node.text = text;

    const { styles, inherited, borders, cs } = stylesFor(el, parentInherited);
    if (Object.keys(styles).length) node.styles = styles;
    const box = dxBoxOf(el);
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
      images.push({ path, kind: "background-image", value: bg.slice(0, DX.MAX_ATTR), box });
    }

    if (el.matches(DX.INTERACTIVE)) {
      const computed = {};
      for (const p of DX.INTERACTIVE_STYLES) computed[p] = cs.getPropertyValue(p);
      Object.assign(computed, borders);
      interactiveElements.push({
        path, tag,
        id: el.id || null,
        classes: [...el.classList],
        text: (el.innerText || el.value || "").trim().slice(0, DX.MAX_TEXT),
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
    for (const child of dxTreeChildren(el)) {
      const c = walk(child.el, inherited, path, child.shadow);
      if (c) children.push(c);
    }
    if (children.length) node.children = children;
    return node;
  }

  // Resolve the selection's location before the probe iframe exists.
  const selection = selected
    ? { path: dxPathOf(selected), treePath: dxTreePathOf(selected) }
    : null;

  const tree = walk(document.documentElement, null, "", false);
  if (frame) frame.remove();

  // --- Stylesheets ---
  const stylesheets = [];
  const cssVariables = [];
  let cssChars = 0;

  function collectVariables(rules, conditions, source) {
    for (const rule of rules) {
      if (rule.style && rule.selectorText) {
        const variables = dxCustomProperties(rule.style);
        if (Object.keys(variables).length) {
          const entry = { selector: rule.selectorText, variables, stylesheet: source };
          if (conditions.length) entry.conditions = conditions;
          cssVariables.push(entry);
        }
      }
      if (rule.cssRules && rule.cssRules.length) {
        collectVariables(rule.cssRules, [...conditions, dxRulePrelude(rule)], source);
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
      const room = Math.max(0, DX.MAX_CSS_CHARS - cssChars);
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
  for (const { sheet, source } of dxListSheets()) {
    await readSheet(sheet, source, seenSheets);
  }

  // --- Fonts ---
  const fonts = [];
  try {
    for (const f of document.fonts) {
      fonts.push({ family: f.family, weight: f.weight, style: f.style, status: f.status });
    }
  } catch (e) { /* ignore */ }

  const summary = {
    ...dxPageInfo(),
    kind: "page-export",
    howToRead: [
      "tree is the full rendered element tree for this one URL, as nested nodes: tag, id, classes, attrs, text (the element's own text), styles, box (page position and size in px), children.",
      "styles holds computed values, kept only where they add information: inherited properties (color, font-family, font-size, ...) appear only where they differ from the parent, so walk up the tree to find the value an element inherits; other properties appear only where they differ from the browser default for that tag. The <html> node lists every inherited property.",
      "Computed values are resolved (var(--bg) shows as an rgb() color). Use cssVariables and stylesheets[].text to see the rules and variables as authored, including hover, dark-mode and breakpoint rules that were not active during capture.",
      "If selection is present, the user right-clicked one element: it is the tree node with selected: true. selection.treePath lists the child indexes to follow from tree (the <html> node) through children[] to reach it, and selection.selectionFile names the companion file describing that element in detail.",
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
  };
  if (selection) summary.selection = selection;
  Object.assign(summary, { fonts, cssVariables, images, interactiveElements, tree, stylesheets });

  return { html, summary };
}

// --- Single element selection -----------------------------------------------------

// The exported tree does not descend into inline SVGs or skipped tags, so a
// right-click on an SVG <path> resolves to its <svg>.
function dxResolveTarget(target) {
  let el = target;
  if (el && el.nodeType !== Node.ELEMENT_NODE) el = el.parentElement;
  if (!el || !el.isConnected) return null;
  if (el.closest(`[${DX.UI_ATTR}]`)) return null;
  let note = null;
  const original = el;
  const svg = el.closest("svg");
  if (svg && svg !== el) {
    el = svg;
    note = `The right-click landed on <${original.localName}> inside an inline SVG; the enclosing <svg> was recorded because SVG internals are not part of the export tree.`;
  }
  while (el && DX.SKIP_TAGS.has(el.localName)) el = dxTreeParent(el);
  return el ? { el, note } : null;
}

// Finds the stylesheet rules that style `el`: rules matching it directly, rules
// on ancestors that set inherited properties, and the CSS variables those use.
function dxMatchRules(el, ancestors) {
  const matched = [];
  const inherited = [];
  const varDefs = [];
  const unreadable = [];
  let capped = false;

  const safeMatches = (node, sel) => { try { return node.matches(sel); } catch (e) { return false; } };

  // "a:hover" does not match an un-hovered link; strip state pseudo-classes
  // to find rules that would apply in that state.
  function stateMatch(selectorText) {
    const states = new Set();
    for (const part of selectorText.split(",")) {
      const found = part.match(DX.STATE_RE);
      if (!found) continue;
      const stripped = part.replace(DX.STATE_RE, "").trim() || "*";
      if (safeMatches(el, stripped)) found.forEach(s => states.add(s.slice(1)));
    }
    return states.size ? [...states] : null;
  }

  function inheritedDeclarations(style) {
    const parts = [];
    for (let i = 0; i < style.length; i++) {
      const name = style[i];
      if (!(name.startsWith("font-") || DX.INHERITED_RULE_PROPS.has(name))) continue;
      const value = style.getPropertyValue(name);
      if (!value) continue;
      parts.push(`${name}: ${value}${style.getPropertyPriority(name) ? " !important" : ""}`);
    }
    return parts.join("; ");
  }

  function handleStyleRule(rule, source, conditions, active) {
    const selector = rule.selectorText;
    const base = () => {
      const entry = { selector, declarations: rule.style.cssText.slice(0, DX.MAX_DECLARATIONS), stylesheet: source };
      if (conditions.length) entry.conditions = conditions;
      entry.active = active;
      return entry;
    };

    const direct = safeMatches(el, selector);
    let onAncestor = null;
    for (let i = ancestors.length - 1; i >= 0 && !onAncestor; i--) {
      if (safeMatches(ancestors[i].el, selector)) onAncestor = ancestors[i];
    }

    const vars = dxCustomProperties(rule.style);
    if (Object.keys(vars).length && (direct || onAncestor)) {
      varDefs.push({ selector, stylesheet: source, conditions, active, vars });
    }

    if (direct) {
      if (matched.length < DX.MAX_RULES) matched.push(base()); else capped = true;
    } else {
      const states = stateMatch(selector);
      if (states) {
        if (matched.length < DX.MAX_RULES) matched.push({ ...base(), state: states }); else capped = true;
      }
    }

    if (onAncestor) {
      const declarations = inheritedDeclarations(rule.style);
      if (declarations) {
        if (inherited.length < DX.MAX_RULES) {
          const entry = { ancestor: onAncestor.path, selector, declarations: declarations.slice(0, DX.MAX_DECLARATIONS), stylesheet: source };
          if (conditions.length) entry.conditions = conditions;
          entry.active = active;
          inherited.push(entry);
        } else {
          capped = true;
        }
      }
    }
  }

  function visit(rules, source, conditions, active) {
    for (const rule of rules) {
      if (rule.styleSheet) { // @import
        let inner = null;
        try { inner = rule.styleSheet.cssRules; } catch (e) { /* cross-origin */ }
        if (inner) visit(inner, rule.styleSheet.href || `@import in ${source}`, conditions, active);
        else unreadable.push(rule.href || `@import in ${source}`);
        continue;
      }
      if (rule.selectorText && rule.style) {
        handleStyleRule(rule, source, conditions, active);
        continue;
      }
      if (rule.cssRules && rule.cssRules.length) {
        let applies = true;
        try {
          if (rule.media) applies = window.matchMedia(rule.media.mediaText).matches;
          else if (rule.constructor && rule.constructor.name === "CSSSupportsRule") applies = CSS.supports(rule.conditionText);
        } catch (e) { /* treat as applying */ }
        visit(rule.cssRules, source, [...conditions, dxRulePrelude(rule)], active && applies);
      }
    }
  }

  for (const { sheet, source } of dxListSheets()) {
    let rules = null;
    try { rules = sheet.cssRules; } catch (e) { /* cross-origin */ }
    if (!rules) { unreadable.push(source); continue; }
    let active = !sheet.disabled;
    try {
      const media = sheet.media && sheet.media.mediaText;
      if (media) active = active && window.matchMedia(media).matches;
    } catch (e) { /* ignore */ }
    visit(rules, source, [], active);
  }

  // CSS variables referenced by those rules, followed through a few levels.
  const VAR_RE = /var\(\s*(--[\w-]+)/g;
  const wanted = new Set();
  const scan = text => { for (const m of text.matchAll(VAR_RE)) wanted.add(m[1]); };
  matched.forEach(r => scan(r.declarations));
  inherited.forEach(r => scan(r.declarations));
  for (let round = 0; round < 4; round++) {
    const before = wanted.size;
    for (const def of varDefs) {
      for (const [name, value] of Object.entries(def.vars)) if (wanted.has(name)) scan(value);
    }
    if (wanted.size === before) break;
  }
  const variables = [];
  for (const name of [...wanted].sort()) {
    const definitions = [];
    for (const def of varDefs) {
      if (!(name in def.vars)) continue;
      const d = { value: def.vars[name], selector: def.selector, stylesheet: def.stylesheet };
      if (def.conditions.length) d.conditions = def.conditions;
      d.active = def.active;
      definitions.push(d);
    }
    variables.push({ name, definitions });
  }

  return { matched, inherited, variables, unreadable, capped };
}

function describeSelection(target, click) {
  const resolved = dxResolveTarget(target);
  if (!resolved) return null;
  const el = resolved.el;

  const chain = dxChainOf(el);
  let path = "";
  const withPaths = chain.map(node => {
    path = path ? `${path} > ${dxPathStep(node)}` : dxPathStep(node);
    return { el: node, path };
  });
  const ancestorEntries = withPaths.slice(0, -1);

  const cs = getComputedStyle(el);
  const computedStyles = {};
  for (const p of [...DX.INHERITED, ...DX.OWN]) computedStyles[p] = cs.getPropertyValue(p);
  Object.assign(computedStyles, dxBorderStyles(cs));

  const outerHTML = el.outerHTML;
  const element = {
    tag: el.localName,
    id: el.id || null,
    classes: [...el.classList],
    attrs: dxAttrsOf(el),
    text: dxOwnText(el),
    innerText: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, DX.MAX_TEXT),
    box: dxBoxOf(el),
    computedStyles,
    outerHTML: outerHTML.slice(0, DX.MAX_OUTER_HTML),
  };
  if (outerHTML.length > DX.MAX_OUTER_HTML) element.outerHTMLTruncated = true;

  const rules = dxMatchRules(el, ancestorEntries);

  const dataAttributes = {};
  for (const [name, value] of Object.entries(element.attrs)) {
    if (name.startsWith("data-")) dataAttributes[name] = value;
  }
  const searchHints = {
    text: element.innerText || null,
    id: element.id,
    classes: element.classes,
    dataAttributes,
    cssSelectors: [...new Set(rules.matched.map(r => r.selector))],
    cssVariables: rules.variables.map(v => v.name),
    ancestorClasses: [...new Set(ancestorEntries.flatMap(a => [...a.el.classList]))],
  };

  const record = {
    ...dxPageInfo(),
    kind: "selection",
    howToRead: [
      "This file describes the one element the user right-clicked. path is its selector path; treePath lists the child indexes to follow from tree (the <html> node) through children[] in the full export named by fullExportFile, where the same node carries selected: true.",
      "element.computedStyles are the final resolved values. matchedCssRules are the stylesheet rules whose selector matches the element, in stylesheet order (for equal specificity, later rules win). Entries with state apply only in that state (e.g. hover). Entries with active: false sit inside a media query or stylesheet that did not apply during capture (e.g. dark mode).",
      "inheritedCssRules are rules on ancestors that set inherited properties such as font-family and color; they explain values the element has without any rule of its own.",
      "cssVariablesUsed resolves each var(--name) referenced by those rules to where it is defined.",
      "To change this element in source code, search the repo for the strings in searchHints: text, classes and CSS selectors are the most reliable. Built stylesheet names are hashed (index-AbC123.css is usually index.css in source).",
    ],
    click: click || null,
    path: withPaths[withPaths.length - 1].path,
    treePath: dxTreePathOf(el),
    element,
    ancestors: ancestorEntries.map(a => ({
      tag: a.el.localName,
      id: a.el.id || null,
      classes: [...a.el.classList],
      path: a.path,
    })),
    matchedCssRules: rules.matched,
    inheritedCssRules: rules.inherited,
    cssVariablesUsed: rules.variables,
    searchHints,
  };
  if (resolved.note) record.note = resolved.note;
  if (rules.unreadable.length) record.unreadableStylesheets = rules.unreadable;
  if (rules.capped) record.rulesCapped = true;

  return { el, record };
}
