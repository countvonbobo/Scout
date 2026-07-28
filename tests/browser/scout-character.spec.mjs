import { expect, test } from '@playwright/test';

const CALM_STATES = ['idle', 'listening', 'sleeping'];
const ACTION_STATES = ['searching', 'writing', 'success'];
const RENDER_SIZES = [44, 112];

// The character is measured on its own, away from the dashboard's async renders,
// so a timing assertion can never be a race with opportunity loading.
async function mountCharacter(page, { state, size, reducedMotion = false }) {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.ScoutCharacter))).toBe(true);
  return page.evaluate(({ state, size, reducedMotion }) => {
    document.querySelectorAll('#scout-character-probe').forEach((node) => node.remove());
    const host = document.createElement('div');
    host.id = 'scout-character-probe';
    host.style.cssText = 'position:fixed;left:0;top:0;z-index:-1;';
    host.innerHTML = window.ScoutCharacter.scoutMarkup(state);
    document.body.append(host);
    const character = host.querySelector('.scout-character');
    character.style.width = `${size}px`;
    character.style.height = `${size}px`;
    window.ScoutCharacter.applyScoutState(character, state, { reducedMotion });
    const sprite = character.querySelector('.scout-sprite');
    const computed = getComputedStyle(sprite);
    return {
      label: character.getAttribute('aria-label'),
      role: character.getAttribute('role'),
      spriteHidden: sprite.getAttribute('aria-hidden'),
      animationName: computed.animationName,
      animationDuration: computed.animationDuration,
      animationIterationCount: computed.animationIterationCount,
      animationTimingFunction: computed.animationTimingFunction,
      backgroundSize: computed.backgroundSize,
      backgroundPosition: computed.backgroundPosition,
      transform: computed.transform,
      characterWidth: character.getBoundingClientRect().width,
    };
  }, { state, size, reducedMotion });
}

function seconds(value) {
  return value.split(',').map((part) => Number.parseFloat(part));
}

// Engines report background geometry either as the authored percentage or as a
// used pixel length. Both are normalised to "how many cells across", which is
// what has to stay a whole number.
function cellIndex(declaration, axis, size, span) {
  const raw = declaration.split(',')[0].trim().split(/\s+/)[axis];
  const number = Number.parseFloat(raw);
  return raw.endsWith('%') ? (number / 100) * span : number / size;
}

// Measures where Scout is actually drawn on a sheet, as a percentage of one
// cell, taking the union of every frame so a single anchor has to serve the
// whole animation rather than one lucky frame.
function spriteFootprints() {
  const sheets = new Map();
  const entries = Object.entries(window.ScoutCharacter.SCOUT_STATES);
  return Promise.all(entries.map(async ([state, definition]) => {
    if (!sheets.has(definition.src)) {
      sheets.set(definition.src, (async () => {
        const image = new Image();
        image.src = definition.src;
        await image.decode();
        // Sheets are not always an exact multiple of their column count, so the
        // sheet is read once at its true pixel size and each cell is taken as an
        // integer region of it.
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        const { data } = context.getImageData(0, 0, image.width, image.height);
        const edge = (index, count, total) => Math.round((index * total) / count);
        let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
        let cellWidth = 0; let cellHeight = 0;
        for (let frame = 0; frame < definition.frames; frame += 1) {
          const { column, row } = window.ScoutCharacter.framePosition(frame, definition);
          const x0 = edge(column, definition.columns, image.width);
          const x1 = edge(column + 1, definition.columns, image.width);
          const y0 = edge(row, definition.rows, image.height);
          const y1 = edge(row + 1, definition.rows, image.height);
          cellWidth = x1 - x0;
          cellHeight = y1 - y0;
          for (let y = y0; y < y1; y += 1) {
            for (let x = x0; x < x1; x += 1) {
              if (data[((y * image.width) + x) * 4 + 3] <= 24) continue;
              if (x - x0 < minX) minX = x - x0;
              if (x - x0 > maxX) maxX = x - x0;
              if (y - y0 < minY) minY = y - y0;
              if (y - y0 > maxY) maxY = y - y0;
            }
          }
        }
        return { cx: ((minX + maxX) / 2 / cellWidth) * 100, cy: ((minY + maxY) / 2 / cellHeight) * 100 };
      })());
    }
    return [state, await sheets.get(definition.src)];
  })).then((resolved) => Object.fromEntries(resolved));
}

