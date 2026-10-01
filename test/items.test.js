import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatItemText, mergeDuplicates, normalizeName, planChanges } from '../src/lib/items.js';

const item = (name, quantity = null, unit = null) => ({ name, quantity, unit });

test('normalizes names', () => {
  assert.equal(normalizeName('  Krossade   TOMATER '), 'krossade tomater');
  assert.equal(normalizeName('Ägg'), 'ägg');
});

test('formats item text for the ICA input', () => {
  assert.equal(formatItemText(item('Mjölk', 2, 'dl')), '2 dl Mjölk');
  assert.equal(formatItemText(item('Grädde', 1.5, 'dl')), '1,5 dl Grädde');
  assert.equal(formatItemText(item('Ägg', 6)), '6 Ägg');
  assert.equal(formatItemText(item('Salt')), 'Salt');
});

test('merges duplicate items', () => {
  const merged = mergeDuplicates([item('Mjölk', 2, 'dl'), item('mjölk', 1, 'dl'), item('Salt'), item('salt')]);
  assert.deepEqual(merged.map(({ name, quantity }) => [name, quantity]), [['Mjölk', 3], ['Salt', null]]);
});

test('adds items that are not on the list', () => {
  const [change] = planChanges([item('Mjölk', 2, 'dl')], [item('Ägg', 6)]);
  assert.equal(change.action, 'add');
  assert.equal(change.text, '2 dl Mjölk');
});

test('updates the quantity of existing items with the same unit', () => {
  const rows = [{ id: 'r1', name: 'Mjölk', quantity: 1, unit: 'dl', checked: false }];
  const [change] = planChanges([item('mjölk', 2, 'dl')], rows);
  assert.equal(change.action, 'update');
  assert.equal(change.quantity, 3);
  assert.equal(change.text, '3 dl Mjölk');
  assert.equal(change.addText, '2 dl mjölk');
  assert.equal(change.row.id, 'r1');
});

test('sets the quantity on existing rows without quantity', () => {
  const [change] = planChanges([item('Ägg', 6)], [{ name: 'Ägg', quantity: null, unit: null }]);
  assert.equal(change.action, 'update');
  assert.equal(change.text, '6 Ägg');
});

test('skips items without quantity that already are on the list', () => {
  const [change] = planChanges([item('Salt')], [{ name: 'salt', quantity: 1, unit: 'st' }]);
  assert.equal(change.action, 'skip');
});

test('adds a new row when units differ', () => {
  const [change] = planChanges([item('Mjölk', 1, 'l')], [{ name: 'Mjölk', quantity: 2, unit: 'dl' }]);
  assert.equal(change.action, 'add');
});

test('ignores checked rows and respects mergeQuantities=false', () => {
  const rows = [{ name: 'Mjölk', quantity: 1, unit: 'dl', checked: true }];
  assert.equal(planChanges([item('Mjölk', 2, 'dl')], rows)[0].action, 'add');
  const openRows = [{ name: 'Mjölk', quantity: 1, unit: 'dl', checked: false }];
  assert.equal(planChanges([item('Mjölk', 2, 'dl')], openRows, { mergeQuantities: false })[0].action, 'add');
});
