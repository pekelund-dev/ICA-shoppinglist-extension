// Normalizes shopping list data from ICA into the internal format used by the
// extension. ASSUMPTION: the exact shape of ICA's API response is unknown, so
// several common field names (PascalCase and camelCase) are accepted.

function pick(object, keys) {
  for (const key of keys) {
    if (object && object[key] !== undefined && object[key] !== null) return object[key];
  }
  return undefined;
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

/** Normalizes one row (item) on a list. */
export function normalizeRow(raw) {
  if (typeof raw === 'string') {
    return { id: null, name: raw.trim(), quantity: null, unit: null, checked: false };
  }
  const name = pick(raw, ['ProductName', 'productName', 'Text', 'text', 'Name', 'name', 'title']);
  return {
    id: pick(raw, ['RowId', 'rowId', 'OfflineId', 'offlineId', 'Id', 'id']) ?? null,
    name: typeof name === 'string' ? name.trim() : '',
    quantity: toNumber(pick(raw, ['Quantity', 'quantity', 'amount'])),
    unit: pick(raw, ['Unit', 'unit']) ?? null,
    checked: Boolean(pick(raw, ['IsStrikedOver', 'isStrikedOver', 'Checked', 'checked', 'isChecked', 'done']))
  };
}

/** Normalizes one list. */
export function normalizeList(raw) {
  const rows = pick(raw, ['Rows', 'rows', 'Items', 'items', 'ShoppingListRows', 'shoppingListRows']) ?? [];
  return {
    id: String(pick(raw, ['OfflineId', 'offlineId', 'Id', 'id', 'listId']) ?? ''),
    name: String(pick(raw, ['Title', 'title', 'Name', 'name']) ?? '').trim(),
    rows: Array.isArray(rows) ? rows.map(normalizeRow).filter((row) => row.name) : []
  };
}

/** Normalizes an API response that contains several lists. */
export function normalizeLists(response) {
  const lists = Array.isArray(response)
    ? response
    : pick(response, ['ShoppingLists', 'shoppingLists', 'Lists', 'lists', 'data']) ?? [];
  return Array.isArray(lists) ? lists.map(normalizeList).filter((list) => list.id || list.name) : [];
}

/** Removes already shopped (checked) rows unless includeChecked is true. */
export function filterLists(lists, { includeChecked = false } = {}) {
  if (includeChecked) return lists;
  return lists.map((list) => ({ ...list, rows: list.rows.filter((row) => !row.checked) }));
}
