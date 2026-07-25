// Single source of truth for how opportunity statuses group together.
// Consumers must not re-declare literal status lists: adding a status to
// ui/lib/tracker.mjs and forgetting a consumer is what caused issues #59 and #60.

export const TRIAGE_STATUSES = ['new'];
export const OPEN_STATUSES = ['shortlist', 'watch'];
export const ACTIVE_STATUSES = ['outreach', 'applied', 'interviewing'];
export const CLOSED_STATUSES = ['accepted', 'rejected', 'ignore'];

// Subset of CLOSED_STATUSES: the user dismissed this from the triage inbox.
export const DISMISSED_STATUSES = ['ignore'];

// Statuses whose advert is still worth re-checking for liveness.
export const VERIFIABLE_STATUSES = [...TRIAGE_STATUSES, ...OPEN_STATUSES];

const has = (list) => (status) => list.includes(String(status ?? ''));

export const isTriage = has(TRIAGE_STATUSES);
export const isOpen = has(OPEN_STATUSES);
export const isActive = has(ACTIVE_STATUSES);
export const isClosed = has(CLOSED_STATUSES);
export const isDismissed = has(DISMISSED_STATUSES);
export const isVerifiable = has(VERIFIABLE_STATUSES);
