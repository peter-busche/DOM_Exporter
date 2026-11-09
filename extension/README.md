# DOM Export (Chrome extension)

Exports what the browser rendered for a page, so you can work out where a UI element is defined in a frontend repo, or hand the files to an AI assistant along with the question. It does two things:

- **Record one element:** right-click anything on the page and choose **DOM Export: record this element**. You get a small file describing exactly that element and the CSS rules that style it, plus a full page export with the element flagged.
- **Export the whole page:** click the extension icon, then **Export**.

Files are saved to a folder you choose, or to your Downloads folder if you have not chosen one.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the extension from the puzzle-piece menu if you want it visible.

After installing, or after changing the extension's files and clicking the reload icon on its card, **refresh any tabs that were already open**. The right-click feature only works in tabs loaded after the extension was (re)loaded.

Requires Chrome 116 or later.

## Choose where files are saved

By default, files go to your browser's Downloads folder. To send them somewhere else, such as an `exports/` folder inside the repo you are working on:

1. Click the extension icon, then **Change folder…**. This opens the settings page. (You can also reach it from the extension's **Details** page under **Extension options**.)
2. Click **Choose folder…**, pick the folder, and approve Chrome's prompt to let the extension edit files there.
3. The settings page writes and removes a small test file to confirm the folder works, then shows **Access allowed**.

From then on, both the Export button and the right-click option write straight into that folder. Change it at any time from the same page, or click **Use Downloads instead** to go back.

### Subfolders: grouping exports per task

The **Subfolder** field, in both the popup and the settings page, puts files into a subfolder of the save location and creates it if needed. Type `nav-color-change` before working on one change and `footer-links` before the next, and each task's exports stay together. Use `/` for nested folders, such as `homepage/nav`. Letters, digits, spaces, dots, dashes and underscores are kept; other characters become dashes.

The subfolder also applies when saving to Downloads, for example `Downloads/nav-color-change/`.

### When folder access lapses

Chrome's approval for a folder can lapse, for example after the browser restarts. When that happens nothing is lost:

- The files are saved to Downloads (in the same subfolder name) instead.
- The message shown after the export says so and why.
- The popup shows a warning under **Saves to**.

To fix it, open settings and click **Re-allow access**. If Chrome's prompt offers **Allow on every visit**, choosing it should keep the approval from lapsing.

The same fallback applies if the folder has been deleted or renamed, or a write fails for any other reason.

### Folders Chrome will not allow

Chrome blocks a few protected locations for every site and extension, such as your home folder itself and system folders. Pick a project folder or a subfolder instead.

## Record one element (right-click)

1. Right-click the thing you want to change: a button, a heading, an image. As soon as you press the button, the element that would be recorded is highlighted in blue, with a label giving its tag, id or classes, and size (for example `a.card.link-card   275 × 145`).
2. Check the highlight. If it covers what you meant, choose **DOM Export: record this element** from the menu. If it covers something too small or too large, press Esc and right-click a different spot: the padding of a card selects the card, while its text selects the heading or paragraph inside it.
3. The element flashes orange, a message in the bottom-right corner says where the files went, and three files are saved with one shared name:
   - `dom-export-<host>-<timestamp>.selection.json`: the element you clicked. Start here.
   - `dom-export-<host>-<timestamp>.json`: the full page export taken at the same instant, with the element marked `"selected": true`.
   - `dom-export-<host>-<timestamp>.html`: the raw markup.

The blue highlight stays while the menu is open and clears when you move the mouse, click, scroll or press a key afterwards. It is drawn on top of the page, never by changing the element, and is removed before anything is captured, so it does not appear in the exported files.

On macOS the menu opens the instant the button goes down, so the highlight appears together with the menu. On Windows and Linux, where the menu opens when you release, you can hold the button and move the mouse: the highlight follows, and the element under the pointer when you release is the one recorded.

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
3. Two files are saved: `dom-export-<host>-<timestamp>.json` and `.html`. The popup says where they went.

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
| `downloads`, `offscreen` | Saves the files. The offscreen page is a hidden helper that writes files to your chosen folder, or prepares them for download, on behalf of the right-click option. |
| Folder access (asked when you choose a folder) | Lets the extension write export files into the one folder you picked. It is not requested until you choose a folder, and covers only that folder. |
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
- Choosing a save folder needs a Chromium-based browser (Chrome, Edge, Brave). Elsewhere, files go to Downloads.
- The tree stops at 20,000 elements, stylesheet text at 3 MB and matched rules at 300; `counts.treeTruncated`, `stylesheets[].truncated` and `rulesCapped` flag this.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Extension manifest (Manifest V3). |
| `capture.js` | Capture library: `capturePage()` for the full export, `describeSelection()` for one element. |
| `content.js` | Runs in each page: remembers the right-clicked element, shows the outline and message. |
| `background.js` | Service worker: owns the menu item and saves the files. |
| `filestore.js` | Save-location logic: remembers the chosen folder and subfolder, writes files, reports when to fall back to Downloads. |
| `settings.html`, `settings.js` | Settings page: choose the folder, re-allow access, set the subfolder. |
| `offscreen.html`, `offscreen.js` | Hidden helper page that saves files for the right-click option. |
| `popup.html`, `popup.js` | The Export button, the current save location and the subfolder field. |
