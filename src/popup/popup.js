import { MESSAGES, STORAGE_KEYS } from '../lib/config.js';

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
  const state = await send(MESSAGES.getState);
  renderLogin(state);
  renderLists(state);
  if (state.pending) setText($('result'), `${state.pending} sändning(ar) väntar på ICA-fliken.`);
  return state;
}

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const response = await send(MESSAGES.previewText, { text: $('text').value });
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
    if (text) {
      $('text').value = text;
      schedulePreview();
    }
  } catch {
    // Not allowed on this page (e.g. chrome:// pages) – the user can paste text instead.
  }
}

$('target-list').addEventListener('change', async (event) => {
  const stored = await chrome.storage.sync.get(STORAGE_KEYS.settings);
  const settings = { ...(stored[STORAGE_KEYS.settings] || {}), targetListId: event.target.value };
  await chrome.storage.sync.set({ [STORAGE_KEYS.settings]: settings });
  schedulePreview();
});

$('sync').addEventListener('click', async () => {
  setText($('sync-status'), 'Hämtar listor…');
  const response = await send(MESSAGES.syncLists);
  if (!response.ok) setText($('sync-status'), response.error, true);
  else await refresh();
  schedulePreview();
});

$('text').addEventListener('input', schedulePreview);
$('grab').addEventListener('click', grabSelection);

$('send').addEventListener('click', async () => {
  setText($('result'), 'Skickar…');
  const response = await send(MESSAGES.sendText, { text: $('text').value });
  setText($('result'), response.ok ? response.message : response.error, !response.ok);
});

$('open-options').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.commands.getAll((commands) => {
  const command = commands.find((c) => c.name === 'send-selection');
  if (command && command.shortcut) $('shortcut').textContent = command.shortcut;
});

refresh().then(grabSelection);
