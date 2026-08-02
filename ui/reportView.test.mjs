import assert from 'node:assert/strict';
import { test } from 'node:test';

await import('./reportView.js');
const { embedMutationMarker, parse, readMutationMarker, render } = globalThis.ScoutReportView;

test('structured reports render semantic sections, safe links and checklists', () => {
  const html = render(`# Scout report - 2026-07-20

## Headline

Configured sources completed successfully.

## Scan runs

- **claude primary** - healthy
- [x] Codex verified

## Action today

- [Role](https://example.test/job)
`);
  assert.match(html, /<article/);
  assert.match(html, /report-scan-runs/);
  assert.match(html, /type="checkbox" disabled checked/);
  assert.match(html, /href="https:\/\/example\.test\/job"/);
});

test('raw HTML and unsafe links never execute', () => {
  const html = render('## Headline\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(2))');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /href="javascript:/);
});

test('legacy malformed reports use the readable preformatted fallback', () => {
  assert.equal(parse('plain legacy report').fallback, true);
  assert.match(render('plain <legacy> report'), /report-fallback/);
  assert.match(render('plain <legacy> report'), /&lt;legacy&gt;/);
});

test('degraded and empty sections remain explicit and scannable', () => {
  const html = render(`# Scout report - 2026-07-20

## Headline

Coverage was degraded; this is not evidence that no suitable roles exist.

## Action today

- None.

## Verdicts

- Error: source unavailable
`);
  assert.match(html, /Coverage was degraded/);
  assert.match(html, /report-action-today/);
  assert.match(html, /None\./);
  assert.match(html, /source unavailable/);
});

test('nested markdown headings render as headings, not raw text', () => {
  const html = render(['# Daily report', '', '## Discarded', '', '### Closest reviewed roles not kept', '', 'Body text.'].join('\n'));
  assert.match(html, /<h4>Closest reviewed roles not kept<\/h4>/);
  assert.doesNotMatch(html, /###/);
});

test('headings deeper than the HTML heading range clamp instead of leaking raw markers', () => {
  const html = render([
    '# Daily report', '', '## Discarded', '',
    '###### Six', '', '####### Seven', '', '######## Eight',
  ].join('\n'));
  assert.match(html, /<h6>Six<\/h6>/);
  assert.match(html, /<h6>Seven<\/h6>/);
  assert.match(html, /<h6>Eight<\/h6>/);
  assert.doesNotMatch(html, /#/);
});

test('report mutation markers remain verifiable but never render', () => {
  const marker = {
    schemaVersion: 1,
    mutationId: 'mutation-123',
    mutationKey: 'a'.repeat(64),
    runKey: 'b'.repeat(64),
    intendedDigest: 'c'.repeat(64),
  };
  const marked = embedMutationMarker('# Daily report\n\n## Headline\n\nSafe body.\n', marker);

  assert.deepEqual(readMutationMarker(marked), marker);
  assert.doesNotMatch(JSON.stringify(parse(marked)), /scout-mutation/);
  assert.doesNotMatch(render(marked), /scout-mutation|mutation-123|aaaa/);
  assert.match(render(marked), /Safe body/);
});
