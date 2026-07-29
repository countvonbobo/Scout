import { expect, test } from '@playwright/test';

const CALM_STATES = ['idle', 'listening', 'sleeping'];
const ACTION_STATES = ['searching', 'writing', 'success'];
const RENDER_SIZES = [44, 112];
const MODULE_URL = '**/lib/scoutCharacter.mjs*';

// One navigation per test. Probes are mounted and replaced in place, so adding
// a state costs an evaluate rather than a full dashboard load.
async function openDashboard(page) {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.ScoutCharacter))).toBe(true);
}

// Everything below runs in the page. Kept as one injected source string so the
// measurement helpers exist for every evaluate without re-navigating.
function scoutProbeSource() {
  const sheets = new Map();

  async function sheetPixels(src) {
    if (!sheets.has(src)) {
      sheets.set(src, (async () => {
        const image = new Image();
        image.src = src;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
      })());
    }
    return sheets.get(src);
  }

  // A 1254px sheet divided into 4 columns has cells of 313.5px. Rounding the
  // edges would hand 314px to some cells and 313px to others and shift every
  // measured centre. The scan therefore takes whole pixels whose centre falls
  // inside the exact fractional cell, and normalises against that fractional
  // origin and width.
  async function frameFootprint(src, { columns, rows }, frame) {
    const sheet = await sheetPixels(src);
    const cellWidth = sheet.width / columns;
    const cellHeight = sheet.height / rows;
    const originX = (frame % columns) * cellWidth;
    const originY = Math.floor(frame / columns) * cellHeight;
    const from = (origin) => Math.ceil(origin - 0.5);
    const to = (origin, span) => Math.ceil(origin + span - 0.5);
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (let y = from(originY); y < to(originY, cellHeight); y += 1) {
      for (let x = from(originX); x < to(originX, cellWidth); x += 1) {
        if (sheet.data[(((y * sheet.width) + x) * 4) + 3] <= 24) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return {
      cx: ((((minX + maxX) / 2) + 0.5 - originX) / cellWidth) * 100,
      cy: ((((minY + maxY) / 2) + 0.5 - originY) / cellHeight) * 100,
    };
  }

  function host() {
    let node = document.querySelector('#scout-character-probe');
    if (!node) {
      node = document.createElement('div');
      node.id = 'scout-character-probe';
      node.style.cssText = 'position:fixed;left:0;top:0;z-index:-1;';
      document.body.append(node);
    }
    return node;
  }

  function mount(state, size, options = {}) {
    const node = host();
    node.innerHTML = window.ScoutCharacter.scoutMarkup(state);
    const character = node.querySelector('.scout-character');
    character.style.width = `${size}px`;
    character.style.height = `${size}px`;
    window.ScoutCharacter.applyScoutState(character, state, options);
    return character;
  }

  function readCharacter(character) {
    const sprite = character.querySelector('.scout-sprite');
    const computed = getComputedStyle(sprite);
    const matrix = computed.transform === 'none'
      ? [0, 0]
      : computed.transform.match(/matrix\(([^)]+)\)/)[1].split(',').slice(4).map(Number);
    return {
      label: character.getAttribute('aria-label'),
      role: character.getAttribute('role'),
      spriteHidden: sprite.getAttribute('aria-hidden'),
      ready: character.dataset.scoutReady || null,
      animationName: computed.animationName,
      animationDuration: computed.animationDuration,
      animationIterationCount: computed.animationIterationCount,
      animationTimingFunction: computed.animationTimingFunction,
      backgroundSize: computed.backgroundSize,
      backgroundPosition: computed.backgroundPosition,
      runningAnimations: sprite.getAnimations().length,
      translate: matrix,
      width: character.getBoundingClientRect().width,
    };
  }

  // Seeks the real CSS animation and reads back what the browser computes, so
  // the visited cells are observed rather than read off the generated rule.
  function walkCells(character, definition) {
    const sprite = character.querySelector('.scout-sprite');
    const [animation] = sprite.getAnimations();
    if (!animation) return null;
    animation.pause();
    const total = (definition.frames / definition.fps) * 1000;
    const seen = [];
    for (let frame = 0; frame < definition.frames; frame += 1) {
      animation.currentTime = ((frame + 0.5) * total) / definition.frames;
      seen.push(getComputedStyle(sprite).backgroundPosition.split(',')[0].trim());
    }
    return seen;
  }

  window.__scoutProbe = { frameFootprint, mount, readCharacter, walkCells };
}

// Engines report background geometry either as the authored percentage or as a
// used pixel length. Both normalise to "how many cells across".
function cellIndex(declaration, axis, size, span) {
  const raw = declaration.split(',')[0].trim().split(/\s+/)[axis];
  const value = Number.parseFloat(raw);
  return raw.endsWith('%') ? (value / 100) * span : value / size;
}

function cellNumber(position, size, definition) {
  const column = cellIndex(position, 0, size, definition.columns - 1);
  const row = cellIndex(position, 1, size, definition.rows - 1);
  return (Math.round(row) * definition.columns) + Math.round(column);
}

function seconds(value) {
  return Number.parseFloat(value.split(',')[0]);
}

async function installProbe(page) {
  await page.evaluate(scoutProbeSource);
}

async function states(page) {
  return page.evaluate(() => window.ScoutCharacter.SCOUT_STATES);
}

test.describe('Scout character animation', () => {
  test('each state animates for its own configured frame count and frame rate', async ({ page }) => {
    await openDashboard(page);
    await installProbe(page);
    const configured = await states(page);

    const measured = await page.evaluate((names) => Object.fromEntries(names.map((name) => {
      const character = window.__scoutProbe.mount(name, 112);
      return [name, window.__scoutProbe.readCharacter(character)];
    })), Object.keys(configured));

    for (const [name, definition] of Object.entries(configured)) {
      expect(seconds(measured[name].animationDuration), `${name} cycle`).toBeCloseTo(definition.frames / definition.fps, 3);
      expect(measured[name].animationIterationCount, `${name} looping`).toBe(definition.loop ? 'infinite' : '1');
      expect(measured[name].animationName, `${name} walk`).toBe(`scout-walk-${definition.columns}x${definition.rows}x${definition.frames}`);
      // Engines serialise step-end as steps(1) or as the keyword; both hold a
      // cell until the next stop, which is what must not regress to a tween.
      expect(measured[name].animationTimingFunction, `${name} easing`).toMatch(/^(?:step-end|steps\(1(?:,\s*(?:end|jump-end))?\))$/);
      expect(measured[name].runningAnimations, `${name} must animate`).toBe(1);
    }

    const cycle = (name) => seconds(measured[name].animationDuration);
    expect(Math.min(...CALM_STATES.map(cycle))).toBeGreaterThan(Math.max(...ACTION_STATES.map(cycle)));
  });

  test('the walk visits exactly the configured frames, in order, once each', async ({ page }) => {
    await openDashboard(page);
    await installProbe(page);
    const configured = await states(page);

    const walked = await page.evaluate((names) => Object.fromEntries(names.map((name) => {
      const character = window.__scoutProbe.mount(name, 112);
      return [name, window.__scoutProbe.walkCells(character, window.ScoutCharacter.SCOUT_STATES[name])];
    })), Object.keys(configured));

    for (const [name, definition] of Object.entries(configured)) {
      const visited = walked[name].map((position) => cellNumber(position, 112, definition));
      expect(visited, `${name} visits every configured frame in order`)
        .toEqual(Array.from({ length: definition.frames }, (_, frame) => frame));
    }
  });

  test('a sheet whose last row is only partly used stops at its final frame', async ({ page }) => {
    await openDashboard(page);
    await installProbe(page);

    // frames is authoritative, so a 14-frame definition on a 4x4 sheet must
    // never reach cells 14 or 15 even though the grid has room for them.
    const partial = {
      src: '/assets/scout-idle.png', columns: 4, rows: 4, frames: 14, fps: 7,
      loop: true, reducedMotionFrame: 0, label: 'Scout is ready',
    };
    const result = await page.evaluate((definition) => {
      const node = document.createElement('div');
      node.id = 'scout-partial-probe';
      node.innerHTML = window.ScoutCharacter.scoutMarkup('idle');
      document.body.append(node);
      const character = node.querySelector('.scout-character');
      character.style.width = '112px';
      character.style.height = '112px';
      window.ScoutCharacter.applyScoutState(character, 'partial', { definitions: { partial: definition } });
      return {
        cells: window.__scoutProbe.walkCells(character, definition),
        read: window.__scoutProbe.readCharacter(character),
      };
    }, partial);

    const visited = result.cells.map((position) => cellNumber(position, 112, partial));
    expect(visited).toEqual(Array.from({ length: 14 }, (_, frame) => frame));
    expect(visited).not.toContain(14);
    expect(visited).not.toContain(15);
    expect(result.read.animationName).toBe('scout-walk-4x4x14');
    expect(seconds(result.read.animationDuration)).toBeCloseTo(2, 3);
  });

  test('reduced motion holds one stable configured frame with nothing running', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openDashboard(page);
    await installProbe(page);

    const result = await page.evaluate(async () => {
      const character = window.__scoutProbe.mount('searching', 112, { reducedMotion: true });
      const sprite = character.querySelector('.scout-sprite');
      const first = getComputedStyle(sprite).backgroundPosition;
      // Two painted frames is a real animation signal; a fixed sleep is not.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        first,
        second: getComputedStyle(sprite).backgroundPosition,
        read: window.__scoutProbe.readCharacter(character),
      };
    });

    expect(result.read.animationName).toBe('none');
    expect(result.read.runningAnimations).toBe(0);
    expect(result.second).toBe(result.first);
    await page.emulateMedia({ reducedMotion: null });
  });

  for (const size of RENDER_SIZES) {
    test(`the configured representative frame renders centred at ${size}px`, async ({ page }) => {
      // The first (cold-cache) pass decodes and alpha-scans six full source
      // sheets. Its cost is independent of the rendered box size and can
      // exceed Playwright's default test timeout under full-suite load.
      test.setTimeout(60_000);
      await openDashboard(page);
      await installProbe(page);
      const configured = await states(page);

      const measured = await page.evaluate(async ({ names, box }) => {
        const out = {};
        for (const name of names) {
          const definition = window.ScoutCharacter.SCOUT_STATES[name];
          const character = window.__scoutProbe.mount(name, box, { reducedMotion: true });
          out[name] = {
            read: window.__scoutProbe.readCharacter(character),
            // Expected centre comes from the source PNG's alpha and the state's
            // configured representative frame, never from the anchor tables.
            footprint: await window.__scoutProbe.frameFootprint(definition.src, definition, definition.reducedMotionFrame),
          };
        }
        return out;
      }, { names: Object.keys(configured), box: size });

      for (const [name, definition] of Object.entries(configured)) {
        const { read, footprint } = measured[name];
        expect(read.width).toBe(size);
        expect(read.ready, `${name} hydrated`).toBe('true');

        // The still must sit on the representative cell.
        expect(cellNumber(read.backgroundPosition, size, definition), `${name} still cell`)
          .toBe(definition.reducedMotionFrame);

        // Drawn artwork plus the offset the browser actually applied must land
        // on the centre of the render box, at this size.
        expect(footprint.cx + ((read.translate[0] / size) * 100), `${name} drawn x centre at ${size}px`).toBeCloseTo(50, 1);
        expect(footprint.cy + ((read.translate[1] / size) * 100), `${name} drawn y centre at ${size}px`).toBeCloseTo(50, 1);

        expect(read.label, `${name} label`).toBe(definition.label);
        expect(read.role).toBe('img');
        expect(read.spriteHidden).toBe('true');
      }
    });

    test(`states sharing a sheet animate on the same anchor at ${size}px`, async ({ page }) => {
      await openDashboard(page);
      await installProbe(page);
      const configured = await states(page);

      const measured = await page.evaluate(({ names, box }) => Object.fromEntries(names.map((name) => {
        const character = window.__scoutProbe.mount(name, box);
        return [name, window.__scoutProbe.readCharacter(character)];
      })), { names: Object.keys(configured), box: size });

      const bySheet = new Map();
      for (const [name, definition] of Object.entries(configured)) {
        const offset = measured[name].translate.map((value) => (value / size) * 100);
        const seen = bySheet.get(definition.src);
        // asking, writing and explaining play the identical frames of one sheet.
        if (seen) {
          expect(offset[0], `${name} vs ${seen.name} x at ${size}px`).toBeCloseTo(seen.offset[0], 3);
          expect(offset[1], `${name} vs ${seen.name} y at ${size}px`).toBeCloseTo(seen.offset[1], 3);
        } else bySheet.set(definition.src, { name, offset });

        expect(cellIndex(measured[name].backgroundSize, 0, size, 1), `${name} sheet width`).toBeCloseTo(definition.columns, 5);
        expect(cellIndex(measured[name].backgroundSize, 1, size, 1), `${name} sheet height`).toBeCloseTo(definition.rows, 5);
      }
    });
  }
});