test.describe('Scout character animation', () => {
  test('each state animates for its own configured frame count and frame rate', async ({ page }) => {
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => Boolean(window.ScoutCharacter))).toBe(true);
    const states = await page.evaluate(() => Object.entries(window.ScoutCharacter.SCOUT_STATES)
      .map(([name, def]) => ({ name, frames: def.frames, fps: def.fps, columns: def.columns, loop: def.loop })));
    expect(states.length).toBeGreaterThan(0);

    for (const { name, frames, fps, columns, loop } of states) {
      const measured = await mountCharacter(page, { state: name, size: 112 });
      const [columnSweep, rowSweep] = seconds(measured.animationDuration);
      expect(rowSweep, `${name} full cycle`).toBeCloseTo(frames / fps, 3);
      expect(columnSweep, `${name} row sweep`).toBeCloseTo(columns / fps, 3);
      expect(measured.animationIterationCount, `${name} looping`)
        .toBe(loop ? 'infinite, infinite' : `${frames / columns}, 1`);
      expect(measured.animationTimingFunction).toContain('jump-none');
    }
  });

  test('calm states visibly outlast action states', async ({ page }) => {
    const durationOf = async (state) => {
      const measured = await mountCharacter(page, { state, size: 112 });
      return seconds(measured.animationDuration)[1];
    };
    const calm = [];
    for (const state of CALM_STATES) calm.push(await durationOf(state));
    const action = [];
    for (const state of ACTION_STATES) action.push(await durationOf(state));
    expect(Math.min(...calm)).toBeGreaterThan(Math.max(...action));
  });

  test('reduced motion holds one stable configured frame', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const measured = await mountCharacter(page, { state: 'searching', size: 112, reducedMotion: true });
    expect(measured.animationName).toBe('none');

    const sample = () => page.evaluate(() => getComputedStyle(
      document.querySelector('#scout-character-probe .scout-sprite'),
    ).backgroundPosition);
    const first = await sample();
    await page.waitForTimeout(400);
    expect(await sample()).toBe(first);

    const definition = await page.evaluate(() => window.ScoutCharacter.SCOUT_STATES.searching);
    expect(definition.reducedMotionFrame).toBeGreaterThan(0);
    await page.emulateMedia({ reducedMotion: null });
  });

  for (const size of RENDER_SIZES) {
    test(`sprite cells land on whole cell boundaries at ${size}px`, async ({ page }) => {
      await page.goto('/');
      await expect.poll(() => page.evaluate(() => Boolean(window.ScoutCharacter))).toBe(true);
      const states = await page.evaluate(() => Object.keys(window.ScoutCharacter.SCOUT_STATES));

      for (const state of states) {
        const measured = await mountCharacter(page, { state, size, reducedMotion: true });
        const definition = await page.evaluate((name) => window.ScoutCharacter.SCOUT_STATES[name], state);
        expect(measured.characterWidth).toBe(size);
        expect(cellIndex(measured.backgroundSize, 0, size, 1), `${state} sheet width at ${size}px`)
          .toBeCloseTo(definition.columns, 5);
        expect(cellIndex(measured.backgroundSize, 1, size, 1), `${state} sheet height at ${size}px`)
          .toBeCloseTo(definition.rows, 5);

        // Any fractional-cell drift shows up as a non-integer cell index.
        const x = cellIndex(measured.backgroundPosition, 0, size, definition.columns - 1);
        const y = cellIndex(measured.backgroundPosition, 1, size, definition.rows - 1);
        expect(Math.abs(x - Math.round(x)), `${state} x drift at ${size}px`).toBeLessThan(1e-4);
        expect(Math.abs(y - Math.round(y)), `${state} y drift at ${size}px`).toBeLessThan(1e-4);
      }
    });

    test(`every pose renders centred at ${size}px`, async ({ page }) => {
      await page.goto('/');
      await expect.poll(() => page.evaluate(() => Boolean(window.ScoutCharacter))).toBe(true);
      const footprints = await page.evaluate(spriteFootprints);
      const centres = [];

      for (const [state, footprint] of Object.entries(footprints)) {
        const measured = await mountCharacter(page, { state, size, reducedMotion: true });
        const definition = await page.evaluate((name) => window.ScoutCharacter.SCOUT_STATES[name], state);
        const translate = measured.transform === 'none'
          ? [0, 0]
          : measured.transform.match(/matrix\(([^)]+)\)/)[1].split(',').slice(4).map(Number.parseFloat);

        // Anchors are percentages of the render box, so the browser must resolve
        // the same relative offset at 44px and at 112px.
        const anchor = await page.evaluate((name) => window.ScoutCharacter.scoutAnchor(window.ScoutCharacter.SCOUT_STATES[name]), state);
        expect(translate[0] / size * 100, `${state} x anchor at ${size}px`).toBeCloseTo(anchor.x, 3);
        expect(translate[1] / size * 100, `${state} y anchor at ${size}px`).toBeCloseTo(anchor.y, 3);

        // Drawn artwork plus anchor must land on the centre of the render box.
        const centre = [footprint.cx + anchor.x, footprint.cy + anchor.y];
        expect(centre[0], `${state} drawn x centre at ${size}px`).toBeCloseTo(50, 1);
        expect(centre[1], `${state} drawn y centre at ${size}px`).toBeCloseTo(50, 1);
        centres.push(centre);

        expect(measured.label, `${state} label`).toBe(definition.label);
        expect(measured.role).toBe('img');
        expect(measured.spriteHidden).toBe('true');
      }

      // No pose may jump relative to another when the state changes.
      for (const axis of [0, 1]) {
        const values = centres.map((centre) => centre[axis]);
        expect(Math.max(...values) - Math.min(...values), `pose spread on axis ${axis}`).toBeLessThan(1);
      }
    });
  }
});
