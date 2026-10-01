// Background service worker: captures the ICA JWT, downloads shopping lists,
// handles context menu / keyboard shortcut / popup requests and forwards the
// parsed items to the ICA shopping list tab.

import { ICA_CONFIG, DEFAULT_SETTINGS, STORAGE_KEYS, MESSAGES } from './lib/config.js';
import { extractBearerToken, getTokenExpiry, isTokenExpired } from './lib/jwt.js';
import { normalizeLists, filterLists } from './lib/lists.js';
import { parseItems } from './lib/parser.js';
import { planChanges } from './lib/items.js';

const CONTEXT_MENU_ID = 'ica-add-selection';
const COMMAND_SEND_SELECTION = 'send-selection';

// --- Storage helpers ---------------------------------------------------------

async function getSettings() {
  const stored = await chrome.storage.sync.get(STORAGE_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) };
}

async function getLocal(key) {
  return (await chrome.storage.local.get(key))[key];
}

async function getValidToken() {
  const auth = await getLocal(STORAGE_KEYS.auth);
  return auth && auth.token && !isTokenExpired(auth.token) ? auth.token : null;
}

// --- Feedback ----------------------------------------------------------------

async function showResult(result) {
  await chrome.storage.local.set({ [STORAGE_KEYS.lastResult]: { ...result, at: Date.now() } });
  const text = result.ok ? (result.queued ? '…' : '✓') : '!';
  await chrome.action.setBadgeBackgroundColor({ color: result.ok ? '#0a8a3a' : '#c8102e' });
  await chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);
}

function describeResult(result) {
  if (!result.ok && result.error) return result.error;
  const parts = [`${result.added || 0} tillagda`, `${result.updated || 0} uppdaterade`];
  if (result.skipped) parts.push(`${result.skipped} fanns redan`);
  if (result.failed && result.failed.length) parts.push(`${result.failed.length} misslyckades`);
  return parts.join(', ');
}

// --- JWT capture (requirement 2) ----------------------------------------------

let lastSeenToken = null;

async function saveToken(token) {
  if (token === lastSeenToken) return;
  lastSeenToken = token;
  const current = await getLocal(STORAGE_KEYS.auth);
  if (current && current.token === token) return;
  await chrome.storage.local.set({
    [STORAGE_KEYS.auth]: { token, expiresAt: getTokenExpiry(token), capturedAt: Date.now() }
  });
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    // Ignore requests made by the extension itself.
    if (details.initiator && details.initiator.startsWith('chrome-extension://')) return;
    const token = extractBearerToken(details.requestHeaders);
    if (token) saveToken(token).catch((error) => console.warn('Could not save ICA token', error));
  },
  { urls: ICA_CONFIG.tokenCaptureUrlPatterns },
  ['requestHeaders', 'extraHeaders']
);

// --- Shopping lists (requirement 3) -----------------------------------------

async function fetchListsFromApi(token) {
  const response = await fetch(ICA_CONFIG.api.allListsUrl, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  if (response.status === 401 || response.status === 403) {
    await chrome.storage.local.remove(STORAGE_KEYS.auth);
    lastSeenToken = null;
    throw new Error('Inloggningen hos ICA har gått ut. Logga in igen.');
  }
  if (!response.ok) throw new Error(`ICA svarade med ${response.status}.`);
  return normalizeLists(await response.json());
}

async function scrapeListsFromTab(tabId) {
  const response = await chrome.tabs.sendMessage(tabId, { type: MESSAGES.icaScrapeLists });
  return normalizeLists(response && response.lists);
}

async function syncLists(tabId) {
  const settings = await getSettings();
  const token = await getValidToken();
  let lists = null;
  let source = null;
  let lastError = null;

  if (token) {
    try {
      lists = await fetchListsFromApi(token);
      source = 'api';
    } catch (error) {
      lastError = error;
    }
  }
  if (!lists && tabId !== undefined) {
    try {
      lists = await scrapeListsFromTab(tabId);
      source = 'page';
    } catch (error) {
      lastError = lastError || error;
    }
  }
  if (!lists) {
    throw lastError || new Error('Inte inloggad hos ICA. Logga in på ica.se och öppna dina inköpslistor.');
  }

  const data = { lists: filterLists(lists, settings), syncedAt: Date.now(), source };
  await chrome.storage.local.set({ [STORAGE_KEYS.lists]: data });
  return data;
}

// --- Sending items to ICA (requirements 4 and 5) ---------------------------

async function findIcaTab() {
  const tabs = await chrome.tabs.query({ url: ICA_CONFIG.shoppingListTabPatterns });
  return tabs.find((tab) => tab.active) || tabs[0] || null;
}

async function buildPayload(text) {
  const items = parseItems(text);
  const settings = await getSettings();
  const data = (await getLocal(STORAGE_KEYS.lists)) || { lists: [] };
  const target = data.lists.find((list) => list.id === settings.targetListId) || data.lists[0] || null;
  return {
    listId: target ? target.id : null,
    listName: target ? target.name : null,
    changes: planChanges(items, target ? target.rows : [], settings),
    settings
  };
}

async function queuePayload(payload) {
  const pending = (await getLocal(STORAGE_KEYS.pending)) || [];
  pending.push({ ...payload, queuedAt: Date.now() });
  await chrome.storage.local.set({ [STORAGE_KEYS.pending]: pending });
}

async function sendText(text) {
  const { settings, ...payload } = await buildPayload(text);
  if (!payload.changes.length) {
    const result = { ok: false, error: 'Hittade inga varor i den markerade texten.' };
    await showResult(result);
    return result;
  }

  const tab = await findIcaTab();
  if (tab) {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, { type: MESSAGES.icaApplyChanges, payload });
      if (result) return handleApplied(result, tab.id);
    } catch {
      // The content script is not loaded in the tab (e.g. extension was reloaded) – queue and reload.
    }
  }

  await queuePayload(payload);
  if (tab) {
    await chrome.tabs.reload(tab.id);
  } else if (settings.openIcaTabIfMissing) {
    await chrome.tabs.create({ url: ICA_CONFIG.shoppingListPageUrl, active: false });
  }
  const result = {
    ok: true,
    queued: true,
    message: tab || settings.openIcaTabIfMissing
      ? `${payload.changes.length} varor skickas till ICA-fliken.`
      : `${payload.changes.length} varor väntar. Öppna dina inköpslistor på ica.se.`
  };
  await showResult(result);
  return result;
}

