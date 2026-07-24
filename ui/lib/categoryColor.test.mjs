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

function linearizeChannel(c) {
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.2126 * linearizeChannel(r) + 0.7152 * linearizeChannel(g) + 0.0722 * linearizeChannel(b);
}

function contrastRatio(hexA, hexB) {
  const lumA = relativeLuminance(hexA);
  const lumB = relativeLuminance(hexB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

test('every palette entry meets WCAG AA contrast (4.5:1) for normal-weight 11px text', () => {
  for (const entry of CATEGORY_PALETTE) {
    const ratio = contrastRatio(entry.bg, entry.fg);
    assert.ok(ratio >= 4.5, `${entry.bg}/${entry.fg} contrast is ${ratio.toFixed(2)}, expected >= 4.5`);
  }
});
