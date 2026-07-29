// The single source of truth for Scout's animation. Frame count, frame rate,
// looping, the reduced-motion still frame and the per-state anchor all live
// here; the browser runtime reads them rather than imposing its own timing.

// Anchors are percentages of the render box, so one number centres a pose at
// any render size. There are exactly two sets, because the artwork forces
// exactly two — measured from the source PNGs' alpha, not tuned by eye.
//
// While Scout moves, the anchor is per sprite sheet: it centres the union of
// the frames the walk visits. asking, writing and explaining play the identical
// 16 frames of one sheet, so anything finer would render the same animation at
// a different offset per state — a visible sideways jump on every state change.
export const SCOUT_SHEET_ANCHORS = Object.freeze({
  '/assets/scout-idle.png': Object.freeze([4.067, 4.306]),
  '/assets/scout-explaining.png': Object.freeze([1.116, -1.515]),
  '/assets/scout-thinking.png': Object.freeze([3.748, 0.159]),
  '/assets/scout-searching.png': Object.freeze([1.994, 0.08]),
  '/assets/scout-found.png': Object.freeze([4.785, 0]),
  '/assets/scout-warning.png': Object.freeze([3.349, 0.08]),
});

// Reduced motion shows one still cell, and a still has to be centred on its own
// terms — the union anchor left several representative frames visibly off, e.g.
// found/success frame 15 at 44% and warning frame 12 at 58%. Keyed by sheet and
// representative frame, so idle/sleeping (both frame 0) and found/success (both
// frame 15) still share one anchor. Nothing is declared for frames that reduced
// motion never displays.
export const SCOUT_FRAME_ANCHORS = Object.freeze({
  '/assets/scout-idle.png|0': Object.freeze([-1.196, 2.313]),
  '/assets/scout-idle.png|2': Object.freeze([1.834, 2.313]),
  '/assets/scout-idle.png|12': Object.freeze([-0.558, 8.054]),
  '/assets/scout-explaining.png|6': Object.freeze([2.472, -1.994]),
  '/assets/scout-explaining.png|7': Object.freeze([8.852, -2.313]),
  '/assets/scout-explaining.png|8': Object.freeze([-7.895, -1.834]),
  '/assets/scout-thinking.png|9': Object.freeze([2.791, 4.386]),
  '/assets/scout-searching.png|8': Object.freeze([-0.239, 0.08]),
  '/assets/scout-found.png|15': Object.freeze([10.925, 2.632]),
  '/assets/scout-warning.png|12': Object.freeze([-4.386, 1.994]),
});

export const SCOUT_STATES = Object.freeze({
  idle: { src: '/assets/scout-idle.png', columns: 4, rows: 4, frames: 16, fps: 8, loop: true, reducedMotionFrame: 0, label: 'Scout is ready' },
  welcome: { src: '/assets/scout-idle.png', columns: 4, rows: 4, frames: 16, fps: 8, loop: false, reducedMotionFrame: 12, label: 'Scout welcomes you' },
  asking: { src: '/assets/scout-explaining.png', columns: 4, rows: 4, frames: 16, fps: 8, loop: true, reducedMotionFrame: 8, label: 'Scout is asking a question' },
  listening: { src: '/assets/scout-idle.png', columns: 4, rows: 4, frames: 16, fps: 6, loop: true, reducedMotionFrame: 2, label: 'Scout is listening' },
  thinking: { src: '/assets/scout-thinking.png', columns: 4, rows: 4, frames: 16, fps: 8, loop: true, reducedMotionFrame: 9, label: 'Scout is thinking' },
  searching: { src: '/assets/scout-searching.png', columns: 4, rows: 4, frames: 16, fps: 10, loop: true, reducedMotionFrame: 8, label: 'Scout is searching' },
  writing: { src: '/assets/scout-explaining.png', columns: 4, rows: 4, frames: 16, fps: 10, loop: true, reducedMotionFrame: 6, label: 'Scout is updating your files' },
  found: { src: '/assets/scout-found.png', columns: 4, rows: 4, frames: 16, fps: 10, loop: false, reducedMotionFrame: 15, label: 'Scout found a strong match' },
  explaining: { src: '/assets/scout-explaining.png', columns: 4, rows: 4, frames: 16, fps: 9, loop: true, reducedMotionFrame: 7, label: 'Scout is explaining' },
  success: { src: '/assets/scout-found.png', columns: 4, rows: 4, frames: 16, fps: 12, loop: false, reducedMotionFrame: 15, label: 'Scout finished successfully' },
  warning: { src: '/assets/scout-warning.png', columns: 4, rows: 4, frames: 16, fps: 8, loop: false, reducedMotionFrame: 12, label: 'Scout needs your attention' },
  sleeping: { src: '/assets/scout-idle.png', columns: 4, rows: 4, frames: 16, fps: 4, loop: true, reducedMotionFrame: 0, label: 'Scout is resting' },
});

