# DOM Export (Chrome extension)

Exports what the browser rendered for the current tab: the full element tree with computed styles, the text of every stylesheet, CSS variables, images and fonts. Use it to work out where a UI element is defined in a frontend repo, or hand the JSON to an AI assistant along with the question.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the extension from the puzzle-piece menu if you want it visible.

After changing the extension's files, click the reload icon on its card in `chrome://extensions`.

## Use

1. Open the page you want to inspect and let it finish loading.
2. Click the **DOM Export** icon, then **Export**.
3. Two files download:
   - `dom-export-<host>-<timestamp>.json`: the structured export. This is the one to search or share; it is self-contained.
   - `dom-export-<host>-<timestamp>.html`: the raw markup, the same as "Copy outerHTML" on `<html>` in DevTools.

## What the JSON contains

| Key | Contents |
| --- | --- |
| `url`, `title`, `capturedAt`, `viewport`, `colorScheme` | What was captured and under which conditions. |
| `howToRead`, `limitations` | Short notes for whoever (or whatever) reads the file. |
| `tree` | Every rendered element as nested nodes: `tag`, `id`, `classes`, `attrs`, `text`, `styles`, `box` (page position and size in px), `children`. |
| `interactiveElements` | Flat list of buttons, links and form controls with a selector `path`, text and key computed styles. |
| `images` | Every `<img>`, inline `<svg>` and CSS background image, with `src` and position. |
| `cssVariables` | Custom properties (`--name`) from every rule that defines them, with any `@media` condition, so light and dark values both appear. |
| `stylesheets` | The text of every stylesheet, one rule per line. |
| `fonts` | Web fonts registered on the page and whether they loaded. |

### How `styles` is trimmed

Each node's `styles` holds computed values, kept only where they add information:

- Inherited properties (`color`, `font-family`, `font-size`, ...) appear only where they differ from the parent. To find the font an element uses, walk up the tree to the nearest ancestor that lists it. The `<html>` node lists all of them.
- Other properties (`background-color`, `display`, `padding`, ...) appear only where they differ from the browser default for that tag.

Computed values are resolved: `var(--bg)` shows as an `rgb()` color. The `stylesheets` text and `cssVariables` show the rules as written.

## Finding the code

- Find the element in `tree` or `interactiveElements` by its text.
- Search your repo for its class names, `id`, `data-*` values or text.
- Search `stylesheets[].text` for the class to see which CSS rule sets the property, then search the repo for that selector.
- If class names look hashed (for example `css-1x2y3z`, or CSS modules), search for the text or a `data-testid` instead.
- Built file names are hashed too: `index-CGk-Fgzo.css` in the export is usually `index.css` in the source.

## Limitations

- Only the current URL in its current state is captured. Other routes, logged-in views, open menus and modals need separate exports.
- Computed styles reflect one color scheme and one viewport size. The stylesheet text still shows the dark-mode, hover and breakpoint rules.
- No JavaScript, event handlers, API calls or application state are captured, so the export cannot rebuild a working site.
- Images and fonts are referenced by URL, not embedded.
- Iframe contents, closed shadow roots and styles declared inside shadow roots are not captured.
- A stylesheet served from another origin without CORS headers cannot be read; it is listed with an `error` and its URL.
- The tree stops at 20,000 elements and stylesheet text at 3 MB; `counts.treeTruncated` and `stylesheets[].truncated` flag this.
- Only http(s) pages can be exported.
