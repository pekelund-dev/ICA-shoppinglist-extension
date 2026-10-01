import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseItems, parseLine, normalizeUnit } from '../src/lib/parser.js';

const pick = ({ name, quantity, unit }) => ({ name, quantity, unit });

test('parses quantity, unit and name', () => {
  assert.deepEqual(pick(parseLine('2 dl mjölk')), { name: 'mjölk', quantity: 2, unit: 'dl' });
  assert.deepEqual(pick(parseLine('500 g nötfärs')), { name: 'nötfärs', quantity: 500, unit: 'g' });
  assert.deepEqual(pick(parseLine('1 burk krossade tomater')), { name: 'krossade tomater', quantity: 1, unit: 'burk' });
  assert.deepEqual(pick(parseLine('3 ägg')), { name: 'ägg', quantity: 3, unit: null });
  assert.deepEqual(pick(parseLine('Salt')), { name: 'Salt', quantity: null, unit: null });
});

test('parses decimals, fractions and ranges', () => {
  assert.equal(parseLine('1,5 dl grädde').quantity, 1.5);
  assert.equal(parseLine('1.5 l vatten').quantity, 1.5);
  assert.equal(parseLine('½ tsk salt').quantity, 0.5);
  assert.equal(parseLine('1½ msk socker').quantity, 1.5);
  assert.equal(parseLine('1 1/2 dl mjöl').quantity, 1.5);
  assert.deepEqual(pick(parseLine('1/2 dl mjöl')), { name: 'mjöl', quantity: 0.5, unit: 'dl' });
  assert.deepEqual(pick(parseLine('2-3 tomater')), { name: 'tomater', quantity: 3, unit: null });
});

test('parses multipliers', () => {
  assert.deepEqual(pick(parseLine('2x mjölk')), { name: 'mjölk', quantity: 2, unit: null });
  assert.deepEqual(pick(parseLine('Bananer x 6')), { name: 'Bananer', quantity: 6, unit: null });
});

test('strips bullets, checkboxes and notes', () => {
  assert.equal(parseLine('- 2 st gul lök').name, 'gul lök');
  assert.equal(parseLine('• Smör').name, 'Smör');
  assert.equal(parseLine('[ ] Kaffe').name, 'Kaffe');
  assert.equal(parseLine('1. 2 dl mjölk').name, 'mjölk');
  const item = parseLine('2 klyftor vitlök (pressade)');
  assert.deepEqual(pick(item), { name: 'vitlök', quantity: 2, unit: 'klyfta' });
  assert.equal(item.note, 'pressade');
});

test('does not treat a lone unit-like word as a unit', () => {
  assert.deepEqual(pick(parseLine('2 burk')), { name: 'burk', quantity: 2, unit: null });
});

test('ignores headings, empty lines and lines without letters', () => {
  assert.equal(parseLine('Ingredienser:'), null);
  assert.equal(parseLine('   '), null);
  assert.equal(parseLine('123'), null);
});

test('splits text into items by lines, semicolons and commas', () => {
  const text = 'Ingredienser:\n2 dl mjölk\r\n\n3 ägg; 1 tsk salt\n';
  assert.deepEqual(parseItems(text).map((i) => i.name), ['mjölk', 'ägg', 'salt']);
  assert.deepEqual(parseItems('mjölk, ägg, smör').map((i) => i.name), ['mjölk', 'ägg', 'smör']);
  assert.deepEqual(parseItems('1,5 dl grädde').map(pick), [{ name: 'grädde', quantity: 1.5, unit: 'dl' }]);
  assert.deepEqual(parseItems(null), []);
});

test('normalizes unit aliases', () => {
  assert.equal(normalizeUnit('Liter'), 'l');
  assert.equal(normalizeUnit('tbsp'), 'msk');
  assert.equal(normalizeUnit('banan'), null);
});