export function scoutAnchor(definition, anchors = SCOUT_SHEET_ANCHORS) {
  const [x, y] = anchors[definition?.src] || [0, 0];
  return { x, y };
}

export function scoutStillAnchor(definition, anchors = SCOUT_FRAME_ANCHORS) {
  const [x, y] = anchors[`${definition?.src}|${definition?.reducedMotionFrame}`] || [0, 0];
  return { x, y };
}

export function scoutDefinition(state, definitions = SCOUT_STATES) {
  return definitions[state] || definitions.idle;
}

export function framePosition(frame, definition) {
  const safe = Math.max(0, Math.min(definition.frames - 1, Number(frame) || 0));
  return { column: safe % definition.columns, row: Math.floor(safe / definition.columns) };
}

// Background-position percentages are resolved against (box - sheet), so cell n
// of a c-column sheet sits at exactly 100% * n / (c - 1). Emitting the fraction
// as a calc() of two integers lets the browser resolve it at full precision:
// pre-rounded literals such as 33.333% left every middle cell a sliver off.
function axisOffset(index, count) {
  const last = Math.max(1, count - 1);
  if (index <= 0) return '0%';
  if (index >= last) return '100%';
  return `calc(100% * ${index} / ${last})`;
}

export function frameOffset(frame, definition) {
  const { column, row } = framePosition(frame, definition);
  return { x: axisOffset(column, definition.columns), y: axisOffset(row, definition.rows) };
}

// The exact cells the walk visits, in order: `frames` of them and no more. A
// grid-walking animation would visit columns x rows and silently ignore a
// frames value that stops short of a full final row.
export function frameSequence(definition) {
  return Array.from({ length: definition.frames }, (_, frame) => frameOffset(frame, definition));
}

export function scoutAnimationName(definition) {
  return `scout-walk-${definition.columns}x${definition.rows}x${definition.frames}`;
}

// One keyframes rule per grid signature, generated from the definition rather
// than written out by hand, so frame count and grid stay authoritative. step-end
// holds each cell until the next stop; the closing stop repeats the last cell so
// a non-looping state settles on it.
export function scoutKeyframes(definition) {
  const sequence = frameSequence(definition);
  const stop = (offset, at) => `${at}%{background-position:${offset.x} ${offset.y},center}`;
  const stops = sequence.map((offset, index) => stop(offset, Number(((index * 100) / sequence.length).toFixed(6))));
  return `@keyframes ${scoutAnimationName(definition)}{${stops.join('')}${stop(sequence.at(-1), 100)}}`;
}

export function scoutTiming(definition) {
  return {
    duration: definition.frames / definition.fps,
    iterations: definition.loop ? 'infinite' : '1',
  };
}

// Rules are installed once per grid signature into a stylesheet this module
// owns. CSSOM only — nothing is parsed from a string at the document level.
let keyframeSheet = null;
const installedKeyframes = new Set();
export function ensureScoutKeyframes(definition) {
  const name = scoutAnimationName(definition);
  if (installedKeyframes.has(name) || typeof document === 'undefined') return name;
  if (!keyframeSheet) {
    const style = document.createElement('style');
    style.dataset.scoutCharacter = 'keyframes';
    document.head.append(style);
    keyframeSheet = style.sheet;
  }
  if (!keyframeSheet) return name;
  keyframeSheet.insertRule(scoutKeyframes(definition), keyframeSheet.cssRules.length);
  installedKeyframes.add(name);
  return name;
}

