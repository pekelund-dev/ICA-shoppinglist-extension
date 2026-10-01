# Assumptions about ICA

The extension was written without access to the real markup of ICA's shopping
list pages or documentation of ICA's API. Everything below is an **assumption**
that must be verified and, where needed, updated. All of it is isolated in two
files so it can be fixed without touching the rest of the code:

| What | Where |
| --- | --- |
| URLs, URL patterns and API endpoint | [`src/lib/config.js`](../src/lib/config.js) (`ICA_CONFIG`) and `content_scripts.matches` in [`manifest.json`](../manifest.json) |
| DOM selectors and UI timings | [`src/content/ica-selectors.js`](../src/content/ica-selectors.js) |

## Login / Authorization

1. The user logs in on `ica.se` in the normal way; the extension never sees the password.
2. After login ICA's web app calls its APIs on a `*.ica.se` host with an
  `Authorization` header using the Bearer scheme. The credential may be an opaque
  access token or a JWT. The extension observes these requests
  (`chrome.webRequest.onBeforeSendHeaders`) and stores the latest token in
  `chrome.storage.local`.
3. JWT credentials with an `exp` claim use it to show "Inloggad"/"Ej inloggad"
  and to skip expired tokens. Opaque tokens, or JWTs without `exp`, are treated
  as valid until the API rejects them. A 401/403 from the API clears the stored token.

If ICA instead keeps the token only in a cookie or in `localStorage`, the capture
in `src/background.js` (`saveToken` / the `webRequest` listener) needs to change.

## Shopping list page

- The page that shows all shopping lists is `https://www.ica.se/inkopslistor/`
  (`ICA_CONFIG.shoppingListPageUrl`). Tabs matching `ICA_CONFIG.shoppingListTabPatterns`
  are treated as "the ICA tab" and the content script is injected on the same URLs.
- When such a page is opened the content script notifies the background worker, which
  downloads all lists (if "Hämta alla listor automatiskt" is enabled).

## API

- `GET ICA_CONFIG.api.allListsUrl` with the bearer token returns all lists including rows.
- The response shape is unknown; [`src/lib/lists.js`](../src/lib/lists.js) accepts several
  shapes, e.g. `{ ShoppingLists: [{ OfflineId, Title, Rows: [{ ProductName, Quantity, Unit, IsStrikedOver }] }] }`
  or the same in camelCase, or a plain array.
- Checked rows are identified by `IsStrikedOver`/`checked`/`isChecked` and removed unless
  "Ta med redan handlade varor" is enabled.
- If the API cannot be used, the lists are scraped from the open page with the DOM selectors
  (overview page: only list names, list page: the rows of that list).

Adding rows uses the observed `POST {listBaseUrl}/{listId}/row` request with
`{ isStriked: false, quantity: {}, text, article: null }`. The request runs in
the ICA page context so the browser supplies the site's origin and referer.
Updating an existing row still uses the web UI; its API contract has not yet
been observed.

## Web UI used to add/update items

Assumed flow (selectors in `src/content/ica-selectors.js`):

1. **Overview page** shows one card per list (`listCard`) with the list name (`listCardTitle`).
   Clicking the card (or a link/button inside it) opens the list.
2. **List page** has a heading with the list name (`listTitle`) and a free text input
   (`addItemInput`, placeholder "Lägg till vara") plus an optional submit button (`addItemButton`).
   Typing e.g. `2 dl Mjölk` and submitting (button click or Enter) adds the item. ICA is assumed to
   interpret quantity and unit from the free text.
3. Each item is a row (`itemRow`) with a name (`itemName`), an optional quantity text (`itemQuantity`,
   e.g. `2 st`) and a checked state (`itemChecked`).
4. **Updating** an item: clicking an edit button in the row (`itemEditButton`, otherwise the name) opens an
   edit view with either a free text input (`itemEditTextInput`, gets e.g. `3 dl Mjölk`) or a quantity input
   (`itemEditQuantityInput`, gets e.g. `3`), and a save button (`itemEditSaveButton`, otherwise Enter).
   If no edit view appears, the new quantity is added as a separate row instead.
5. ICA is a client side rendered app (React or similar): values are set with the native value setter
   and `input`/`change` events are dispatched so the framework notices them.

## Merging rules

- Items with the same name (case-insensitive) as an unchecked row on the target list are merged:
  same unit → quantities are summed; the row has no quantity → the new quantity is set;
  different units → added as a new row; the selected item has no quantity → skipped ("finns redan").
- This can be turned off with "Uppdatera mängden på varor som redan finns i listan".
