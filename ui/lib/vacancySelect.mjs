function valueOf(value) {
  return value && typeof value === 'object' && Object.hasOwn(value, 'value') ? value.value : value;
}

function text(value) {
  return String(value ?? '').trim();
}

function groupText(value, fallback) {
  return text(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ') || fallback;
}

function scoreOf(vacancy) {
  const score = Number(vacancy?.preRankScore ?? vacancy?.score ?? 0);
  return Number.isFinite(score) ? score : 0;
}

function vacancyId(vacancy) {
  return text(vacancy?.vacancyId ?? vacancy?.candidateId ?? vacancy?.canonicalUrl ?? vacancy?.observationId ?? vacancy?.sourceRecordId);
}

function compareText(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function employerOf(vacancy) {
  return groupText(vacancy?.employerId ?? valueOf(vacancy?.employer) ?? vacancy?.company, 'unknown-employer');
}

function sourceOf(vacancy) {
  return groupText(vacancy?.source ?? vacancy?.sourceName, 'unknown-source');
}

function laneOf(vacancy) {
  return groupText(vacancy?.laneId ?? vacancy?.lane ?? vacancy?.sourceLane, 'unknown-lane');
}

function roleFamilyOf(vacancy) {
  return groupText(
    vacancy?.roleFamilyId ?? vacancy?.roleFamily ?? vacancy?.targetRoleFamily,
    'unknown-role-family',
  );
}

function locationOf(vacancy) {
  return groupText(vacancy?.locationId ?? valueOf(vacancy?.location), 'unknown-location');
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
  return compareText(vacancyId(left), vacancyId(right));
}

function countBy(values, keyOf) {
  return values.reduce((counts, value) => {
    const key = keyOf(value);
    counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map());
}

const CONSTRAINT_KEYS = Object.freeze({
  employer: employerOf,
  source: sourceOf,
  lane: laneOf,
  roleFamily: roleFamilyOf,
  location: locationOf,
});

function selectionCounts(values) {
  return Object.fromEntries(Object.entries(CONSTRAINT_KEYS)
    .map(([name, keyOf]) => [name, countBy(values, keyOf)]));
}

function addSelectionCount(counts, vacancy) {
  for (const [name, keyOf] of Object.entries(CONSTRAINT_KEYS)) {
    const key = keyOf(vacancy);
    counts[name].set(key, (counts[name].get(key) || 0) + 1);
  }
}

function limitFor(limit, proportion) {
  return Math.max(1, Math.floor(limit * proportion));
}

function constraintState(eligible, limit) {
  const employerCount = new Set(eligible.map(employerOf)).size;
  const sourceCount = new Set(eligible.map(sourceOf)).size;
  const laneCount = new Set(eligible.map(laneOf)).size;
  const roleFamilyCount = new Set(eligible.map(roleFamilyOf)).size;
  const locationCount = new Set(eligible.map(locationOf)).size;
  return {
    lane: laneCount >= 3 ? limitFor(limit, 0.5) : null,
    source: sourceCount >= 2 ? limitFor(limit, 0.6) : null,
    roleFamily: roleFamilyCount >= 3 ? limitFor(limit, 0.5) : null,
    location: locationCount >= 3 ? limitFor(limit, 0.5) : null,
    employer: employerCount >= 4 ? limitFor(limit, 0.3) : null,
  };
}

function permittedWithCounts(vacancy, counts, constraints) {
  return Object.entries(CONSTRAINT_KEYS).every(([name, keyOf]) => (
    !constraints[name] || (counts[name].get(keyOf(vacancy)) || 0) < constraints[name]
  ));
}

function permitted(vacancy, selected, constraints) {
  return permittedWithCounts(vacancy, selectionCounts(selected), constraints);
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
  const counts = selectionCounts(selected);
  while (selected.length < limit && selected.length < eligible.length) {
    const next = eligible.find((vacancy) => (
      !selected.includes(vacancy) && permittedWithCounts(vacancy, counts, constraints)
    ));
    if (next) {
      selected.push(next);
      addSelectionCount(counts, next);
      continue;
    }
    const nextConstraint = ['lane', 'source', 'roleFamily', 'location', 'employer']
      .find((name) => constraints[name]);
    if (!nextConstraint) break;
    constraints[nextConstraint] = null;
    relaxed.push(nextConstraint);
  }
  return { selected, constraintsRelaxed: relaxed, constraints };
}

function explore(selection, eligible, exploration, seed, constraints) {
  const count = Math.min(explorationCount(exploration, selection.length), selection.length);
  if (!count) return selection;
  const deterministicSet = new Set(selection);
  const remaining = eligible.filter((vacancy) => !deterministicSet.has(vacancy))
    .sort((left, right) => hash(seed, vacancyId(left)) - hash(seed, vacancyId(right)) || compareText(vacancyId(left), vacancyId(right)));
  if (!remaining.length) return selection;
  const result = [...selection];
  for (let index = 0; index < count && remaining.length; index += 1) {
    const candidate = remaining.shift();
    const replacement = [...result].sort(compareRanked).reverse().find((vacancy) => {
      const withoutVacancy = result.filter((item) => item !== vacancy);
      return permitted(candidate, withoutVacancy, constraints);
    });
    if (replacement) result.splice(result.indexOf(replacement), 1, candidate);
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
  const selected = explore(deterministic.selected, eligible, exploration, seed, deterministic.constraints);
  const deterministicIds = new Set(deterministic.selected.map(vacancyId));
  const selectedIds = new Set(selected.map(vacancyId));
  const topBudgetIds = new Set(eligible.slice(0, boundedLimit).map(vacancyId));
  const notSelected = ordered.filter((vacancy) => !selectedIds.has(vacancyId(vacancy)))
    .map((vacancy) => {
      const id = vacancyId(vacancy);
      const reason = scoreOf(vacancy) < Number(threshold)
        ? 'below-relevance-threshold'
        : deterministicIds.has(id)
          ? 'exploration-replacement'
          : topBudgetIds.has(id)
            ? 'diversity-limit'
            : 'assessment-capacity';
      return { vacancyId: id, score: scoreOf(vacancy), reason };
    });
  return {
    selected,
    belowCutoff,
    reasons: selected.map((vacancy) => ({
      vacancyId: vacancyId(vacancy), score: scoreOf(vacancy),
      reason: deterministicIds.has(vacancyId(vacancy)) ? 'deterministic-rank' : 'exploration',
    })),
    notSelected,
    constraintsRelaxed: deterministic.constraintsRelaxed,
    seed,
    threshold: Number(threshold),
  };
}
