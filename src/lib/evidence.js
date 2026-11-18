// Pure prediction engine. No Forge imports and no network, so every branch here is unit-tested.

export const SECONDS_PER_HOUR = 3600;
export const HOURS_PER_DAY = 24;

// Reality/plan ratio at which the process is broken, and where we start warning.
export const DRIFT_THRESHOLD = 1.5;
export const WARN_AT = 1.35;
export const MIN_SAMPLE = 4;

// Calendar time from creation to done includes days spent waiting in the backlog,
// so an uncapped clock ratio can hit 40x and destroy the median. Cap it and mark
// the result soft, which keeps the signal (relative ordering) and drops the noise.
export const CLOCK_RATIO_CAP = 6;

const round = (n, p = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** p) / 10 ** p : 0);

export const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** REST self URL -> human browse URL, so the UI can link the receipts it cites. */
export function browseUrl(self) {
  const match = /^(https?:\/\/[^/]+)\/rest\/api\/3\/issue\/([^/?#]+)/i.exec(String(self ?? ''));
  return match ? `${match[1]}/browse/${match[2]}` : '';
}

export function normalizeIssue(rawIssue) {
  const f = rawIssue.fields || {};
  return {
    key: rawIssue.key,
    // Link by key (/browse/KAN-12); the REST self link only carries the numeric id.
    url: browseUrl(rawIssue.self).replace(/\/browse\/[^/]+$/, rawIssue.key ? `/browse/${rawIssue.key}` : ''),
    summary: f.summary ?? '',
    issueType: f.issuetype?.name ?? 'Unknown',
    labels: Array.isArray(f.labels) ? f.labels : [],
    estimateSeconds: f.timeoriginalestimate ?? 0,
    spentSeconds: f.timespent ?? 0,
    createdMs: f.created ? Date.parse(f.created) : 0,
    // Team-managed spaces may never set a resolution, so fall back to the time it entered Done.
    resolvedMs: Date.parse(f.resolutiondate || f.statuscategorychangedate || '') || 0,
  };
}

export const toHours = (seconds) => round(seconds / SECONDS_PER_HOUR, 1);

// Wall-clock age. Noisy, but present in every Jira project on earth.
export function elapsedHours(issue) {
  if (!issue.createdMs || !issue.resolvedMs || issue.resolvedMs <= issue.createdMs) return 0;
  return (issue.resolvedMs - issue.createdMs) / (SECONDS_PER_HOUR * 1000);
}

/**
 * What actually happened to a finished ticket.
 *   time  - logged work vs original estimate: exact, needs time tracking.
 *   clock - calendar time vs original estimate: directional only.
 * `notionalSeconds` is what reality cost expressed in estimate units, so a group
 * total can mix both signals without inventing effort nobody logged.
 */
export function outcomeOf(issue) {
  const estHours = issue.estimateSeconds / SECONDS_PER_HOUR;
  if (estHours <= 0) return { basis: 'none', ratio: 0, effortHours: 0, elapsedHours: toHours(elapsedHours(issue)), notionalSeconds: 0 };

  if (issue.spentSeconds > 0) {
    return {
      basis: 'time',
      ratio: issue.spentSeconds / issue.estimateSeconds,
      effortHours: toHours(issue.spentSeconds),
      elapsedHours: toHours(elapsedHours(issue)),
      notionalSeconds: issue.spentSeconds,
    };
  }

  const elapsed = elapsedHours(issue);
  if (elapsed > 0) {
    const ratio = Math.min(elapsed / estHours, CLOCK_RATIO_CAP);
    return { basis: 'clock', ratio, effortHours: 0, elapsedHours: round(elapsed, 1), notionalSeconds: ratio * issue.estimateSeconds };
  }
  return { basis: 'none', ratio: 0, effortHours: 0, elapsedHours: 0, notionalSeconds: 0 };
}

const STOPWORDS = new Set(
  ('a an the and or but of to in on for with without from into at by as is are was be been being this that these those '
    + 'it its we our you your they their he she i not no yes will would should could can may might do does did done have has had '
    + 'up down out over under again then once here there all any both each few more most other such only own same so than too very '
    + 'please add update fix create make made use using used new old issue ticket task story bug subtest subtask')
    .split(/\s+/),
);

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
};

/** Shared labels dominate the score; similar wording only breaks ties. */
export function similarity(target, candidate) {
  const targetLabels = new Set(target.labels.map((l) => String(l).toLowerCase()));
  const sharedLabels = candidate.labels.filter((l) => targetLabels.has(String(l).toLowerCase()));
  const wordScore = jaccard(new Set(tokenize(target.summary)), new Set(tokenize(candidate.summary)));
  const typeScore = candidate.issueType === target.issueType ? 1 : 0;
  return {
    score: round(sharedLabels.length * 3 + typeScore * 2 + wordScore * 4, 3),
    sharedLabels,
    wordScore: round(wordScore, 2),
  };
}

/** The finished tickets we will name out loud to the developer. */
// Among equally similar tickets, `typicalRatio` puts first the ones closest to the
// team's median overrun, so the cited examples match the number we quote. This is
// "most representative", not "most dramatic": we never cherry-pick the worst cases.
export function rankExemplars(target, history, limit = 3, typicalRatio = null) {
  const distance = (entry) => (typicalRatio > 0 ? Math.abs(entry.outcome.ratio - typicalRatio) : 0);
  return history
    .filter((issue) => issue.key !== target.key)
    .map((issue) => {
      const outcome = outcomeOf(issue);
      return { issue, outcome, ...similarity(target, issue) };
    })
    .filter((entry) => entry.score > 0.6 && (entry.outcome.basis !== 'none' || entry.outcome.elapsedHours > 0))
    .sort((a, b) => b.score - a.score || distance(a) - distance(b) || b.issue.resolvedMs - a.issue.resolvedMs)
    .slice(0, limit)
    .map((entry) => ({
      key: entry.issue.key,
      url: entry.issue.url,
      summary: entry.issue.summary,
      issueType: entry.issue.issueType,
      score: entry.score,
      sharedLabels: entry.sharedLabels,
      basis: entry.outcome.basis === 'time' ? 'time' : 'clock',
      estimateHours: toHours(entry.issue.estimateSeconds),
      actualHours: entry.outcome.effortHours || entry.outcome.notionalSeconds / SECONDS_PER_HOUR,
      elapsedDays: round(entry.outcome.elapsedHours / HOURS_PER_DAY, 1),
      ratio: round(entry.outcome.ratio, 2),
    }));
}

// Widest peer group that still means something: labels, then issue type, then project.
function findPeerSet(target, history) {
  const isComparable = (i) => i.key !== target.key && (outcomeOf(i).basis !== 'none' || elapsedHours(i) > 0);
  const comparable = history.filter(isComparable);
  const targetLabels = new Set(target.labels.map((l) => String(l).toLowerCase()));

  const byLabel = comparable.filter((i) => i.labels.some((l) => targetLabels.has(String(l).toLowerCase())));
  if (byLabel.length) return { issues: byLabel, basis: 'label', evidence: `labels: ${target.labels.join(', ')}` };

  const byType = comparable.filter((i) => i.issueType === target.issueType);
  if (byType.length) return { issues: byType, basis: 'type', evidence: `issue type: ${target.issueType}` };

  return { issues: comparable, basis: 'project', evidence: 'all completed work in this project' };
}

function verdictFor(ratio) {
  if (ratio >= DRIFT_THRESHOLD) return 'severe';
  if (ratio >= WARN_AT) return 'optimistic';
  if (ratio > 0 && ratio < 1.2) return 'trustworthy';
  return 'ok';
}

/**
 * The core question: given this ticket and our own history, what will it really take?
 * Logged work always wins when we have enough of it; calendar time is the fallback
 * that lets the panel stay useful on teams that never log a minute.
 */
export function predict(target, history) {
  const peers = findPeerSet(target, history);
  const outcomes = peers.issues.map(outcomeOf);
  const timeOutcomes = outcomes.filter((o) => o.basis === 'time');
  const usableOutcomes = timeOutcomes.length >= MIN_SAMPLE ? timeOutcomes : outcomes.filter((o) => o.basis !== 'none');

  const exemplars = rankExemplars(target, history);
  const base = {
    peerBasis: peers.basis,
    evidence: peers.evidence,
    threshold: DRIFT_THRESHOLD,
    exemplars,
    estimateHours: toHours(target.estimateSeconds),
  };

  if (usableOutcomes.length >= MIN_SAMPLE) {
    const medianRatio = round(median(usableOutcomes.map((o) => o.ratio)), 2);
    const soft = usableOutcomes.every((o) => o.basis === 'clock');
    const basis = timeOutcomes.length >= MIN_SAMPLE ? 'time' : 'clock';
    const hasEstimate = target.estimateSeconds > 0;
    // With an estimate typed, scale it by our own bias. Without one, the median
    // cost of comparable tickets is already the answer - do not multiply twice.
    const expected = hasEstimate
      ? (target.estimateSeconds / SECONDS_PER_HOUR) * medianRatio
      : median(usableOutcomes.map((o) => o.effortHours || o.notionalSeconds / SECONDS_PER_HOUR));

    return {
      ...base,
      exemplars: rankExemplars(target, history, 3, medianRatio),
      mode: hasEstimate ? 'recount' : 'suggest',
      basis,
      verdict: hasEstimate ? verdictFor(medianRatio) : 'unknown',
      sampleSize: usableOutcomes.length,
      medianRatio,
      // Rounded to the nearest half hour: the value the "Update estimate" button writes.
      suggestedHours: Math.max(0.5, Math.round(expected * 2) / 2),
      suggestedLowHours: round(expected * 0.85, 1),
      suggestedHighHours: round(expected * 1.3, 1),
      unplannedHours: hasEstimate ? round(expected - target.estimateSeconds / SECONDS_PER_HOUR, 1) : null,
      soft,
    };
  }

  // Last resort: nothing was estimated or logged, but tickets still got closed.
  const elapsed = peers.issues.map(elapsedHours).filter((h) => h > 0).sort((a, b) => a - b);
  if (!target.estimateSeconds && elapsed.length >= MIN_SAMPLE) {
    const q = (p) => round(elapsed[Math.floor((elapsed.length - 1) * p)] / HOURS_PER_DAY, 1);
    return {
      ...base,
      mode: 'suggest',
      basis: 'elapsed',
      verdict: 'unknown',
      sampleSize: elapsed.length,
      medianRatio: null,
      suggestedLowHours: null,
      suggestedHighHours: null,
      elapsedDaysLow: q(0.25),
      elapsedDaysHigh: q(0.75),
      soft: true,
    };
  }

  return { ...base, mode: 'unknown', verdict: 'unknown', basis: 'none', sampleSize: usableOutcomes.length, medianRatio: null, soft: false };
}

// Adding this label lets work start against our advice. The override is graded
// at Done like any warning, so the team and the app are both held to account.
export const OVERRIDE_LABEL = 'estimate-override';

const hasOverride = (labels) => (labels ?? []).some((l) => String(l).toLowerCase() === OVERRIDE_LABEL);

/**
 * Which estimate do we judge? The one the team first gave us. If the estimate has
 * been raised since our first warning (by the Recount button or typed by hand),
 * judging the new number would just ask for more again, forever.
 */
export function baselineHours(currentHours, stored, adjustment) {
  if (adjustment?.fromHours > 0 && currentHours >= adjustment.fromHours) return adjustment.fromHours;
  if (stored?.estimateHours > 0 && currentHours > stored.estimateHours) return stored.estimateHours;
  return currentHours;
}

/**
 * The one rule that decides whether work may start. Used by the workflow validator
 * and shown in the panel, so the two can never disagree.
 *
 * Blocks only on the strongest evidence: a "severe" verdict, from logged time (not
 * calendar), with at least MIN_SAMPLE finished tickets, and a current estimate still
 * below the low end of what that work really costs. Raising the estimate to the
 * evidence, or adding the override label, opens the gate.
 */
export function gateDecision(prediction, { currentHours = 0, labels = [] } = {}) {
  const evidence =
    prediction?.mode === 'recount' &&
    prediction.verdict === 'severe' &&
    prediction.basis === 'time' &&
    (prediction.sampleSize ?? 0) >= MIN_SAMPLE;
  const floorHours = evidence ? Math.max(0.5, Math.floor(prediction.suggestedLowHours * 2) / 2) : 0;
  const overridden = hasOverride(labels);

  if (!evidence) return { block: false, state: 'clear', floorHours: 0, overridden };
  if (currentHours >= floorHours) return { block: false, state: 'met', floorHours, overridden };
  if (overridden) return { block: false, state: 'overridden', floorHours, overridden };

  const cites = (prediction.exemplars ?? []).slice(0, 3).map((e) => e.key).join(', ');
  return {
    block: true,
    state: 'blocked',
    floorHours,
    overridden,
    message:
      `Estimate Guard: ${currentHours}h is below what this work really costs here. ` +
      `${prediction.sampleSize} finished tickets like it${cites ? ` (${cites})` : ''} ran ${prediction.medianRatio}x their estimate. ` +
      `Raise the estimate to at least ${floorHours}h (one click in the Estimate Guard panel), ` +
      `or add the label "${OVERRIDE_LABEL}" to start anyway - the override is graded when the ticket is done.`,
  };
}

/** Group totals for the scorecard table. Both signals fold into notional seconds. */
export function summarize(issues) {
  const measured = issues.filter((i) => i.estimateSeconds > 0 && outcomeOf(i).basis !== 'none');
  if (!measured.length) {
    return { sampleSize: 0, timeBasis: 0, clockBasis: 0, avgEstimateHours: 0, avgActualHours: 0, driftRatio: 0, medianDrift: 0, medianActualHours: 0 };
  }
  const outcomes = measured.map(outcomeOf);
  const totalEstimate = measured.reduce((s, i) => s + i.estimateSeconds, 0);
  const totalActual = outcomes.reduce((s, o) => s + o.notionalSeconds, 0);
  return {
    sampleSize: measured.length,
    timeBasis: outcomes.filter((o) => o.basis === 'time').length,
    clockBasis: outcomes.filter((o) => o.basis === 'clock').length,
    avgEstimateHours: toHours(totalEstimate / measured.length),
    avgActualHours: toHours(totalActual / measured.length),
    // Both sides are seconds, so this is a plain size-weighted ratio.
    driftRatio: round(totalActual / totalEstimate),
    medianDrift: round(median(outcomes.map((o) => o.ratio))),
    medianActualHours: round(median(outcomes.map((o) => o.notionalSeconds / SECONDS_PER_HOUR)), 1),
  };
}

/**
 * The "Estimation Accuracy" table: one row per label and per issue type with
 * average estimate, average actual and drift ratio. Worst drift first.
 */
export function groupTable(issues) {
  const groups = new Map();
  const add = (kind, name, issue) => {
    const id = `${kind}:${name}`;
    if (!groups.has(id)) groups.set(id, { kind, name, issues: [] });
    groups.get(id).issues.push(issue);
  };
  for (const issue of issues) {
    add('Issue type', issue.issueType, issue);
    issue.labels.forEach((label) => add('Label', label, issue));
  }
  return [...groups.values()]
    .map(({ kind, name, issues: members }) => ({ kind, name, ...summarize(members) }))
    .filter((row) => row.sampleSize > 0)
    .sort((a, b) => b.driftRatio - a.driftRatio || b.sampleSize - a.sampleSize);
}

/** Bias map: rows are labels then issue types, cells are the median reality/plan. */
export function buildBiasMatrix(issues) {
  const measured = issues.map((issue) => ({ issue, outcome: outcomeOf(issue) })).filter((m) => m.outcome.basis !== 'none');
  const columns = [...new Set(measured.map((m) => m.issue.issueType))].sort();
  const labelCounts = new Map();
  measured.forEach((m) => m.issue.labels.forEach((l) => labelCounts.set(l, (labelCounts.get(l) ?? 0) + 1)));
  const labels = [...labelCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label]) => label);

  const cell = (subset) =>
    subset.length ? { medianDrift: round(median(subset.map((m) => m.outcome.ratio))), sampleSize: subset.length } : null;

  const labelRows = labels.map((label) => ({
    name: label,
    kind: 'Label',
    cells: columns.map((type) => cell(measured.filter((m) => m.issue.issueType === type && m.issue.labels.includes(label)))),
  }));
  const typeRows = columns.map((type) => ({
    name: type,
    kind: 'Issue type',
    cells: columns.map((column) => (column === type ? cell(measured.filter((m) => m.issue.issueType === type)) : null)),
  }));

  return { columns, rows: [...labelRows, ...typeRows] };
}

