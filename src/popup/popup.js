import { MESSAGES, STORAGE_KEYS } from '../lib/config.js';

const LOG = '[ICA][popup]';
const $ = (id) => document.getElementById(id);
const ACTION_LABELS = { add: 'läggs till', update: 'uppdateras', skip: 'finns redan' };

function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra });
}

function setText(element, text, isError = false) {
  element.textContent = text || '';
  element.classList.toggle('error', Boolean(isError));
}

function renderLogin(state) {
  const status = $('login-status');
  status.className = `status ${state.loggedIn ? 'ok' : 'error'}`;
  status.textContent = state.loggedIn ? 'Inloggad' : 'Ej inloggad';
  status.title = state.loggedIn && state.tokenExpiresAt
    ? `Giltig till ${new Date(state.tokenExpiresAt).toLocaleString('sv-SE')}`
    : 'Logga in på ica.se så sparas inloggningen automatiskt.';
}

function renderLists(state) {
  const select = $('target-list');
  const lists = (state.lists && state.lists.lists) || [];
  select.replaceChildren(...lists.map((list) => {
    const option = document.createElement('option');
    option.value = list.id;
    option.textContent = `${list.name || list.id} (${list.rows.length})`;
    return option;
  }));
  if (!lists.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Inga listor hämtade';
    select.append(option);
  }
  select.value = lists.some((list) => list.id === state.settings.targetListId) ? state.settings.targetListId : select.options[0].value;
  setText($('sync-status'), state.lists
    ? `Hämtade ${new Date(state.lists.syncedAt).toLocaleString('sv-SE')}`
    : 'Öppna dina inköpslistor på ica.se för att hämta dem.');
}

async function refresh() {
  console.debug(LOG, 'Refreshing popup state');
  const state = await send(MESSAGES.getState);
  renderLogin(state);
  renderLists(state);
  console.info(LOG, 'Popup state loaded', {
    loggedIn: Boolean(state.loggedIn),
    listCount: state.lists && state.lists.lists ? state.lists.lists.length : 0,
    pendingCount: state.pending || 0
  });
  if (state.pending) setText($('result'), `${state.pending} sändning(ar) väntar på ICA-fliken.`);
  return state;
}

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try {
      const response = await send(MESSAGES.previewText, { text: $('text').value });
      console.debug(LOG, 'Preview updated', { changeCount: (response && response.changes || []).length });
      $('preview').replaceChildren(...((response && response.changes) || []).map((change) => {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = change.text;
        const action = document.createElement('span');
        action.className = `action ${change.action}`;
        action.textContent = ACTION_LABELS[change.action] || change.action;
        li.append(name, action);
        return li;
      }));
    } catch (error) {
      console.warn(LOG, 'Preview request failed', error.name || 'Error', error.message);
      setText($('result'), 'Förhandsvisningen kunde inte uppdateras.', true);
    }
  }, 200);
}

async function grabSelection() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => (window.getSelection() ? window.getSelection().toString() : '')
    });
    const text = results.map((r) => r.result).filter((t) => t && t.trim()).join('\n');
    console.debug(LOG, 'Selection lookup complete', { found: Boolean(text), textLength: text.length });
    if (text) {
      $('text').value = text;
      schedulePreview();
    }
  } catch (error) {
    // Not allowed on this page (e.g. chrome:// pages) – the user can paste text instead.
    console.debug(LOG, 'Selection is unavailable on the active page', error.name || 'Error');
  }
}

$('target-list').addEventListener('change', async (event) => {
  try {
    const stored = await chrome.storage.sync.get(STORAGE_KEYS.settings);
    const settings = { ...(stored[STORAGE_KEYS.settings] || {}), targetListId: event.target.value };
    await chrome.storage.sync.set({ [STORAGE_KEYS.settings]: settings });
    console.info(LOG, 'Target list setting saved');
    schedulePreview();
  } catch (error) {
    console.warn(LOG, 'Could not save target list setting', error.name || 'Error', error.message);
  }
});

$('sync').addEventListener('click', async () => {
  setText($('sync-status'), 'Hämtar listor…');
  console.info(LOG, 'Manual list sync requested');
  try {
    const response = await send(MESSAGES.syncLists);
    if (!response.ok) setText($('sync-status'), response.error, true);
    else await refresh();
    schedulePreview();
  } catch (error) {
    console.warn(LOG, 'Manual list sync failed', error.name || 'Error', error.message);
    setText($('sync-status'), 'Listorna kunde inte hämtas.', true);
  }
});

$('text').addEventListener('input', schedulePreview);
$('grab').addEventListener('click', grabSelection);

$('send').addEventListener('click', async () => {
  setText($('result'), 'Skickar…');
  console.info(LOG, 'Send requested', { inputLength: $('text').value.length });
  try {
    const response = await send(MESSAGES.sendText, { text: $('text').value });
    console.info(LOG, 'Send request completed', { ok: Boolean(response && response.ok), queued: Boolean(response && response.queued) });
    setText($('result'), response.ok ? response.message : response.error, !response.ok);
  } catch (error) {
    console.warn(LOG, 'Send request failed', error.name || 'Error', error.message);
    setText($('result'), 'Skickningen misslyckades.', true);
  }
});

$('open-options').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.commands.getAll((commands) => {
  const command = commands.find((c) => c.name === 'send-selection');
  if (command && command.shortcut) $('shortcut').textContent = command.shortcut;
});

refresh().then(grabSelection).catch((error) => {
  console.warn(LOG, 'Popup initialization failed', error.name || 'Error', error.message);
  setText($('result'), 'Tillägget kunde inte läsa sitt tillstånd.', true);
});
