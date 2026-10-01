// Content script running on ICA's shopping list pages.
//
// Responsibilities:
//  * Tell the background worker that a shopping list page is open (triggers list download).
//  * Apply add/update changes by driving ICA's web UI (selectors in ica-selectors.js).
//  * Scrape lists from the DOM as a fallback when the API cannot be used.
//
// Classic content scripts cannot import ES modules, so message types are
// duplicated here; keep them in sync with MESSAGES in src/lib/config.js.

(() => {
  const LOG = '[ICA][content]';
  if (globalThis.__icaShoppingListContentLoaded) {
    console.debug(LOG, 'Duplicate content-script injection ignored');
    return;
  }
  globalThis.__icaShoppingListContentLoaded = true;

  const MESSAGES = {
    icaPageOpened: 'ica-page-opened',
    icaGetPending: 'ica-get-pending',
    icaReportResult: 'ica-report-result',
    icaApplyChanges: 'ica-apply-changes',
    icaScrapeLists: 'ica-scrape-lists'
  };

  const S = globalThis.ICA_SELECTORS;
  const T = globalThis.ICA_UI_TIMING;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function normalize(text) {
    return String(text ?? '').toLocaleLowerCase('sv-SE').replace(/\s+/g, ' ').trim();
  }

  function textOf(root, selector) {
    const element = selector ? root.querySelector(selector) : root;
    return element ? element.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function waitFor(selector, timeout = T.waitForElementMs) {
    const existing = document.querySelector(selector);
    if (existing) return Promise.resolve(existing);
    console.debug(LOG, 'Waiting for page element', { selector, timeout });
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const element = document.querySelector(selector);
        if (element) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(element);
        }
      });
      const timer = setTimeout(() => {
        observer.disconnect();
        console.warn(LOG, 'Timed out waiting for page element', { selector, timeout });
        resolve(null);
      }, timeout);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    });
  }

  // Sets the value in a way that frameworks such as React pick up.
  function setNativeValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
    if (descriptor && descriptor.set) descriptor.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function pressEnter(element) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      element.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
  }

  function submit(input, buttonSelector) {
    const button = buttonSelector && document.querySelector(buttonSelector);
    if (button && !button.disabled) button.click();
    else pressEnter(input);
  }

  // --- Reading the page ----------------------------------------------------

  function parseQuantity(text) {
    const match = String(text).match(/(\d+(?:[.,]\d+)?)\s*(\S*)/);
    if (!match) return { quantity: null, unit: null };
    return { quantity: Number(match[1].replace(',', '.')), unit: match[2] || null };
  }

  function readRow(row) {
    const { quantity, unit } = parseQuantity(textOf(row, S.itemQuantity));
    return {
      name: textOf(row, S.itemName),
      quantity,
      unit,
      checked: Boolean(row.matches(S.itemChecked) || row.querySelector(S.itemChecked))
    };
  }

  function currentListName() {
    return document.querySelector(S.addItemInput) ? textOf(document, S.listTitle) : null;
  }

  function scrapeLists() {
    const openList = currentListName();
    if (openList !== null) {
      const rows = [...document.querySelectorAll(S.itemRow)].map(readRow).filter((row) => row.name);
      console.debug(LOG, 'Scraped open ICA list', { listCount: 1, rowCount: rows.length });
      return [{ id: openList, name: openList, rows }];
    }
    const lists = [...document.querySelectorAll(S.listCard)]
      .map((card) => textOf(card, S.listCardTitle))
      .filter(Boolean)
      .map((name) => ({ id: name, name, rows: [] }));
    console.debug(LOG, 'Scraped ICA list overview', { listCount: lists.length });
    return lists;
  }

  // --- Driving the UI ------------------------------------------------------

  async function openList(listName) {
    const current = currentListName();
    if (current !== null && (!listName || normalize(current) === normalize(listName))) {
      console.debug(LOG, 'Target list is already open');
      return;
    }

    if (listName) {
      const card = [...document.querySelectorAll(S.listCard)]
        .find((candidate) => normalize(textOf(candidate, S.listCardTitle)) === normalize(listName));
      if (card) {
        console.debug(LOG, 'Opening target list');
        (card.querySelector('a, button') || card).click();
      } else {
        console.warn(LOG, 'Target list card was not found; waiting for add-item field');
      }
    }
    if (!(await waitFor(S.addItemInput))) {
      throw new Error('Kunde inte hitta inköpslistan på sidan (fältet för att lägga till varor saknas).');
    }
  }

  async function addItem(text) {
    const input = await waitFor(S.addItemInput);
    if (!input) throw new Error('Fältet för att lägga till varor hittades inte.');
    input.focus();
    setNativeValue(input, text);
    submit(input, S.addItemButton);
    console.debug(LOG, 'Submitted add-item action');
    await sleep(T.afterActionMs);
  }

  function findRow(name) {
    return [...document.querySelectorAll(S.itemRow)].find((row) => {
      const data = readRow(row);
      return !data.checked && normalize(data.name) === normalize(name);
    });
  }

  // Returns true if the row was updated in place, false if it fell back to adding a new row.
  async function updateItem(change) {
    const row = findRow(change.row.name);
    const opener = row && (row.querySelector(S.itemEditButton) || row.querySelector(S.itemName) || row);
    if (opener) {
      opener.click();
      const input = await waitFor(`${S.itemEditTextInput}, ${S.itemEditQuantityInput}`, T.waitForEditMs);
      if (input) {
        input.focus();
        setNativeValue(input, input.matches(S.itemEditTextInput) ? change.text : String(change.quantity));
        submit(input, S.itemEditSaveButton);
        console.debug(LOG, 'Submitted item update action');
        await sleep(T.afterActionMs);
        return true;
      }
    }
    // Edit UI not found – add the extra quantity as a separate row instead.
    console.warn(LOG, 'Edit controls unavailable; adding change as a separate row');
    await addItem(change.addText || change.text);
    return false;
  }

  async function applyChanges(payload) {
    const result = { ok: true, added: 0, updated: 0, skipped: 0, failed: [] };
    console.info(LOG, 'Apply flow started', { changeCount: (payload.changes || []).length, hasTargetList: Boolean(payload.listName) });
    try {
      await openList(payload.listName);
    } catch (error) {
      console.warn(LOG, 'Could not open target list', error.name || 'Error', error.message);
      return { ...result, ok: false, error: error.message };
    }

    for (const change of payload.changes || []) {
      try {
        if (change.action === 'skip') {
          result.skipped += 1;
        } else if (change.action === 'update') {
          if (await updateItem(change)) result.updated += 1;
          else result.added += 1;
        } else {
          await addItem(change.text);
          result.added += 1;
        }
      } catch (error) {
        console.warn(LOG, 'Change failed', { action: change.action, errorName: error.name || 'Error', error: error.message });
        result.failed.push({ text: change.text, error: error.message });
      }
    }
    result.ok = result.failed.length === 0;
    console.info(LOG, 'Apply flow complete', {
      ok: result.ok,
      added: result.added,
      updated: result.updated,
      skipped: result.skipped,
      failed: result.failed.length
    });
    return result;
  }

  // Serialize UI operations so concurrent requests do not interleave.
  let queue = Promise.resolve();
  function enqueue(task) {
    console.debug(LOG, 'Queued page operation');
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !message) return false;
    if (message.type === MESSAGES.icaApplyChanges) {
      console.debug(LOG, 'Received apply request', { tabId: sender.tab && sender.tab.id });
      enqueue(() => applyChanges(message.payload)).then(sendResponse, (error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === MESSAGES.icaScrapeLists) {
      console.debug(LOG, 'Received list-scrape request', { tabId: sender.tab && sender.tab.id });
      sendResponse({ ok: true, lists: scrapeLists() });
      return false;
    }
    return false;
  });

  async function init() {
    try {
      console.info(LOG, 'Content script initialized', { readyState: document.readyState });
      await chrome.runtime.sendMessage({ type: MESSAGES.icaPageOpened, url: location.href });
      const pending = await chrome.runtime.sendMessage({ type: MESSAGES.icaGetPending });
      const payloads = (pending && pending.payloads) || [];
      console.info(LOG, 'Initialization received pending changes', { payloadCount: payloads.length });
      for (const payload of payloads) {
        const result = await enqueue(() => applyChanges(payload));
        await chrome.runtime.sendMessage({ type: MESSAGES.icaReportResult, result });
      }
    } catch (error) {
      console.warn(LOG, 'Initialization failed', error.name || 'Error', error.message);
    }
  }

  init();
})();
