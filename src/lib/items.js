// Helpers for comparing parsed items with the rows already on an ICA list and
// deciding whether each item should be added or update an existing row.

/** Normalizes an item name for comparison ("  Krossade  Tomater " -> "krossade tomater"). */
export function normalizeName(name) {
  return String(name ?? '')
    .toLocaleLowerCase('sv-SE')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatQuantity(quantity) {
  return String(Math.round(quantity * 100) / 100).replace('.', ',');
}

/**
 * Formats an item as the free text that is typed into ICA's "add item" input,
 * e.g. { quantity: 2, unit: 'dl', name: 'Mjölk' } -> "2 dl Mjölk".
 * ASSUMPTION: ICA's input accepts free text and interprets quantity/unit itself.
 */
export function formatItemText(item) {
  const parts = [];
  if (item.quantity) parts.push(formatQuantity(item.quantity));
  if (item.quantity && item.unit) parts.push(item.unit);
  parts.push(item.name);
  return parts.join(' ');
}

/** Combines duplicate items (same name and unit) by summing their quantities. */
export function mergeDuplicates(items) {
  const merged = new Map();
  for (const item of items) {
    const key = `${normalizeName(item.name)}|${item.unit ?? ''}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...item });
    } else if (existing.quantity !== null || item.quantity !== null) {
      existing.quantity = (existing.quantity ?? 1) + (item.quantity ?? 1);
    }
  }
  return [...merged.values()];
}

/**
 * Creates a change plan for a list.
 *
 * @param {Array} items parsed items ({ name, quantity, unit })
 * @param {Array} rows existing rows on the target list ({ id, name, quantity, unit, checked })
 * @param {object} [options]
 * @param {boolean} [options.mergeQuantities=true] update quantity on existing rows instead of adding duplicates
 * @returns {Array} changes: { action: 'add' | 'update' | 'skip', item, row?, text, quantity?, unit?, addText? }
 */
export function planChanges(items, rows = [], { mergeQuantities = true } = {}) {
  const openRows = new Map();
  for (const row of rows) {
    if (row.checked) continue;
    const key = normalizeName(row.name);
    if (!openRows.has(key)) openRows.set(key, row);
  }

  return mergeDuplicates(items).map((item) => {
    const row = mergeQuantities ? openRows.get(normalizeName(item.name)) : undefined;
    if (!row) {
      return { action: 'add', item, text: formatItemText(item) };
    }

    if (item.quantity === null) {
      return { action: 'skip', item, row, text: formatItemText(item), reason: 'already-on-list' };
    }
    if (row.quantity && (row.unit ?? null) !== (item.unit ?? null)) {
      // Different units cannot be summed – add as a separate row instead.
      return { action: 'add', item, text: formatItemText(item) };
    }

    const quantity = (row.quantity ?? 0) + item.quantity;
    const unit = row.quantity ? row.unit ?? null : item.unit ?? null;
    return {
      action: 'update',
      item,
      row,
      quantity,
      unit,
      text: formatItemText({ name: row.name, quantity, unit }),
      // Used when the row cannot be edited in ICA's UI and the item is added as a new row instead.
      addText: formatItemText(item)
    };
  });
}
