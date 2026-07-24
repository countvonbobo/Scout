import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATEGORY_PALETTE, categoryColor } from './categoryColor.mjs';

test('palette has eight distinct backgrounds with foregrounds', () => {
  assert.equal(CATEGORY_PALETTE.length, 8);
  const backgrounds = new Set(CATEGORY_PALETTE.map((c) => c.bg));
  assert.equal(backgrounds.size, 8);
  for (const entry of CATEGORY_PALETTE) {
    assert.match(entry.bg, /^#[0-9a-f]{6}$/i);
    assert.match(entry.fg, /^#[0-9a-f]{6}$/i);
  }
});

test('colour is assigned by index and is stable', () => {
  const ids = ['startup', 'established'];
  assert.deepEqual(categoryColor('startup', ids), CATEGORY_PALETTE[0]);
  assert.deepEqual(categoryColor('established', ids), CATEGORY_PALETTE[1]);
});

test('index wraps past the palette length', () => {
  const ids = Array.from({ length: 10 }, (_, i) => `c${i}`);
  assert.deepEqual(categoryColor('c8', ids), CATEGORY_PALETTE[0]);
  assert.deepEqual(categoryColor('c9', ids), CATEGORY_PALETTE[1]);
});

test('unknown category falls back to the first colour', () => {
  assert.deepEqual(categoryColor('missing', ['startup']), CATEGORY_PALETTE[0]);
});
