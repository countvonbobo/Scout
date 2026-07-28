import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityState, applyScoutState, frameOffset, framePosition, scoutAnchor, scoutDefinition, scoutTiming,
  SCOUT_ANCHORS, SCOUT_STATES,
} from './scoutCharacter.mjs';

const CALM_STATES = ['idle', 'listening', 'sleeping'];
const ACTION_STATES = ['searching', 'writing', 'success'];

function fakeSprite() {
  const style = {
    values: new Map(),
    setProperty(name, value) { this.values.set(name, String(value)); },
    getPropertyValue(name) { return this.values.get(name) ?? ''; },
  };
  const classes = new Set();
  return {
    style,
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), has: (name) => classes.has(name) },
    matches: (selector) => selector === '.scout-sprite',
  };
}

function fakeCharacter() {
  const sprite = fakeSprite();
  const attributes = new Map();
  return {
    sprite,
    dataset: {},
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: (name) => attributes.get(name) ?? null,
    matches: () => false,
    querySelector: () => sprite,
  };
}

test('unknown character state falls back to idle', () => {
  assert.equal(scoutDefinition('missing'), scoutDefinition('idle'));
});

test('frame position clamps and maps across the sprite grid', () => {
  const def = { columns: 4, frames: 16 };
  assert.deepEqual(framePosition(6, def), { column: 2, row: 1 });
  assert.deepEqual(framePosition(99, def), { column: 3, row: 3 });
});

test('tool activity maps to semantic Scout states', () => {
  assert.equal(activityState('reading job advert'), 'searching');
  assert.equal(activityState('editing applications/acme/cv.typ'), 'writing');
  assert.equal(activityState('unknown tool'), 'thinking');
});

test('every sprite state resolves to a numeric two-axis anchor and a label', () => {
  for (const state of Object.keys(SCOUT_STATES)) {
    const definition = scoutDefinition(state);
    const anchor = scoutAnchor(definition);
    assert.ok(Number.isFinite(anchor.x), `${state} needs a numeric x anchor`);
    assert.ok(Number.isFinite(anchor.y), `${state} needs a numeric y anchor`);
    assert.ok(definition.label, `${state} needs an accessible label`);
  }
});

test('anchors are declared once per sprite sheet, never per state or per frame', () => {
  for (const [state, definition] of Object.entries(SCOUT_STATES)) {
    assert.equal(definition.align, undefined, `${state} must not carry its own anchor`);
    assert.equal(definition.anchors, undefined, `${state} must not carry per-frame anchors`);
    assert.ok(SCOUT_ANCHORS[definition.src], `${state} needs an anchor for ${definition.src}`);
  }
  // States drawn from one sheet resolve to one anchor, so switching between them
  // cannot move Scout.
  const bySheet = new Map();
  for (const [state, definition] of Object.entries(SCOUT_STATES)) {
    const seen = bySheet.get(definition.src);
    const anchor = scoutAnchor(definition);
    if (seen) assert.deepEqual(anchor, seen.anchor, `${state} must match ${seen.state} on ${definition.src}`);
    else bySheet.set(definition.src, { state, anchor });
  }
  // Sheets genuinely differ on both axes, so one shared anchor is not enough.
  assert.ok(new Set([...bySheet.values()].map((entry) => entry.anchor.x)).size > 1);
  assert.ok(new Set([...bySheet.values()].map((entry) => entry.anchor.y)).size > 1);
});

test('an unknown sprite sheet resolves to a neutral anchor rather than throwing', () => {
  assert.deepEqual(scoutAnchor({ src: '/assets/not-a-sheet.png' }), { x: 0, y: 0 });
});

test('animation length is derived from each state\'s own frame count and frame rate', () => {
  for (const [state, definition] of Object.entries(SCOUT_STATES)) {
    const timing = scoutTiming(definition);
    assert.equal(timing.duration, definition.frames / definition.fps, `${state} duration must follow its own fps`);
    assert.equal(timing.rowDuration, definition.columns / definition.fps, `${state} row sweep must follow its own fps`);
    assert.equal(timing.rowIterations, definition.loop ? 'infinite' : '1');
    assert.equal(timing.columnIterations, definition.loop ? 'infinite' : String(definition.rows));
  }
});

test('calm states animate more slowly than action states', () => {
  const slowest = (states) => Math.min(...states.map((s) => scoutTiming(scoutDefinition(s)).duration));
  const fastest = (states) => Math.max(...states.map((s) => scoutTiming(scoutDefinition(s)).duration));
  assert.ok(
    slowest(CALM_STATES) > fastest(ACTION_STATES),
    `calm ${slowest(CALM_STATES)}s must outlast action ${fastest(ACTION_STATES)}s`,
  );
});

test('every frame of every state lands on a whole sprite cell', () => {
  for (const [state, definition] of Object.entries(SCOUT_STATES)) {
    assert.equal(definition.frames, definition.columns * definition.rows, `${state} must fill its grid exactly`);
    for (let frame = 0; frame < definition.frames; frame += 1) {
      const { column, row } = framePosition(frame, definition);
      assert.ok(Number.isInteger(column) && column >= 0 && column < definition.columns, `${state} frame ${frame} column`);
      assert.ok(Number.isInteger(row) && row >= 0 && row < definition.rows, `${state} frame ${frame} row`);
    }
  }
});

test('frame offsets are exact integer fractions, never rounded decimals', () => {
  const exact = /^(?:0%|100%|calc\(100% \* \d+ \/ \d+\))$/;
  for (const [state, definition] of Object.entries(SCOUT_STATES)) {
    for (let frame = 0; frame < definition.frames; frame += 1) {
      const offset = frameOffset(frame, definition);
      assert.match(offset.x, exact, `${state} frame ${frame} x offset must stay exact`);
      assert.match(offset.y, exact, `${state} frame ${frame} y offset must stay exact`);
    }
  }
});

test('applyScoutState publishes the state\'s own timing, anchor and still frame', () => {
  const element = fakeCharacter();
  applyScoutState(element, 'sleeping');
  const definition = scoutDefinition('sleeping');
  const read = (name) => element.sprite.style.getPropertyValue(name);
  assert.equal(read('--scout-duration'), `${definition.frames / definition.fps}s`);
  assert.equal(read('--scout-row-duration'), `${definition.columns / definition.fps}s`);
  assert.equal(read('--scout-columns'), String(definition.columns));
  assert.equal(read('--scout-rows'), String(definition.rows));
  assert.equal(read('--scout-align-x'), `${scoutAnchor(definition).x}%`);
  assert.equal(read('--scout-align-y'), `${scoutAnchor(definition).y}%`);
  assert.equal(element.getAttribute('aria-label'), definition.label);
});

test('reduced motion pins the configured representative frame instead of frame zero', () => {
  const element = fakeCharacter();
  applyScoutState(element, 'success', { reducedMotion: true });
  const definition = scoutDefinition('success');
  const expected = frameOffset(definition.reducedMotionFrame, definition);
  assert.ok(definition.reducedMotionFrame > 0, 'this state must not fall back to frame zero');
  assert.equal(element.sprite.style.getPropertyValue('--scout-still-x'), expected.x);
  assert.equal(element.sprite.style.getPropertyValue('--scout-still-y'), expected.y);
  assert.ok(element.sprite.classList.has('reduced-motion'));
});

test('non-looping states stop after a single pass', () => {
  for (const state of ['found', 'success', 'warning', 'welcome']) {
    const timing = scoutTiming(scoutDefinition(state));
    assert.equal(timing.rowIterations, '1', `${state} must not loop`);
  }
});
