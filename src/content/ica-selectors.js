// DOM selectors and timings for ICA's shopping list web UI.
//
// ASSUMPTIONS: The real markup of ICA's shopping list pages has not been
// verified yet. Every selector below is a guess (several alternatives are
// comma-separated) and is the single place that needs to be updated once the
// correct HTML/CSS is known. See docs/ASSUMPTIONS.md for the assumed UI flow.
//
// This file is loaded as a classic content script before ica-content.js.

globalThis.ICA_SELECTORS = {
  // --- Overview page: all shopping lists ---------------------------------
  // One card/link per shopping list.
  listCard: '[data-testid="shopping-list-card"], .shopping-list-card',
  // Title of a list inside a card.
  listCardTitle: '[data-testid="shopping-list-title"], .shopping-list-card__title, h2, h3',

  // --- Detail page: one open shopping list -------------------------------
  // Heading containing the name of the open list.
  listTitle: '[data-testid="shopping-list-name"], .shopping-list__title, main h1',
  // Free text input used to add a new item ("Lägg till vara").
  addItemInput: 'input[data-testid="add-item-input"], input[name="addItem"], input[placeholder*="Lägg till" i], input[aria-label*="Lägg till" i]',
  // Button that submits the add input. If missing, Enter is pressed in the input instead.
  addItemButton: 'button[data-testid="add-item-button"], form button[type="submit"][aria-label*="Lägg till" i]',
  // One row per item on the list.
  itemRow: '[data-testid="shopping-list-item"], .shopping-list-item, li.shopping-list__row',
  // Item name inside a row.
  itemName: '[data-testid="item-name"], .shopping-list-item__name',
  // Quantity text inside a row, e.g. "2 st" or "3 dl".
  itemQuantity: '[data-testid="item-quantity"], .shopping-list-item__quantity',
  // Matches when the row is checked/struck over (already shopped).
  itemChecked: 'input[type="checkbox"]:checked, [aria-checked="true"], .is-checked, .shopping-list-item--checked',
  // Button that opens the edit view of a row. If missing, the item name is clicked.
  itemEditButton: 'button[data-testid="edit-item"], button[aria-label*="Ändra" i], button[aria-label*="Redigera" i]',
  // Edit view: free text input with the full item text (preferred) ...
  itemEditTextInput: 'input[data-testid="edit-item-text"], [role="dialog"] input[name="text"]',
  // ... or a separate quantity input.
  itemEditQuantityInput: 'input[data-testid="edit-item-quantity"], [role="dialog"] input[name="quantity"], [role="dialog"] input[type="number"]',
  // Edit view: save button. If missing, Enter is pressed in the edited input.
  itemEditSaveButton: 'button[data-testid="save-item"], [role="dialog"] button[type="submit"], [role="dialog"] button[aria-label*="Spara" i]'
};

globalThis.ICA_UI_TIMING = {
  // Max time to wait for an element to appear (SPA rendering, navigation).
  waitForElementMs: 8000,
  // Max time to wait for an edit view to open.
  waitForEditMs: 3000,
  // Pause after each add/update so ICA's UI (and its API calls) can keep up.
  afterActionMs: 400
};
