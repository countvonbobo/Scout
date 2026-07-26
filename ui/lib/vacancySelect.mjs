function valueOf(value) {
  return value && typeof value === 'object' && Object.hasOwn(value, 'value') ? value.value : value;
}

function text(value) {
  return String(value ?? '').trim();
}

function scoreOf(vacancy) {
  const score = Number(vacancy?.preRankScore ?? vacancy?.score ?? 0);
  return Number.isFinite(score) ? score : 0;
}

function vacancyId(vacancy) {
  return text(vacancy?.vacancyId ?? vacancy?.candidateId ?? vacancy?.canonicalUrl ?? vacancy?.observationId ?? vacancy?.sourceRecordId);
}

function employerOf(vacancy) {
  return text(vacancy?.employerId ?? valueOf(vacancy?.employer) ?? vacancy?.company) || 'unknown-employer';
}

function sourceOf(vacancy) {
  return text(vacancy?.source ?? vacancy?.sourceName) || 'unknown-source';
}

function laneOf(vacancy) {
  return text(vacancy?.laneId ?? vacancy?.lane ?? vacancy?.sourceLane) || 'unknown-lane';
}

function assessedAt(vacancy) {
  const value = vacancy?.assessedAt ?? vacancy?.lastAssessedAt ?? vacancy?.previousAssessmentAt;
  const time = Date.parse(value || '');
  return Number.isNaN(time) ? null : time;
}

function isMateriallyChanged(vacancy) {
  return vacancy?.materiallyChanged === true
    || vacancy?.change === 'material' || vacancy?.changeType === 'material'
    || vacancy?.vacancyChange === 'material';
}

function compareRanked(left, right) {
  const scoreDifference = scoreOf(right) - scoreOf(left);
  if (scoreDifference) return scoreDifference;
  const changedDifference = Number(isMateriallyChanged(right)) - Number(isMateriallyChanged(left));
  if (changedDifference) return changedDifference;
  const leftAssessed = assessedAt(left);
  const rightAssessed = assessedAt(right);
  if (leftAssessed === null || rightAssessed === null) {
    if (leftAssessed === null && rightAssessed !== null) return -1;
    if (rightAssessed === null && leftAssessed !== null) return 1;
  } else if (leftAssessed !== rightAssessed) return leftAssessed - rightAssessed;
  return vacancyId(left).localeCompare(vacancyId(right));
}

function countBy(values, keyOf) {
  return values.reduce((counts, value) => {
    const key = keyOf(value);
    counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map());
}

function limitFor(limit, proportion) {
  return Math.max(1, Math.floor(limit * proportion));
}

function constraintState(eligible, limit) {
  const employerCount = new Set(eligible.map(employerOf)).size;
  const sourceCount = new Set(eligible.map(sourceOf)).size;
  const laneCount = new Set(eligible.map(laneOf)).size;
  return {
    lane: laneCount >= 3 ? limitFor(limit, 0.5) : null,
    source: sourceCount >= 2 ? limitFor(limit, 0.6) : null,
    employer: employerCount >= 4 ? limitFor(limit, 0.3) : null,
  };
}

function permitted(vacancy, selected, constraints) {
  const employers = countBy(selected, employerOf);
  const sources = countBy(selected, sourceOf);
  const lanes = countBy(selected, laneOf);
  return (!constraints.employer || (employers.get(employerOf(vacancy)) || 0) < constraints.employer)
    && (!constraints.source || (sources.get(sourceOf(vacancy)) || 0) < constraints.source)
    && (!constraints.lane || (lanes.get(laneOf(vacancy)) || 0) < constraints.lane);
}

function hash(seed, value) {
  let result = 2166136261;
  for (const character of `${seed}:${value}`) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function explorationCount(exploration, limit) {
  const count = Number(exploration || 0);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return count < 1 ? Math.floor(limit * count) : Math.floor(count);
}

function chooseDeterministic(eligible, limit) {
  const constraints = constraintState(eligible, limit);
  const relaxed = [];
  const selected = [];
  while (selected.length < limit && selected.length < eligible.length) {
    const next = eligible.find((vacancy) => !selected.includes(vacancy) && permitted(vacancy, selected, constraints));
    if (next) {
      selected.push(next);
      continue;
    }
    const nextConstraint = ['lane', 'source', 'employer'].find((name) => constraints[name]);
    if (!nextConstraint) break;
    constraints[nextConstraint] = null;
    relaxed.push(nextConstraint);
  }
  return { selected, constraintsRelaxed: relaxed };
}

function explore(selection, eligible, exploration, seed) {
  const count = Math.min(explorationCount(exploration, selection.length), selection.length);
  if (!count) return selection;
  const remaining = eligible.filter((vacancy) => !selection.includes(vacancy))
    .sort((left, right) => hash(seed, vacancyId(left)) - hash(seed, vacancyId(right)) || vacancyId(left).localeCompare(vacancyId(right)));
  if (!remaining.length) return selection;
  const result = [...selection];
  for (let index = 0; index < count && remaining.length; index += 1) {
    result[result.length - 1 - index] = remaining.shift();
  }
  return result.sort(compareRanked);
}

export function selectVacancies(ranked, {
  limit = 60, threshold = 0, exploration = 0, seed = '',
} = {}) {
  const boundedLimit = Math.max(0, Math.floor(Number(limit) || 0));
  const ordered = [...(ranked || [])].sort(compareRanked);
  const eligible = ordered.filter((vacancy) => scoreOf(vacancy) >= Number(threshold));
  const belowCutoff = ordered.filter((vacancy) => scoreOf(vacancy) < Number(threshold));
  const deterministic = chooseDeterministic(eligible, boundedLimit);
  const selected = explore(deterministic.selected, eligible, exploration, seed);
  const selectedIds = new Set(deterministic.selected.map(vacancyId));
  return {
    selected,
    belowCutoff,
    reasons: selected.map((vacancy) => ({
      vacancyId: vacancyId(vacancy), score: scoreOf(vacancy),
      reason: selectedIds.has(vacancyId(vacancy)) ? 'deterministic-rank' : 'exploration',
    })),
    constraintsRelaxed: deterministic.constraintsRelaxed,
    seed,
  };
}
