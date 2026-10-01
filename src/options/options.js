import { DEFAULT_SETTINGS, STORAGE_KEYS } from '../lib/config.js';

const form = document.getElementById('settings');
const saved = document.getElementById('saved');

async function load() {
  const stored = await chrome.storage.sync.get(STORAGE_KEYS.settings);
  const settings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) };
  for (const input of form.querySelectorAll('input[type="checkbox"]')) {
    input.checked = Boolean(settings[input.name]);
  }
}

form.addEventListener('change', async () => {
  const stored = await chrome.storage.sync.get(STORAGE_KEYS.settings);
  const settings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) };
  for (const input of form.querySelectorAll('input[type="checkbox"]')) {
    settings[input.name] = input.checked;
  }
  await chrome.storage.sync.set({ [STORAGE_KEYS.settings]: settings });
  saved.textContent = 'Sparat. Ändringen av avbockade varor gäller från nästa hämtning av listorna.';
});

load();
