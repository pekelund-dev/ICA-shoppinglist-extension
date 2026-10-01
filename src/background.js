// Background service worker: captures the ICA JWT, downloads shopping lists,
// handles context menu / keyboard shortcut / popup requests and forwards the
// parsed items to the ICA shopping list tab.

import { ICA_CONFIG, DEFAULT_SETTINGS, STORAGE_KEYS, MESSAGES } from './lib/config.js';
import { extractBearerToken, getTokenExpiry, isTokenExpired, looksLikeJwt } from './lib/jwt.js';
import { normalizeLists, filterLists } from './lib/lists.js';
import { parseItems } from './lib/parser.js';
import { planChanges } from './lib/items.js';

const CONTEXT_MENU_ID = 'ica-add-selection';
const COMMAND_SEND_SELECTION = 'send-selection';
const LOG = '[ICA][background]';

function logError(stage, error) {
  console.warn(LOG, stage, error && error.name ? error.name : 'Error', error && error.message ? error.message : String(error));
}

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
  console.debug(LOG, 'Storing result', {
    ok: Boolean(result.ok),
    queued: Boolean(result.queued),
    added: result.added || 0,
    updated: result.updated || 0,
    skipped: result.skipped || 0,
    failed: Array.isArray(result.failed) ? result.failed.length : 0
  });
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
const pendingAuthRequests = new Map();

async function saveToken(token) {
  if (token === lastSeenToken) {
    console.debug(LOG, 'Ignoring duplicate captured token');
    return;
  }
  lastSeenToken = token;
  const current = await getLocal(STORAGE_KEYS.auth);
  if (current && current.token === token) {
    console.debug(LOG, 'Captured token already stored');
    return;
  }
  await chrome.storage.local.set({
    [STORAGE_KEYS.auth]: { token, expiresAt: getTokenExpiry(token), capturedAt: Date.now() }
  });
  console.info(LOG, 'Captured and stored ICA authorization token; value omitted');
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    // Ignore requests made by the extension itself.
    if (details.initiator && details.initiator.startsWith('chrome-extension://')) return;
    const hasAuthorizationHeader = (details.requestHeaders || []).some(
      (header) => header.name.toLowerCase() === 'authorization'
    );
    const authorizationHeader = (details.requestHeaders || []).find(
      (header) => header.name.toLowerCase() === 'authorization'
    );
    const authorizationValue = authorizationHeader && authorizationHeader.value;
    const bearerMatch = typeof authorizationValue === 'string'
      ? authorizationValue.match(/^Bearer\s+(\S+)$/i)
      : null;
    if (details.type === 'xmlhttprequest' || hasAuthorizationHeader) {
      console.debug(LOG, 'Observed ICA network request', {
        host: new URL(details.url).host,
        type: details.type,
        hasAuthorizationHeader,
        hasBearerFormat: Boolean(bearerMatch),
        bearerLooksLikeJwt: Boolean(bearerMatch && looksLikeJwt(bearerMatch[1]))
      });
    }
    const token = extractBearerToken(details.requestHeaders);
    if (token) pendingAuthRequests.set(details.requestId, token);
  },
  { urls: ICA_CONFIG.tokenCaptureUrlPatterns },
  ['requestHeaders', 'extraHeaders']
);
chrome.webRequest.onCompleted.addListener(
  (details) => {
    const token = pendingAuthRequests.get(details.requestId);
    if (!token) return;
    pendingAuthRequests.delete(details.requestId);
    if (details.statusCode >= 200 && details.statusCode < 300) {
      console.info(LOG, 'ICA accepted an authorization token', { status: details.statusCode });
      saveToken(token).catch((error) => logError('Could not save accepted ICA token', error));
      return;
    }
    if (details.statusCode === 401) {
      console.warn(LOG, 'ICA rejected an authorization token', { status: details.statusCode });
      getLocal(STORAGE_KEYS.auth).then((auth) => {
        if (auth && auth.token === token) {
          return chrome.storage.local.remove(STORAGE_KEYS.auth).then(() => {
            lastSeenToken = null;
            console.info(LOG, 'Removed rejected stored ICA token');
          });
        }
        return undefined;
      }).catch((error) => logError('Could not clear rejected ICA token', error));
    }
  },
  { urls: ICA_CONFIG.tokenCaptureUrlPatterns }
);
chrome.webRequest.onErrorOccurred.addListener(
  (details) => pendingAuthRequests.delete(details.requestId),
  { urls: ICA_CONFIG.tokenCaptureUrlPatterns }
);
console.info(LOG, 'ICA request listener registered', { urlPatternCount: ICA_CONFIG.tokenCaptureUrlPatterns.length });