async function handleApplied(result, tabId) {
  const final = { ...result, message: describeResult(result) };
  await showResult(final);
  syncLists(tabId).catch(() => {});
  return final;
}

async function getSelectedText(tabId, frameId, fallback = '') {
  const target = frameId !== undefined ? { tabId, frameIds: [frameId] } : { tabId, allFrames: true };
  try {
    const results = await chrome.scripting.executeScript({
      target,
      func: () => (window.getSelection() ? window.getSelection().toString() : '')
    });
    const text = results.map((r) => r.result).filter((t) => t && t.trim()).join('\n');
    return text || fallback;
  } catch {
    return fallback;
  }
}

async function sendSelectionFromTab(tab, frameId, fallbackText) {
  if (!tab || tab.id === undefined) return;
  const text = await getSelectedText(tab.id, frameId, fallbackText);
  if (!text.trim()) {
    await showResult({ ok: false, error: 'Markera de varor som ska läggas till först.' });
    return;
  }
  await sendText(text);
}

// --- Entry points --------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: 'Lägg till i ICA-inköpslistan',
      contexts: ['selection']
    });
  });
  const stored = await chrome.storage.sync.get(STORAGE_KEYS.settings);
  await chrome.storage.sync.set({ [STORAGE_KEYS.settings]: { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) } });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  sendSelectionFromTab(tab, info.frameId, info.selectionText || '').catch((error) => showResult({ ok: false, error: error.message }));
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== COMMAND_SEND_SELECTION) return;
  const getTab = tab ? Promise.resolve(tab) : chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]);
  getTab
    .then((activeTab) => sendSelectionFromTab(activeTab))
    .catch((error) => showResult({ ok: false, error: error.message }));
});

const handlers = {
  async [MESSAGES.icaPageOpened](message, sender) {
    const settings = await getSettings();
    if (settings.autoSyncOnPageOpen && sender.tab) {
      syncLists(sender.tab.id).catch((error) => console.warn('ICA list sync failed:', error.message));
    }
    return { ok: true };
  },
  async [MESSAGES.icaGetPending]() {
    const payloads = (await getLocal(STORAGE_KEYS.pending)) || [];
    await chrome.storage.local.remove(STORAGE_KEYS.pending);
    return { ok: true, payloads };
  },
  async [MESSAGES.icaReportResult](message, sender) {
    return handleApplied(message.result || { ok: false, error: 'Okänt resultat.' }, sender.tab && sender.tab.id);
  },
  async [MESSAGES.getState]() {
    const auth = await getLocal(STORAGE_KEYS.auth);
    return {
      ok: true,
      loggedIn: Boolean(await getValidToken()),
      tokenExpiresAt: auth ? auth.expiresAt : null,
      lists: (await getLocal(STORAGE_KEYS.lists)) || null,
      pending: ((await getLocal(STORAGE_KEYS.pending)) || []).length,
      lastResult: (await getLocal(STORAGE_KEYS.lastResult)) || null,
      settings: await getSettings()
    };
  },
  async [MESSAGES.syncLists]() {
    const tab = await findIcaTab();
    return { ok: true, ...(await syncLists(tab ? tab.id : undefined)) };
  },
  async [MESSAGES.previewText](message) {
    const { listName, changes } = await buildPayload(String(message.text || ''));
    return { ok: true, listName, changes };
  },
  async [MESSAGES.sendText](message) {
    return sendText(String(message.text || ''));
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only accept messages from this extension's own pages and content scripts.
  if (sender.id !== chrome.runtime.id || !message || !Object.hasOwn(handlers, message.type)) return false;
  handlers[message.type](message, sender).then(sendResponse, (error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
