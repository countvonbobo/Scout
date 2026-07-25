// Pure derivation: triage bucketing and follow-up-due computation. No I/O.

export function daysBetween(fromDate, today) {
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  return Math.floor((b - a) / 86400000);
}

function lastOf(log, event) {
  for (let i = log.length - 1; i >= 0; i--) if (log[i].event === event) return log[i];
  return null;
}

import { isClosed, isTriage } from './statusGroups.mjs';

export function followUpsDue(entry, today, policy = {}) {
  const closeoutDays = Number(policy.closeoutDays ?? 10);
  const nudgeDays = Number(policy.nudgeDays ?? 8);
  if (isClosed(entry.status)) return [];
  const log = [...(entry.log || [])].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  const lastReplied = lastOf(log, 'replied');
  const lastClosed = lastOf(log, 'closed');
  const lastOutreach = lastOf(log, 'outreach-sent');
  const lastNudge = lastOf(log, 'nudged');
  const settledAfter = (ref) =>
    (lastReplied && lastReplied.date >= ref.date) || (lastClosed && lastClosed.date >= ref.date);

  if (lastNudge && !settledAfter(lastNudge) && daysBetween(lastNudge.date, today) >= closeoutDays) {
    return [{ kind: 'closeout', since: lastNudge.date }];
  }
  if (lastOutreach && !settledAfter(lastOutreach)
      && (!lastNudge || lastNudge.date < lastOutreach.date)
      && daysBetween(lastOutreach.date, today) >= nudgeDays) {
    return [{ kind: 'nudge', since: lastOutreach.date }];
  }
  return [];
}

export function triage(data, today, policy = {}) {
  const actionScore = Number(policy.actionScore ?? 70);
  const checkScore = Number(policy.checkScore ?? 55);
  const action = [], unlock = [], followups = [], other = [];
  for (const e of data.opportunities) {
    const due = followUpsDue(e, today, policy);
    if (due.length) followups.push({ entry: e, due });
    const s = e.score;
    const eligibility = e.eligibility?.status;
    const actionEligible = !eligibility || eligibility === 'eligible';
    const checkEligible = !eligibility || eligibility === 'check';
    if (isTriage(e.status) && actionEligible && typeof s === 'number' && s >= actionScore) action.push(e);
    else if (isTriage(e.status) && typeof s === 'number' && s >= checkScore && s < actionScore
      && checkEligible && (eligibility === 'check' || (e.tags || []).some((t) => t.includes('Check')))) unlock.push(e);
    else other.push(e);
  }
  action.sort((a, b) => b.score - a.score);
  unlock.sort((a, b) => b.score - a.score);
  return { action, unlock, followups, other };
}