// --- Shopping lists (requirement 3) -----------------------------------------

async function fetchListsFromApi(token, tabId) {
  console.debug(LOG, 'Fetching lists from ICA API');
  let response;
  if (tabId !== undefined) {
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async ({ url, bearer }) => {
        const result = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${bearer}`,
            Accept: '*/*',
            'Content-Type': 'application/json; charset=UTF-8'
          },
          cache: 'no-store'
        });
        return { status: result.status, body: result.ok ? await result.json() : null };
      },
      args: [{ url: ICA_CONFIG.api.allListsUrl, bearer: token }]
    });
    response = execution && execution.result;
  } else {
    const rawResponse = await fetch(ICA_CONFIG.api.allListsUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    });
    response = { status: rawResponse.status, body: rawResponse.ok ? await rawResponse.json() : null };
  }

  if (!response) throw new Error('ICA:s list-API gav inget svar.');
  if (response.status === 401) {
    await chrome.storage.local.remove(STORAGE_KEYS.auth);
    lastSeenToken = null;
    throw new Error('ICA avvisade inloggningen (HTTP 401). Logga in på ICA igen.');
  }
  if (response.status < 200 || response.status >= 300) {
    console.warn(LOG, 'ICA list API returned an unsuccessful response', {
      status: response.status
    });
    throw new Error(`ICA:s list-API svarade med HTTP ${response.status}.`);
  }
  const lists = normalizeLists(response.body);
  console.info(LOG, 'ICA API list fetch complete', { listCount: lists.length });
  return lists;
}

async function addRowsViaApi(token, tabId, listId, changes) {
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async ({ url, bearer, rows }) => {
      const outcomes = [];
      for (const row of rows) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${bearer}`,
              Accept: '*/*',
              'Content-Type': 'application/json; charset=UTF-8'
            },
            body: JSON.stringify({
              isStriked: false,
              quantity: {},
              text: row.text,
              article: null
            })
          });
          outcomes.push({ status: response.status });
        } catch {
          outcomes.push({ status: 0 });
        }
      }
      return outcomes;
    },
    args: [{
      url: `${ICA_CONFIG.api.listBaseUrl}/${encodeURIComponent(listId)}/row`,
      bearer: token,
      rows: changes.map(({ text }) => ({ text }))
    }]
  });
  return execution && Array.isArray(execution.result) ? execution.result : [];
}

async function clearRejectedToken(token) {
  const auth = await getLocal(STORAGE_KEYS.auth);
  if (!auth || auth.token !== token) return;
  await chrome.storage.local.remove(STORAGE_KEYS.auth);
  lastSeenToken = null;
  console.info(LOG, 'Removed rejected stored ICA token');
}

async function scrapeListsFromTab(tabId) {
  console.debug(LOG, 'Requesting list scrape from ICA tab', { tabId });
  const response = await chrome.tabs.sendMessage(tabId, { type: MESSAGES.icaScrapeLists });
  const lists = normalizeLists(response && response.lists);
  console.info(LOG, 'ICA page scrape complete', { tabId, listCount: lists.length });
  return lists;
}

