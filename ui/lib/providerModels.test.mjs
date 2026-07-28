import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectedModels,
  effectiveProviderModel,
  isSafeModelId,
  parseCodexModelCatalogue,
  providerModelCatalogue,
  providerModels,
} from './providerModels.mjs';

test('Claude offers curated models merged with the ones used on this machine', () => {
  const models = providerModels('claude', { detected: ['claude-sonnet-5', 'claude-experimental-x'], configured: null });
  const ids = models.map((model) => model.id);
  assert.ok(ids.includes('claude-opus-4-8'));
  // A model seen locally but absent from the curated list is still offered.
  assert.ok(ids.includes('claude-experimental-x'));
  assert.equal(new Set(ids).size, ids.length, 'ids must be deduplicated');
  assert.equal(models.find((model) => model.id === 'claude-sonnet-5').detected, true);
  assert.equal(models.find((model) => model.id === 'claude-opus-4-8').detected, false);
});

test('Codex offers only the configured model, never a guessed identifier', () => {
  assert.deepEqual(providerModels('codex', { detected: [], configured: null }), []);
  assert.deepEqual(
    providerModels('codex', { detected: [], configured: 'gpt-5.6-sol' }).map((model) => model.id),
    ['gpt-5.6-sol'],
  );
});

test('unsafe identifiers never reach the picker', () => {
  assert.equal(isSafeModelId('claude-opus-4-8'), true);
  assert.equal(isSafeModelId('model & command'), false);
  const models = providerModels('claude', { detected: ['<synthetic>', 'rm -rf /'], configured: 'bad;id' });
  assert.equal(models.some((model) => !isSafeModelId(model.id)), false);
});

test('detection reads real Claude model ids and never guesses for Codex', () => {
  const detected = detectedModels({
    claude: { byModel: [{ model: 'claude-opus-4-8' }, { model: '<synthetic>' }] },
    codex: { models: ['codex-auto-review'] },
  });
  assert.deepEqual(detected.claude, ['claude-opus-4-8']);
  // Codex session logs record collaboration-mode names in the same field as
  // models, so nothing is detected for it.
  assert.deepEqual(detected.codex, []);
});

