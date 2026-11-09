# DOM Export (Chrome extension)

Exports what the browser rendered for a page, so you can work out where a UI element is defined in a frontend repo, or hand the files to an AI assistant along with the question. It does two things:

- **Record one element:** right-click anything on the page and choose **DOM Export: record this element**. You get a small file describing exactly that element and the CSS rules that style it, plus a full page export with the element flagged.
- **Export the whole page:** click the extension icon, then **Export**.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the extension from the puzzle-piece menu if you want it visible.

After installing, or after changing the extension's files and clicking the reload icon on its card, **refresh any tabs that were already open**. The right-click feature only works in tabs loaded after the extension was (re)loaded.

Requires Chrome 116 or later.

## Record one element (right-click)

1. Right-click the thing you want to change: a button, a heading, an image.
2. Choose **DOM Export: record this element**.
3. The element flashes orange, a message appears in the bottom-right corner, and three files download with one shared name:
   - `dom-export-<host>-<timestamp>.selection.json`: the element you clicked. Start here.
   - `dom-export-<host>-<timestamp>.json`: the full page export taken at the same instant, with the element marked `"selected": true`.
   - `dom-export-<host>-<timestamp>.html`: the raw markup.

### What the selection file contains

| Key | Contents |
| --- | --- |
| `path` | Selector path from `<html>` down to the element, in the same format the full export uses. |
| `treePath` | Child indexes to follow from `tree` through `children[]` in the full export to reach the element. `[0, 0, 0, 1, 1]` means `tree.children[0].children[0].children[0].children[1].children[1]`. |
| `fullExportFile`, `htmlFile` | Names of the companion files. |
| `click` | Where on the page the right-click happened. |
| `element` | Tag, id, classes, attributes, text, position and size, every tracked computed style, and its `outerHTML`. |
| `ancestors` | Every parent from `<html>` down, with classes and path. Useful when the click landed on something small inside the thing you meant, such as a `<span>` inside a button. |
| `matchedCssRules` | The stylesheet rules whose selector matches the element, with their declarations and source stylesheet. `state: ["hover"]` marks rules that apply only in that state; `active: false` marks rules inside a media query that did not apply during capture, such as dark mode. |
| `inheritedCssRules` | Rules on ancestors that set inherited properties such as `font-family` and `color`. |
| `cssVariablesUsed` | Where each `var(--name)` used by those rules is defined, including dark-mode values. |
| `searchHints` | The strings worth searching for in your repo: text, id, classes, data attributes, CSS selectors. |

### Example: "change this nav link's color"

Right-click the link and open the `.selection.json`. `matchedCssRules` shows `.nav a { color: var(--muted); ... }`, and `cssVariablesUsed` shows `--muted: #5f5f5a` defined on `:root`. Search the repo for `.nav a` or `--muted` to find the line to edit.

## Export the whole page (popup)

1. Open the page and let it finish loading.
2. Click the **DOM Export** icon, then **Export**.
3. Two files download: `dom-export-<host>-<timestamp>.json` and `.html`.

### What the full export JSON contains

| Key | Contents |
| --- | --- |
| `url`, `title`, `capturedAt`, `viewport`, `colorScheme` | What was captured and under which conditions. |
| `howToRead`, `limitations` | Short notes for whoever (or whatever) reads the file. |
| `selection` | Present only for right-click recordings: `path`, `treePath` and `selectionFile`. |
| `tree` | Every rendered element as nested nodes: `tag`, `id`, `classes`, `attrs`, `text`, `styles`, `box` (page position and size in px), `children`. |
| `interactiveElements` | Flat list of buttons, links and form controls with a selector `path`, text and key computed styles. |
| `images` | Every `<img>`, inline `<svg>` and CSS background image, with `src` and position. |
| `cssVariables` | Custom properties (`--name`) from every rule that defines them, with any `@media` condition. |
| `stylesheets` | The text of every stylesheet, one rule per line. |
| `fonts` | Web fonts registered on the page and whether they loaded. |

### How `styles` is trimmed in the tree

Each tree node's `styles` holds computed values, kept only where they add information:

- Inherited properties (`color`, `font-family`, `font-size`, ...) appear only where they differ from the parent. To find the font an element uses, walk up the tree to the nearest ancestor that lists it. The `<html>` node lists all of them.
- Other properties (`background-color`, `display`, `padding`, ...) appear only where they differ from the browser default for that tag.

The selection file does not trim: `element.computedStyles` lists every tracked property.

Computed values are resolved: `var(--bg)` shows as an `rgb()` color. The stylesheet text, `matchedCssRules` and `cssVariables` show the rules as written.

## Finding the code

- Search your repo for the element's text, class names, `id` or `data-*` values.
- Search for the CSS selector from `matchedCssRules` to find the rule that sets the property.
- If class names look hashed (for example `css-1x2y3z`, or CSS modules), search for the text or a `data-testid` instead.
- Built file names are hashed too: `index-CGk-Fgzo.css` in the export is usually `index.css` in the source.

## Permissions

| Permission | Why |
| --- | --- |
| Runs on all sites (content script) | Chrome does not tell an extension which element was right-clicked, so a small script on each page remembers the element under the last right-click. It does nothing else until you pick the menu item, and sends nothing anywhere. |
| `contextMenus` | Adds the right-click menu item. |
| `downloads`, `offscreen` | Saves the files. The offscreen page exists only to prepare large files for download. |
| `activeTab`, `scripting` | Lets the popup's Export button read the current tab. |

To limit the extension to particular sites, replace `<all_urls>` in `manifest.json` with patterns such as `https://peter-busche.com/*`.

## Limitations

- Only the current URL in its current state is captured. Other routes, logged-in views, open menus and modals need separate exports.
- Computed styles reflect one color scheme and one viewport size. The stylesheet text still shows the dark-mode, hover and breakpoint rules.
- No JavaScript, event handlers, API calls or application state are captured, so the export cannot rebuild a working site.
- Images and fonts are referenced by URL, not embedded.
- Sites that replace the browser's right-click menu with their own will not show the menu item.
- Right-clicking inside an iframe records that frame's document only.
- A right-click on the inside of an inline SVG records the enclosing `<svg>`; the selection file's `note` says so.
- Closed shadow roots resolve to their host element. Styles declared inside shadow roots are not captured.
- A stylesheet served from another origin without CORS headers cannot be read or rule-matched; it is listed as unreadable with its URL.
- Chrome's own pages (`chrome://`, the Web Store) cannot be exported.
- The tree stops at 20,000 elements, stylesheet text at 3 MB and matched rules at 300; `counts.treeTruncated`, `stylesheets[].truncated` and `rulesCapped` flag this.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Extension manifest (Manifest V3). |
| `capture.js` | Capture library: `capturePage()` for the full export, `describeSelection()` for one element. |
| `content.js` | Runs in each page: remembers the right-clicked element, shows the outline and message. |
| `background.js` | Service worker: owns the menu item and saves the files. |
| `offscreen.html`, `offscreen.js` | Helper page that prepares large files for download. |
| `popup.html`, `popup.js` | The Export button. |