export function activityState(activity) {
  const value = String(activity || '').toLowerCase();
  if (/search|read|fetch|browse|source|advert/.test(value)) return 'searching';
  if (/write|edit|patch|file|cv|resume/.test(value)) return 'writing';
  if (/explain|answer|respond|delta/.test(value)) return 'explaining';
  return 'thinking';
}

// Sprite sheets are cached per UI build, exactly as the rest of the shell is.
function assetUrl(pathname) {
  const build = typeof document !== 'undefined'
    ? document.querySelector?.('meta[name="scout-ui-build"]')?.content
    : null;
  return build ? `${pathname}?v=${encodeURIComponent(build)}` : pathname;
}

export function scoutMarkup(state = 'idle', className = '') {
  const def = scoutDefinition(state);
  const name = state in SCOUT_STATES ? state : 'idle';
  return `<span class="scout-character ${className}" data-scout-state="${name}" role="img" aria-label="${def.label}"><span class="scout-sprite" aria-hidden="true"></span></span>`;
}

export function applyScoutState(element, state, { reducedMotion = false, definitions = SCOUT_STATES } = {}) {
  if (!element) return null;
  const def = scoutDefinition(state, definitions);
  const sprite = element.matches?.('.scout-sprite') ? element : element.querySelector?.('.scout-sprite');
  element.dataset.scoutState = state in definitions ? state : 'idle';
  element.setAttribute('aria-label', def.label);
  if (!sprite) return def;
  const timing = scoutTiming(def);
  const still = frameOffset(def.reducedMotionFrame, def);
  const anchor = scoutAnchor(def);
  const stillAnchor = scoutStillAnchor(def);
  sprite.style.setProperty('--scout-src', `url("${assetUrl(def.src)}")`);
  sprite.style.setProperty('--scout-columns', def.columns);
  sprite.style.setProperty('--scout-rows', def.rows);
  sprite.style.setProperty('--scout-duration', `${timing.duration}s`);
  sprite.style.setProperty('--scout-iterations', timing.iterations);
  sprite.style.setProperty('--scout-walk', ensureScoutKeyframes(def));
  sprite.style.setProperty('--scout-align-x', `${anchor.x}%`);
  sprite.style.setProperty('--scout-align-y', `${anchor.y}%`);
  sprite.style.setProperty('--scout-still-align-x', `${stillAnchor.x}%`);
  sprite.style.setProperty('--scout-still-align-y', `${stillAnchor.y}%`);
  sprite.style.setProperty('--scout-still-x', still.x);
  sprite.style.setProperty('--scout-still-y', still.y);
  sprite.classList.toggle('reduced-motion', reducedMotion);
  // Placeholders emitted before this module evaluated show a static fallback
  // until this marker appears; from here the canonical definition is in force.
  element.dataset.scoutReady = 'true';
  observeCharacter(element);
  return def;
}

const observed = new WeakSet();
function observeCharacter(element) {
  if (observed.has(element) || typeof IntersectionObserver === 'undefined') return;
  observed.add(element);
  const observer = new IntersectionObserver(([entry]) => {
    element.classList.toggle('scout-offscreen', !entry.isIntersecting);
  });
  observer.observe(element);
}

export function hydrateScoutCharacters(container) {
  const root = container || (typeof document !== 'undefined' ? document : null);
  const reducedMotion = typeof window !== 'undefined'
    ? Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches)
    : false;
  root?.querySelectorAll?.('.scout-character').forEach((element) => {
    applyScoutState(element, element.dataset.scoutState || 'idle', { reducedMotion });
  });
}

if (typeof window !== 'undefined') {
  window.ScoutCharacter = {
    SCOUT_FRAME_ANCHORS, SCOUT_SHEET_ANCHORS, SCOUT_STATES,
    scoutDefinition, scoutAnchor, scoutStillAnchor, framePosition, frameOffset, frameSequence,
    scoutTiming, scoutAnimationName, scoutKeyframes, ensureScoutKeyframes,
    activityState, scoutMarkup, applyScoutState, hydrateScoutCharacters,
  };
  // This module is deferred, so anything already painted by app.js is adopted
  // as soon as the canonical definitions land.
  hydrateScoutCharacters();
  document.addEventListener('visibilitychange', () => document.documentElement.classList.toggle('scout-page-hidden', document.hidden));
}