async function syncLists(tabId) {
  console.info(LOG, 'List sync started', { hasTab: tabId !== undefined });
  const settings = await getSettings();
  const token = await getValidToken();
  let lists = null;
  let source = null;
  let lastError = null;

  if (token) {
    try {
      lists = await fetchListsFromApi(token, tabId);
      source = 'api';
    } catch (error) {
      lastError = error;
      logError('ICA API list fetch failed; considering page fallback', error);
    }
  }
  if (!lists && tabId !== undefined) {
    try {
      lists = await scrapeListsFromTab(tabId);
      source = 'page';
    } catch (error) {
      lastError = lastError || error;
      logError('ICA page list scrape failed', error);
    }
  }
  if (!lists) {
    throw lastError || new Error('Inte inloggad hos ICA. Logga in på ica.se och öppna dina inköpslistor.');
  }

  const data = { lists: filterLists(lists, settings), syncedAt: Date.now(), source };
  await chrome.storage.local.set({ [STORAGE_KEYS.lists]: data });
  console.info(LOG, 'List sync stored', { source, listCount: data.lists.length });
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
  const payload = {
    listId: target ? target.id : null,
    listName: target ? target.name : null,
    changes: planChanges(items, target ? target.rows : [], settings),
    settings
  };
  console.debug(LOG, 'Prepared send payload', {
    parsedItemCount: items.length,
    changeCount: payload.changes.length,
    hasTargetList: Boolean(target)
  });
  return payload;
}

async function queuePayload(payload) {
  const pending = (await getLocal(STORAGE_KEYS.pending)) || [];
  pending.push({ ...payload, queuedAt: Date.now() });
  await chrome.storage.local.set({ [STORAGE_KEYS.pending]: pending });
  console.info(LOG, 'Queued changes for ICA tab', { changeCount: payload.changes.length, queueLength: pending.length });
}

async function sendText(text) {
  console.info(LOG, 'Send flow started', { inputLength: text.length });
  const { settings, ...payload } = await buildPayload(text);
  if (!payload.changes.length) {
    const result = { ok: false, error: 'Hittade inga varor i den markerade texten.' };
    await showResult(result);
    return result;
  }

  const tab = await findIcaTab();
  console.debug(LOG, 'ICA tab lookup complete', { found: Boolean(tab), tabId: tab && tab.id });
  if (tab) {
    const token = await getValidToken();
    const apiAdds = token && payload.listId
      ? payload.changes.filter((change) => change.action === 'add')
      : [];
    const uiChanges = apiAdds.length
      ? payload.changes.filter((change) => change.action === 'update')
      : payload.changes;
    const applied = { ok: true, added: 0, updated: 0, skipped: 0, failed: [] };

    if (apiAdds.length) {
      applied.skipped = payload.changes.filter((change) => change.action === 'skip').length;
      console.info(LOG, 'Adding rows through ICA API', { tabId: tab.id, rowCount: apiAdds.length });
      let outcomes;
      try {
        outcomes = await addRowsViaApi(token, tab.id, payload.listId, apiAdds);
      } catch (error) {
        logError('ICA row API request failed', error);
        outcomes = [];
      }
      apiAdds.forEach((change, index) => {
        const status = outcomes[index] && outcomes[index].status;
        if (status >= 200 && status < 300) {
          applied.added += 1;
        } else {
          const message = status
            ? `ICA:s list-API svarade med HTTP ${status}.`
            : 'Det gick inte att bekräfta om varan lades till. Kontrollera listan innan du försöker igen.';
          applied.failed.push({ text: change.text, error: message });
          if (status === 401) clearRejectedToken(token).catch((error) => logError('Could not clear rejected ICA token', error));
        }
      });
      console.info(LOG, 'ICA row API requests complete', {
        added: applied.added,
        failed: applied.failed.length
      });
    }

    if (apiAdds.length && !uiChanges.length) {
      applied.ok = applied.failed.length === 0;
      return handleApplied(applied, tab.id);
    }

    try {
      const uiPayload = { ...payload, changes: uiChanges };
      const result = await chrome.tabs.sendMessage(tab.id, { type: MESSAGES.icaApplyChanges, payload: uiPayload });
      if (result) {
        console.info(LOG, 'ICA content script returned an apply result', { tabId: tab.id, ok: Boolean(result.ok) });
        applied.added += result.added || 0;
        applied.updated += result.updated || 0;
        applied.skipped += result.skipped || 0;
        applied.failed.push(...(result.failed || []));
        applied.ok = applied.failed.length === 0 && result.ok !== false;
        return handleApplied(applied, tab.id);
      }
      console.warn(LOG, 'ICA content script returned no apply result; changes will be queued', { tabId: tab.id });
    } catch (error) {
      // The content script is not loaded in the tab (e.g. extension was reloaded) – queue and reload.
      logError('Could not reach ICA content script; changes will be queued', error);
    }

    if (apiAdds.length) {
      const queuedPayload = { ...payload, changes: uiChanges };
      await queuePayload(queuedPayload);
      await chrome.tabs.reload(tab.id);
      const result = {
        ...applied,
        ok: applied.failed.length === 0,
        queued: true,
        message: `${applied.added} tillagda via API; ${uiChanges.length} ändringar väntar på ICA-fliken.`
      };
      await showResult(result);
      syncLists(tab.id).catch((syncError) => logError('Post-apply list refresh failed', syncError));
      return result;
    }
  }

  await queuePayload(payload);
  if (tab) {
    console.info(LOG, 'Reloading ICA tab to deliver queued changes', { tabId: tab.id });
    await chrome.tabs.reload(tab.id);
  } else if (settings.openIcaTabIfMissing) {
    console.info(LOG, 'Opening ICA tab to deliver queued changes');
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
  console.info(LOG, 'Apply result received', {
    tabId,
    ok: Boolean(result.ok),
    added: result.added || 0,
    updated: result.updated || 0,
    skipped: result.skipped || 0,
    failed: Array.isArray(result.failed) ? result.failed.length : 0
  });
  const final = { ...result, message: describeResult(result) };
  await showResult(final);
  syncLists(tabId).catch((error) => logError('Post-apply list refresh failed', error));
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
    console.debug(LOG, 'Could not read selection from tab; using fallback', { tabId });
    return fallback;
  }
}

