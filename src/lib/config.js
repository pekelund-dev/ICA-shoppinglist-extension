// Central configuration of everything that depends on how ICA's website and
// APIs look. All values here are ASSUMPTIONS (see docs/ASSUMPTIONS.md) and are
// expected to be adjusted once the real ICA pages/endpoints have been verified.
// DOM selectors used by the content script live in src/content/ica-selectors.js.

export const ICA_CONFIG = {
  // Page that lists the user's shopping lists. Opened when items are sent and no ICA tab exists.
  shoppingListPageUrl: 'https://www.ica.se/inkopslista/',

  // Tab URL patterns (chrome.tabs.query) that count as "the ICA shopping list tab".
  shoppingListTabPatterns: [
    'https://www.ica.se/inkopslista/*',
    'https://www.ica.se/inkopslistor/*',
    'https://handla.ica.se/*inkopslist*'
  ],

  // Requests to these URLs are observed to capture the JWT from the Authorization header.
  tokenCaptureUrlPatterns: ['https://*.ica.se/*'],

  api: {
    // Returns all shopping lists of the logged in user, including their rows.
    allListsUrl: 'https://apim-pub.gw.ica.se/sverige/digx/shopping-list/v1/api/list/all',
    listBaseUrl: 'https://apim-pub.gw.ica.se/sverige/digx/shopping-list/v1/api/list'
  }
};

export const DEFAULT_SETTINGS = {
  // Include already shopped (checked/struck over) items when downloading lists.
  includeChecked: false,
  // Update the quantity of an item that already exists on the list instead of adding a duplicate.
  mergeQuantities: true,
  // Download all lists automatically when an ICA shopping list page is opened.
  autoSyncOnPageOpen: true,
  // Open the ICA shopping list page in a new tab if none is open when items are sent.
  openIcaTabIfMissing: true,
  // Id of the list that items are added to. Empty = first list.
  targetListId: ''
};

export const STORAGE_KEYS = {
  auth: 'icaAuth',
  lists: 'icaLists',
  settings: 'settings',
  pending: 'pendingChanges',
  lastResult: 'lastResult'
};

export const MESSAGES = {
  // content script (ICA) -> background
  icaPageOpened: 'ica-page-opened',
  icaGetPending: 'ica-get-pending',
  icaReportResult: 'ica-report-result',
  // background -> content script (ICA)
  icaApplyChanges: 'ica-apply-changes',
  icaScrapeLists: 'ica-scrape-lists',
  // popup/options -> background
  getState: 'get-state',
  syncLists: 'sync-lists',
  sendText: 'send-text',
  previewText: 'preview-text'
};