test('a refreshed Codex catalogue exposes readable capable, balanced and fast choices', () => {
  const catalogue = providerModelCatalogue('codex', {
    state: 'refreshed',
    models: [
      { id: 'gpt-5.6-sol', isDefault: true },
      { id: 'gpt-5.6-terra', isDefault: false },
      { id: 'gpt-5.6-luna', isDefault: false },
    ],
  });
  assert.deepEqual(catalogue.map((model) => model.id), [
    'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  ]);
  assert.deepEqual(catalogue.map((model) => model.source), ['refreshed', 'refreshed', 'refreshed']);
  assert.deepEqual(catalogue.map((model) => model.available), [true, true, true]);
  assert.match(catalogue[0].label, /Sol/i);
  assert.match(catalogue[0].tradeoff, /capable/i);
  assert.match(catalogue[1].tradeoff, /balanced|everyday/i);
  assert.match(catalogue[2].tradeoff, /fast|repeatable/i);
  for (const model of catalogue) {
    assert.deepEqual(Object.keys(model).sort(), [
      'available', 'id', 'label', 'selected', 'source', 'tradeoff',
    ]);
  }
});

test('unsupported Codex enumeration uses an explicitly bundled fallback', () => {
  const catalogue = providerModelCatalogue('codex', { state: 'unsupported', models: [] });
  assert.ok(catalogue.length >= 3);
  assert.ok(catalogue.every((model) => model.source === 'bundled'));
  assert.ok(catalogue.every((model) => model.available === 'unknown'));
});

test('effective configured model is identified when refreshed and stale when absent', () => {
  const freshCatalogue = providerModelCatalogue('codex', {
    state: 'refreshed',
    configured: 'gpt-5.6-terra',
    models: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-terra' }],
  });
  const fresh = effectiveProviderModel('codex', { configured: 'gpt-5.6-terra' }, freshCatalogue);
  assert.equal(fresh.id, 'gpt-5.6-terra');
  assert.equal(fresh.available, true);
  assert.equal(fresh.known, true);
  assert.equal(freshCatalogue.find((model) => model.id === fresh.id).selected, true);

  const staleCatalogue = providerModelCatalogue('codex', {
    state: 'refreshed',
    configured: 'gpt-old-stale',
    models: [{ id: 'gpt-5.6-sol', isDefault: true }],
  });
  const stale = effectiveProviderModel('codex', { configured: 'gpt-old-stale' }, staleCatalogue);
  assert.equal(stale.id, 'gpt-old-stale');
  assert.equal(stale.available, false);
  assert.equal(stale.known, true);
  assert.equal(staleCatalogue.find((model) => model.id === 'gpt-old-stale').selected, false);
});

test('a provider-rejected model is unavailable and a deliberate safe custom ID stays unknown', () => {
  const catalogue = providerModelCatalogue('codex', {
    state: 'refreshed',
    configured: 'gpt-5.6-terra',
    custom: ['safe-custom:model'],
    rejected: ['gpt-5.6-terra'],
    models: [{ id: 'gpt-5.6-terra' }],
  });
  const rejected = catalogue.find((model) => model.id === 'gpt-5.6-terra');
  assert.equal(rejected.available, false);
  assert.equal(rejected.selected, false);
  assert.match(rejected.tradeoff, /rejected/i);
  assert.deepEqual(catalogue.find((model) => model.id === 'safe-custom:model'), {
    id: 'safe-custom:model',
    label: 'safe-custom:model',
    tradeoff: 'Custom exact model ID; availability is checked when the provider runs.',
    source: 'custom',
    available: 'unknown',
    selected: false,
  });
  assert.equal(catalogue.some((model) => model.id === 'bad;command'), false);
});

test('Codex session-log models never become catalogue availability evidence', () => {
  const catalogue = providerModelCatalogue('codex', {
    state: 'unsupported',
    detected: ['codex-auto-review', 'gpt-session-ambiguous'],
  });
  assert.equal(catalogue.some((model) => model.id === 'codex-auto-review'), false);
  assert.equal(catalogue.some((model) => model.id === 'gpt-session-ambiguous'), false);
});

test('duplicate model IDs keep one record with refreshed provenance', () => {
  const catalogue = providerModelCatalogue('codex', {
    state: 'refreshed',
    configured: 'gpt-5.6-sol',
    custom: ['gpt-5.6-sol'],
    models: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-sol' }],
  });
  assert.equal(catalogue.filter((model) => model.id === 'gpt-5.6-sol').length, 1);
  assert.equal(catalogue[0].source, 'refreshed');
  assert.equal(catalogue[0].selected, true);
});

test('Codex catalogue parser accepts only bounded structured model IDs', () => {
  const parsed = parseCodexModelCatalogue(JSON.stringify({
    models: [
      {
        slug: 'gpt-5.6-sol',
        display_name: 'Person <person@example.test>',
        description: '/Users/example/.codex token=secret-value',
        is_default: true,
        base_instructions: 'private raw provider content',
      },
      { model: 'gpt-5.6-terra', isDefault: false },
      { slug: 'bad;command' },
    ],
  }));
  assert.deepEqual(parsed, {
    models: [
      { id: 'gpt-5.6-sol', isDefault: true },
      { id: 'gpt-5.6-terra', isDefault: false },
    ],
  });
  assert.doesNotMatch(JSON.stringify(parsed), /person@|Users|token|secret|instructions/);
  assert.throws(() => parseCodexModelCatalogue('{'), /invalid model catalogue/i);
  assert.throws(() => parseCodexModelCatalogue(JSON.stringify({ models: 'wrong' })), /invalid model catalogue/i);
  assert.throws(() => parseCodexModelCatalogue('x'.repeat(600_000)), /too large/i);
});

test('Codex catalogue parser follows the installed CLI list visibility and priority shape', () => {
  const parsed = parseCodexModelCatalogue(JSON.stringify({
    models: [
      { slug: 'gpt-5.6-terra', visibility: 'list', priority: 2 },
      { slug: 'codex-auto-review', visibility: 'hide', priority: 1 },
      { slug: 'gpt-5.6-sol', visibility: 'list', priority: 1 },
    ],
  }));
  assert.deepEqual(parsed.models, [
    { id: 'gpt-5.6-terra', isDefault: false },
    { id: 'gpt-5.6-sol', isDefault: true },
  ]);
});
