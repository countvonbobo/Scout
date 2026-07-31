import fs from 'node:fs';
import { acquireScanLease, currentLeaseOwner } from '../scanLease.mjs';

const [root, phase, marker] = process.argv.slice(2);
const lease = acquireScanLease(
  root,
  currentLeaseOwner(),
  { kind: 'scan', runId: `holder-${phase}`, phase },
  { leaseDurationMs: 30_000, takeoverMarginMs: 0 },
);
if (!lease) throw new Error('fixture could not acquire its scan lease');
fs.writeFileSync(marker, JSON.stringify({
  generation: lease.generation,
  leaseId: lease.leaseId,
  owner: lease.owner,
}));
setInterval(() => {}, 1_000);
