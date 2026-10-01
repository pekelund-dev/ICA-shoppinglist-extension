import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterLists, normalizeLists } from '../src/lib/lists.js';

test('normalizes PascalCase API responses', () => {
  const lists = normalizeLists({
    ShoppingLists: [{
      OfflineId: 'abc',
      Title: 'Veckohandling',
      Rows: [
        { RowId: 1, ProductName: 'Mjölk', Quantity: '2', Unit: 'l', IsStrikedOver: false },
        { RowId: 2, ProductName: 'Ägg', Quantity: null, IsStrikedOver: true }
      ]
    }]
  });
  assert.deepEqual(lists, [{
    id: 'abc',
    name: 'Veckohandling',
    rows: [
      { id: 1, name: 'Mjölk', quantity: 2, unit: 'l', checked: false },
      { id: 2, name: 'Ägg', quantity: null, unit: null, checked: true }
    ]
  }]);
});

test('normalizes camelCase arrays and scraped data', () => {
  const lists = normalizeLists([{ id: 7, name: 'Fest', items: [{ name: 'Chips', checked: true }, 'Dipp', { name: '' }] }]);
  assert.equal(lists[0].id, '7');
  assert.deepEqual(lists[0].rows.map((r) => r.name), ['Chips', 'Dipp']);
});

test('handles unexpected input', () => {
  assert.deepEqual(normalizeLists(null), []);
  assert.deepEqual(normalizeLists({ foo: 'bar' }), []);
});

test('filters checked rows unless includeChecked is set', () => {
  const lists = normalizeLists([{ id: 'a', name: 'A', rows: [{ name: 'X', checked: true }, { name: 'Y' }] }]);
  assert.deepEqual(filterLists(lists).at(0).rows.map((r) => r.name), ['Y']);
  assert.deepEqual(filterLists(lists, { includeChecked: true }).at(0).rows.map((r) => r.name), ['X', 'Y']);
});
