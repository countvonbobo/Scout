// The single source of truth for Scout's animation. Frame count, frame rate,
// looping, the reduced-motion still frame and the per-state anchor all live
// here; the browser runtime reads them rather than imposing its own timing.

// One anchor per sprite sheet, shared by every state drawn from it, and nothing
// finer: each pair is the offset that puts that sheet's drawn footprint — the
// union of all of its frames — on the centre of the render box. Anchors are
// percentages of that box, so the same pose is centred at any render size, and
// states that share a sheet cannot drift apart from each other. Poses used to
// jump because these were hand-tuned per state and three states carried no
// anchor at all in the browser runtime.
export const SCOUT_ANCHORS = Object.freeze({
  '/assets/scout-idle.png': Object.freeze([4.153, 4.473]),
  '/assets/scout-explaining.png': Object.freeze([1.278, -1.278]),
  '/assets/scout-thinking.png': Object.freeze([3.834, 0]),
  '/assets/scout-searching.png': Object.freeze([2.077, 0]),
  '/assets/scout-found.png': Object.freeze([4.952, 0.16]),
  '/assets/scout-warning.png': Object.freeze([3.514, 0]),
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

export function scoutAnchor(definition, anchors = SCOUT_ANCHORS) {
  const [x, y] = anchors[definition?.src] || [0, 0];
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

// The sprite is walked by two step animations: one sweeping the columns of a
// row, one stepping down the rows. Both are driven by the state's own fps, so a
// calm state stays calm and an action state stays quick without a second table.
export function scoutTiming(definition) {
  return {
    duration: definition.frames / definition.fps,
    rowDuration: definition.columns / definition.fps,
    rowIterations: definition.loop ? 'infinite' : '1',
    columnIterations: definition.loop ? 'infinite' : String(definition.rows),
  };
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

export function applyScoutState(element, state, { reducedMotion = false } = {}) {
  if (!element) return null;
  const def = scoutDefinition(state);
  const sprite = element.matches?.('.scout-sprite') ? element : element.querySelector?.('.scout-sprite');
  element.dataset.scoutState = state in SCOUT_STATES ? state : 'idle';
  element.setAttribute('aria-label', def.label);
  if (!sprite) return def;
  const timing = scoutTiming(def);
  const still = frameOffset(def.reducedMotionFrame, def);
  sprite.style.setProperty('--scout-src', `url("${assetUrl(def.src)}")`);
  sprite.style.setProperty('--scout-columns', def.columns);
  sprite.style.setProperty('--scout-rows', def.rows);
  sprite.style.setProperty('--scout-frames', def.frames);
  sprite.style.setProperty('--scout-duration', `${timing.duration}s`);
  sprite.style.setProperty('--scout-row-duration', `${timing.rowDuration}s`);
  sprite.style.setProperty('--scout-iterations', timing.rowIterations);
  sprite.style.setProperty('--scout-column-iterations', timing.columnIterations);
  const anchor = scoutAnchor(def);
  sprite.style.setProperty('--scout-align-x', `${anchor.x}%`);
  sprite.style.setProperty('--scout-align-y', `${anchor.y}%`);
  sprite.style.setProperty('--scout-still-x', still.x);
  sprite.style.setProperty('--scout-still-y', still.y);
  sprite.classList.toggle('reduced-motion', reducedMotion);
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
    SCOUT_ANCHORS, SCOUT_STATES, scoutDefinition, scoutAnchor, framePosition, frameOffset,
    scoutTiming, activityState, scoutMarkup, applyScoutState, hydrateScoutCharacters,
  };
  // This module is deferred, so anything already painted by app.js is adopted
  // as soon as the canonical definitions land.
  hydrateScoutCharacters();
  document.addEventListener('visibilitychange', () => document.documentElement.classList.toggle('scout-page-hidden', document.hidden));
}