/**
 * Did the warnings earn their keep? Judged afterwards against what really happened.
 * This is the number no estimation app in the marketplace can show.
 *
 * `baselineHours` is the estimate as it stood when we warned. If the developer took
 * our advice and recounted, grading against the *current* estimate would make every
 * successful warning look wrong, so receipts carry the original number separately.
 */
export function scorecard(receipts) {
  const settled = receipts.filter((r) => r.actualRatio > 0);
  const planned = (r) => r.baselineHours ?? r.estimateHours;
  const warned = settled.filter((r) => r.warned);
  const right = warned.filter((r) => r.actualRatio >= DRIFT_THRESHOLD);
  // Only count a miss when we actually looked at the ticket and stayed quiet.
  const missedSilently = settled.filter((r) => r.checked && !r.warned && r.actualRatio >= DRIFT_THRESHOLD);
  return {
    settled: settled.length,
    warned: warned.length,
    warnedAndRight: right.length,
    precisionPct: warned.length ? Math.round((right.length / warned.length) * 100) : null,
    missedPct: settled.length ? Math.round((missedSilently.length / settled.length) * 100) : null,
    unplannedHours: round(settled.reduce((s, r) => s + Math.max(0, r.actualHours - planned(r)), 0), 1),
    medianRatio: round(median(settled.map((r) => r.actualRatio)), 2),
    recountsApplied: settled.filter((r) => r.recountApplied).length,
    timeBasis: settled.filter((r) => r.basis === 'time').length,
    clockBasis: settled.filter((r) => r.basis === 'clock').length,
  };
}