test.describe('Scout character before its module is available', () => {
  // Holds the module request so real renders happen in the window between the
  // classic app.js executing and the deferred module evaluating.
  async function withHeldModule(page, run) {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route(MODULE_URL, async (route) => {
      await held;
      // The shell's service worker precaches the module too, so a second
      // request can arrive as the test finishes; losing that race is harmless.
      await route.continue().catch(() => {});
    });
    try {
      await run(() => release());
    } finally {
      release();
      await page.unroute(MODULE_URL);
    }
  }

  // Drives the real arrival and chat-drawer renders rather than a test double.
  async function renderProductionCharacters(page) {
    return page.evaluate(() => {
      document.getElementById('setup-overlay')?.classList.add('hidden');
      // Seeded rather than awaited, so these renders never race the dashboard's
      // own opportunity fetch.
      const entry = { id: 'probe-role-2026-07', company: 'Probe', role: 'Engineer', score: 91 };
      window.Scout.state.data = { ...window.Scout.state.data, opportunities: [entry] };
      window.Scout.discoveries = [entry];
      window.Scout.showStrongMatchArrival();
      window.Scout.chat = { id: entry.id, engine: null, data: { messages: [] }, streaming: false };
      window.Scout.renderChatDrawer();
      return [...document.querySelectorAll('.scout-character')].map((character) => ({
        state: character.dataset.scoutState,
        role: character.getAttribute('role'),
        label: character.getAttribute('aria-label'),
        ready: character.dataset.scoutReady || null,
        hasSprite: Boolean(character.querySelector('.scout-sprite[aria-hidden="true"]')),
        inArrival: Boolean(character.closest('#scout-arrival')),
        inChat: Boolean(character.closest('#chat-drawer')),
      }));
    });
  }

  test('a render before the module arrives still produces named, hydratable characters', async ({ page }) => {
    await withHeldModule(page, async (release) => {
      await page.goto('/', { waitUntil: 'commit' });
      // Holding the module ties up a connection, so the classic script can take
      // noticeably longer to arrive on some engines than the default poll allows.
      await expect.poll(() => page.evaluate(() => Boolean(window.Scout)), { timeout: 20000 }).toBe(true);
      expect(await page.evaluate(() => Boolean(window.ScoutCharacter))).toBe(false);

      const placeholders = await renderProductionCharacters(page);
      expect(placeholders.length).toBeGreaterThan(1);
      expect(placeholders.some((character) => character.inArrival)).toBe(true);
      expect(placeholders.some((character) => character.inChat)).toBe(true);
      for (const character of placeholders) {
        expect(character.role).toBe('img');
        expect(character.label).toBe('Scout');
        expect(character.hasSprite).toBe(true);
        expect(character.ready).toBeNull();
      }
      // The placeholder shows a real cell rather than an empty box.
      const painted = await page.evaluate(() => {
        const sprite = document.querySelector('#scout-arrival .scout-sprite');
        const computed = getComputedStyle(sprite);
        return { image: computed.backgroundImage, animation: computed.animationName };
      });
      expect(painted.image).toContain('scout-idle.png');
      expect(painted.animation).toBe('none');

      release();
      await expect.poll(
        () => page.evaluate(() => Boolean(window.ScoutCharacter)),
        { timeout: 20000 },
      ).toBe(true);
    });

    // Arrival and chat placeholders are adopted with their canonical labels and
    // their own configured timing.
    const hydrated = await page.evaluate(() => [...document.querySelectorAll('.scout-character')].map((character) => ({
      state: character.dataset.scoutState,
      label: character.getAttribute('aria-label'),
      ready: character.dataset.scoutReady || null,
      duration: getComputedStyle(character.querySelector('.scout-sprite')).animationDuration,
    })));
    const configured = await page.evaluate(() => window.ScoutCharacter.SCOUT_STATES);
    expect(hydrated.length).toBeGreaterThan(1);
    for (const character of hydrated) {
      const definition = configured[character.state];
      expect(character.ready).toBe('true');
      expect(character.label).toBe(definition.label);
      expect(seconds(character.duration)).toBeCloseTo(definition.frames / definition.fps, 3);
    }
  });

  test('a module that never loads leaves a labelled character, not an empty slot', async ({ page }) => {
    await page.route(MODULE_URL, (route) => route.abort());
    await page.goto('/', { waitUntil: 'commit' });
    await expect.poll(() => page.evaluate(() => Boolean(window.Scout))).toBe(true);

    const characters = await renderProductionCharacters(page);
    expect(characters.length).toBeGreaterThan(1);
    for (const character of characters) {
      expect(character.role).toBe('img');
      expect(character.label).toBe('Scout');
      expect(character.hasSprite).toBe(true);
    }
    expect(await page.evaluate(() => Boolean(window.ScoutCharacter))).toBe(false);

    const painted = await page.evaluate(() => {
      const sprite = document.querySelector('#scout-arrival .scout-sprite');
      const rect = sprite.getBoundingClientRect();
      return { image: getComputedStyle(sprite).backgroundImage, width: rect.width, height: rect.height };
    });
    expect(painted.image).toContain('scout-idle.png');
    expect(painted.width).toBeGreaterThan(0);
    expect(painted.height).toBeGreaterThan(0);
    await page.unroute(MODULE_URL);
  });
});
