#!/usr/bin/env node
import fs from 'node:fs';
import { markerFreeMutationContent } from '../ui/lib/mutationCoordinator.mjs';

const relative = String(process.argv[2] || '').replaceAll('\\', '/');
const content = fs.readFileSync(0, 'utf8');
let kind = relative.endsWith('/data/opportunities.json') || relative === 'data/opportunities.json' ? 'tracker'
  : relative.endsWith('/data/scan-runs.jsonl') || relative === 'data/scan-runs.jsonl' ? 'run-log'
    : /(?:^|\/)reports\/\d{4}-\d{2}-\d{2}\.md$/.test(relative) ? 'report'
      : null;
if (kind === null && content.includes('<!-- scout-mutation:')) kind = 'report';
if (kind === null) {
  try {
    const value = JSON.parse(content);
    kind = Array.isArray(value?.opportunities) ? 'tracker' : 'run-log';
  } catch {
    kind = content.trimStart().startsWith('# Scout report') ? 'report' : null;
  }
}

process.stdout.write(kind ? markerFreeMutationContent(kind, content) : content);