async function sendSelectionFromTab(tab, frameId, fallbackText) {
  if (!tab || tab.id === undefined) return;
  const text = await getSelectedText(tab.id, frameId, fallbackText);
  console.debug(LOG, 'Selection lookup complete', { tabId: tab.id, hasText: Boolean(text.trim()), textLength: text.length });
  if (!text.trim()) {
    await showResult({ ok: false, error: 'Markera de varor som ska läggas till först.' });
    return;
  }
  await sendText(text);
}

// --- Entry points --------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  console.info(LOG, 'Extension installed or updated');
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
  console.info(LOG, 'Context-menu send requested', { tabId: tab && tab.id });
  sendSelectionFromTab(tab, info.frameId, info.selectionText || '').catch((error) => {
    logError('Context-menu send failed', error);
    showResult({ ok: false, error: error.message });
  });
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== COMMAND_SEND_SELECTION) return;
  console.info(LOG, 'Keyboard command received', { command });
  const getTab = tab ? Promise.resolve(tab) : chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]);
  getTab
    .then((activeTab) => sendSelectionFromTab(activeTab))
    .catch((error) => {
      logError('Keyboard-command send failed', error);
      showResult({ ok: false, error: error.message });
    });
});

const handlers = {
  async [MESSAGES.icaPageOpened](message, sender) {
    const settings = await getSettings();
    console.info(LOG, 'ICA page-opened message received', { tabId: sender.tab && sender.tab.id, autoSync: settings.autoSyncOnPageOpen });
    if (settings.autoSyncOnPageOpen && sender.tab) {
      syncLists(sender.tab.id).catch((error) => logError('Automatic ICA list sync failed', error));
    }
    return { ok: true };
  },
  async [MESSAGES.icaGetPending]() {
    const payloads = (await getLocal(STORAGE_KEYS.pending)) || [];
    await chrome.storage.local.remove(STORAGE_KEYS.pending);
    console.info(LOG, 'Pending changes handed to ICA content script', { payloadCount: payloads.length });
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
  if (sender.id !== chrome.runtime.id || !message || !Object.hasOwn(handlers, message.type)) {
    console.warn(LOG, 'Ignored untrusted or unsupported runtime message', {
      trustedSender: sender.id === chrome.runtime.id,
      type: message && message.type
    });
    return false;
  }
  console.debug(LOG, 'Runtime message received', { type: message.type, tabId: sender.tab && sender.tab.id });
  handlers[message.type](message, sender).then(sendResponse, (error) => {
    logError(`Runtime handler failed: ${message.type}`, error);
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});
