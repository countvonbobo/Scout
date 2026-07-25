import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const setup = fs.readFileSync(new URL('./setup.js', import.meta.url), 'utf8');

test('phone layout keeps navigation scrollable and primary controls touch sized', () => {
  assert.match(html, /@media \(max-width:700px\)/);
  assert.match(html, /nav \{[^}]*overflow-x:auto/);
  assert.match(html, /nav button \{[^}]*min-height:44px/);
  assert.match(html, /\.setup-actions button \{[^}]*min-height:44px/);
  assert.match(html, /\.all-table-scroll \{[^}]*overflow-x:auto/);
  assert.match(app, /aria-label="All opportunities table"/);
});

test('dashboard exposes an explicit scan-now control', () => {
  assert.match(html, /id="scan-now"[^>]*>Scan now</);
  assert.match(app, /addEventListener\('click', \(\) => this\.scanNow\(\)\)/);
});

test('phone layout constrains chat and strong-match arrival to the viewport', () => {
  assert.match(html, /\.chat-drawer \{ width:100vw/);
  assert.match(html, /\.scout-arrival \{[^}]*width:calc\(100vw - 8px\)/);
  assert.match(html, /\.scout-arrival-copy \{[^}]*max-width:calc\(100vw - 112px\)/);
  assert.match(html, /\.chat-companion \.scout-bubble \{[^}]*max-width:calc\(100vw - 118px\)/);
});

test('chat drawer stays interactive when opened from the setup modal', () => {
  const setupZ = Number(html.match(/\.setup-overlay\s*\{[^}]*z-index:\s*(\d+)/s)?.[1]);
  const chatZ = Number(html.match(/\.chat-drawer\s*\{[^}]*z-index:\s*(\d+)/s)?.[1]);
  assert.ok(chatZ > setupZ, `expected chat drawer z-index ${chatZ} above setup overlay ${setupZ}`);
});

test('manual settings has a persistent accessible close control', () => {
  assert.match(html, /id="setup-close"[^>]*aria-label="Close settings"/);
  assert.match(html, /\.setup-head\s*\{[^}]*position:\s*sticky/s);
  assert.match(html, /\.setup-close\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/s);
  assert.match(setup, /ScoutModal\?\.register[\s\S]*onEscape: \(\) => this\.closeSettings\(\)/);
  assert.match(setup, /event\.target === this\.el\('setup-overlay'\)[\s\S]*closeSettings\(\)/);
});

test('dialogs share focus, inert-background, escape, and nested-layer management', () => {
  assert.match(app, /const ScoutModal = \(\(\) =>/);
  assert.match(app, /document\.body\.children[\s\S]*element\.inert/);
  assert.match(app, /event\.key === 'Escape'[\s\S]*entry\.options\.onEscape/);
  assert.match(app, /event\.key !== 'Tab'[\s\S]*last\.focus/);
  assert.match(app, /ScoutModal\.register\(document\.getElementById\?\.\('cv-options-overlay'\)/);
  assert.match(app, /ScoutModal\.register\(document\.getElementById\?\.\('chat-drawer'\)/);
  assert.match(html, /id="chat-drawer"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /id="company-drawer"[^>]*role="dialog"[^>]*aria-modal="true"/);
});

test('established settings and backup use separate dismissible views', () => {
  assert.match(setup, /DISMISSIBLE_VIEWS = new Set\(\['hub', 'section', 'retune', 'backup-details'\]\)/);
  assert.match(setup, /async openBackupDetails\(\)/);
  assert.match(setup, /renderSettingsHub\(\)/);
  assert.match(setup, /Retune my search/);
  assert.doesNotMatch(setup, /openSettings\(section = null\)[\s\S]{0,700}this\.step = 0/);
  assert.match(html, /\.settings-hub\s*\{[^}]*grid-template-columns:repeat\(2/s);
  assert.match(html, /@media \(max-width: 650px\)[\s\S]*\.settings-hub \{ grid-template-columns:1fr/);
});

test('report date navigation stays a vertical sidebar on desktop', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const rule = html.match(/\.report-list \.dates \{[^}]*\}/);
  assert.ok(rule, 'expected a .report-list .dates rule');
  assert.match(rule[0], /flex-direction:\s*column/);
  assert.match(rule[0], /min-width:\s*0/);
  assert.match(rule[0], /flex:\s*0 0 220px/);
});
