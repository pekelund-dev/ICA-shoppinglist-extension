# ICA-shoppinglist-extension
Chrome extension for adding items to your ICA shoppinglist.

Select ingredients on a recipe site, in a document or anywhere else and send them
to your ICA shopping list with a right-click, a button click or a keyboard shortcut.

> **Note:** ICA's markup and API have not been verified yet. All assumptions are
> documented in [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md) and isolated in
> [`src/lib/config.js`](src/lib/config.js) and
> [`src/content/ica-selectors.js`](src/content/ica-selectors.js).

## How it works

1. **Log in** on [ica.se](https://www.ica.se). The extension listens to ICA's own
   requests and saves the JWT (from the `Authorization` header) that it needs.
2. **Open your shopping lists** on ica.se. The extension downloads all lists and their
   items (already shopped items are excluded unless enabled in the settings).
3. **Select items** in any other tab, e.g. a recipe's ingredient list.
4. **Send them** using one of:
   - right-click → *Lägg till i ICA-inköpslistan*
   - the toolbar popup → *Skicka till ICA* (shows a preview and lets you choose the list)
   - the keyboard shortcut <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd> (change it at `chrome://extensions/shortcuts`)
5. The selected text is parsed into items (`2 dl mjölk`, `½ tsk salt`, `- 3 ägg`, …) and sent
   to the ICA tab, where the extension uses ICA's web UI to add new items or update the
   quantity of items already on the list. If no ICA tab is open, one is opened and the items
   are added once it has loaded.

## Install (development)

1. Open `chrome://extensions` and enable *Developer mode*.
2. Click *Load unpacked* and select this repository's folder.

## Project structure

| Path | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3 definition (permissions, shortcut, content scripts) |
| `src/background.js` | Service worker: JWT capture, list download, context menu, shortcut, forwarding to the ICA tab |
| `src/content/ica-selectors.js` | **ICA DOM selectors (assumptions – update here)** |
| `src/content/ica-content.js` | Content script on ICA that drives the web UI |
| `src/lib/config.js` | **ICA URLs/API (assumptions – update here)** and default settings |
| `src/lib/parser.js` | Parses selected text into items |
| `src/lib/items.js` | Decides whether items are added, updated or skipped |
| `src/lib/lists.js` | Normalizes list data from the API/page |
| `src/lib/jwt.js` | JWT helpers |
| `src/popup/`, `src/options/` | Toolbar popup and settings page |

## Tests

```sh
npm test
```

Runs the unit tests in `test/` with Node's built-in test runner (no dependencies).
