import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOCK_RATIO_CAP,
  DRIFT_THRESHOLD,
  MIN_SAMPLE,
  browseUrl,
  normalizeIssue,
  outcomeOf,
  similarity,
  rankExemplars,
  predict,
  gateDecision,
  summarize,
  buildBiasMatrix,
  scorecard,
} from '../src/lib/evidence.js';

const H = 3600;
const DAY = 24 * H * 1000; // resolutiondate is epoch milliseconds
const BASE = Date.parse('2026-01-05T09:00:00.000Z');

// Build a Jira-shaped raw issue, then run it through the real normalizer.
const raw = ({ key = 'E-0', summary = 'work', type = 'Task', labels = [], estHours = 0, spentHours = 0, tookDays = 0 }) =>
  normalizeIssue({
    key,
    fields: {
      summary,
      issuetype: { name: type },
      labels,
      timeoriginalestimate: estHours ? estHours * H : null,
      timespent: spentHours ? spentHours * H : null,
      created: new Date(BASE).toISOString(),
      resolutiondate: new Date(BASE + tookDays * DAY).toISOString(),
    },
  });

test('normalizeIssue survives issues with no time tracking at all', () => {
  const issue = normalizeIssue({ key: 'E-1', fields: { summary: 'x' } });
  assert.equal(issue.estimateSeconds, 0);
  assert.deepEqual(issue.labels, []);
});

test('outcomeOf prefers logged work, falls back to calendar time, gives up without an estimate', () => {
  assert.deepEqual(
    { ...outcomeOf(raw({ estHours: 4, spentHours: 12, tookDays: 30 })) }.basis,
    'time',
  );
  const time = outcomeOf(raw({ estHours: 4, spentHours: 12, tookDays: 30 }));
  assert.equal(time.ratio, 3);
  assert.equal(time.effortHours, 12);

  const clock = outcomeOf(raw({ estHours: 4, tookDays: 0.5 }));
  assert.equal(clock.basis, 'clock');
  assert.equal(clock.ratio, 3);

  // Two weeks of backlog ageing must not be reported as a 84x overrun.
  const aged = outcomeOf(raw({ estHours: 4, tookDays: 14 }));
  assert.equal(aged.ratio, CLOCK_RATIO_CAP);

  assert.equal(outcomeOf(raw({ spentHours: 8, tookDays: 2 })).basis, 'none');
});

test('similarity is driven by shared labels, not by lookalike wording', () => {
  const target = raw({ key: 'E-0', summary: 'rate limiter middleware', labels: ['backend'] });
  const sameLabel = raw({ key: 'E-1', summary: 'gzip middleware', labels: ['backend'] });
  const sameWords = raw({ key: 'E-2', summary: 'rate limiter dashboard', labels: ['frontend'] });
  assert.ok(similarity(target, sameLabel).score > similarity(target, sameWords).score);
  assert.deepEqual(similarity(target, sameLabel).sharedLabels, ['backend']);
});

test('predict demands a recount when the team always underestimates that label', () => {
  const history = [
    raw({ key: 'E-1', summary: 'payments endpoint', type: 'Story', labels: ['backend'], estHours: 4, spentHours: 11, tookDays: 6 }),
    raw({ key: 'E-2', summary: 'auth endpoint', type: 'Story', labels: ['backend'], estHours: 6, spentHours: 15, tookDays: 8 }),
    raw({ key: 'E-3', summary: 'refunds endpoint', type: 'Story', labels: ['backend'], estHours: 3, spentHours: 8, tookDays: 4 }),
    raw({ key: 'E-4', summary: 'ledger endpoint', type: 'Story', labels: ['backend'], estHours: 8, spentHours: 17, tookDays: 9 }),
  ];
  const result = predict(raw({ key: 'E-9', summary: 'new webhooks endpoint', type: 'Story', labels: ['backend'], estHours: 4 }), history);

  assert.equal(result.mode, 'recount');
  assert.equal(result.basis, 'time');
  assert.equal(result.verdict, 'severe');
  assert.equal(result.peerBasis, 'label');
  assert.equal(result.sampleSize, 4);
  assert.equal(result.medianRatio, 2.58);
  assert.equal(result.soft, false);
  assert.ok(result.suggestedLowHours > 4);
  assert.ok(result.suggestedHighHours > result.suggestedLowHours);
  assert.equal(result.unplannedHours, 6.3);
  assert.equal(result.exemplars.length, 3);
  assert.equal(result.exemplars[0].basis, 'time');
});

test('a trustworthy team gets a green light, not a warning', () => {
  const history = [5, 6, 7, 8].map((h, i) =>
    raw({ key: `T-${i}`, labels: ['docs'], estHours: h, spentHours: h + 1, tookDays: 1 }),
  );
  const result = predict(raw({ key: 'T-9', labels: ['docs'], estHours: 6 }), history);
  assert.equal(result.verdict, 'trustworthy');
  assert.ok(result.medianRatio < DRIFT_THRESHOLD);
});

test('the amber band sits between fine and broken', () => {
  const history = [1.4, 1.38, 1.42, 1.4].map((r, i) =>
    raw({ key: `A-${i}`, labels: ['api'], estHours: 5, spentHours: 5 * r, tookDays: 2 }),
  );
  const result = predict(raw({ key: 'A-9', labels: ['api'], estHours: 5 }), history);
  assert.equal(result.verdict, 'optimistic');
});

test('predict never cites the ticket currently being estimated', () => {
  const history = Array.from({ length: 5 }, (_, i) =>
    raw({ key: `E-${i}`, labels: ['backend'], estHours: 4, spentHours: 9, tookDays: 5 }),
  );
  const keys = rankExemplars(raw({ key: 'E-2', summary: 'ledger sync', labels: ['backend'], estHours: 4 }), history).map((e) => e.key);
  assert.equal(keys.includes('E-2'), false);
  assert.equal(keys.length, 3);
});

test('predict still warns on a project where nobody logs time', () => {
  const history = Array.from({ length: 6 }, (_, i) =>
    raw({ key: `C-${i}`, summary: `migration step ${i}`, type: 'Task', labels: ['db'], estHours: 2, tookDays: 4 + i }),
  );
  const result = predict(raw({ key: 'C-9', summary: 'migration step 9', type: 'Task', labels: ['db'], estHours: 2 }), history);

  assert.equal(result.basis, 'clock');
  assert.equal(result.soft, true, 'calendar evidence must be flagged directional');
  assert.equal(result.medianRatio, CLOCK_RATIO_CAP);
  assert.equal(result.verdict, 'severe');
  assert.equal(result.exemplars[0].basis, 'clock');
  assert.ok(result.exemplars[0].elapsedDays > 0);
});

test('predict admits thin history instead of inventing a number', () => {
  const result = predict(
    raw({ key: 'E-2', labels: ['backend'], estHours: 4 }),
    [raw({ key: 'E-1', labels: ['backend'], estHours: 4, spentHours: 11, tookDays: 6 })],
  );
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.mode, 'unknown');
  assert.equal(result.sampleSize, 1);
  assert.ok(MIN_SAMPLE > 1);
});

test('with no estimate typed, predict quotes what comparable work actually cost', () => {
  const history = [
    raw({ key: 'E-1', labels: ['backend'], estHours: 4, spentHours: 10, tookDays: 5 }),
    raw({ key: 'E-2', labels: ['backend'], estHours: 6, spentHours: 14, tookDays: 5 }),
    raw({ key: 'E-3', labels: ['backend'], estHours: 3, spentHours: 9, tookDays: 5 }),
    raw({ key: 'E-4', labels: ['backend'], estHours: 8, spentHours: 18, tookDays: 5 }),
  ];
  const result = predict(raw({ key: 'E-5', summary: 'webhook retries', labels: ['backend'] }), history);
  assert.equal(result.mode, 'suggest');
  assert.equal(result.medianRatio, 2.42);
  // Median actual cost of peers is 12h: must not be multiplied by drift again.
  assert.equal(result.suggestedLowHours, 10.2);
  assert.equal(result.suggestedHighHours, 15.6);
});

test('a bare project with only dates still gets a duration band', () => {
  const history = [3, 4, 9, 20].map((d, i) => raw({ key: `N-${i}`, summary: `thing ${i}`, labels: ['ops'], tookDays: d }));
  const result = predict(raw({ key: 'N-9', summary: 'new thing', labels: ['ops'] }), history);
  assert.equal(result.basis, 'elapsed');
  assert.equal(result.mode, 'suggest');
  assert.equal(result.elapsedDaysLow, 3);
  assert.equal(result.elapsedDaysHigh, 9);
});

test('summarize weights by size and keeps the two signals countable', () => {
  const stats = summarize([
    raw({ key: 'S-1', estHours: 10, spentHours: 20, tookDays: 3 }),
    raw({ key: 'S-2', estHours: 2, spentHours: 2, tookDays: 3 }),
  ]);
  assert.equal(stats.sampleSize, 2);
  assert.equal(stats.timeBasis, 2);
  assert.equal(stats.driftRatio, 1.83);
  assert.equal(stats.medianDrift, 1.5);
  assert.equal(stats.avgEstimateHours, 6);
  assert.equal(stats.avgActualHours, 11);
});

test('buildBiasMatrix medians each label-by-type cell', () => {
  const matrix = buildBiasMatrix([
    raw({ key: 'B-1', type: 'Bug', labels: ['backend'], estHours: 2, spentHours: 6, tookDays: 2 }),
    raw({ key: 'B-2', type: 'Bug', labels: ['backend'], estHours: 2, spentHours: 2, tookDays: 2 }),
    raw({ key: 'B-3', type: 'Story', labels: ['backend'], estHours: 4, spentHours: 4, tookDays: 2 }),
  ]);
  assert.deepEqual(matrix.columns, ['Bug', 'Story']);
  const backend = matrix.rows.find((r) => r.name === 'backend');
  assert.equal(backend.cells[0].medianDrift, 2);
  assert.equal(backend.cells[1].medianDrift, 1);
  assert.equal(matrix.rows.find((r) => r.kind === 'Issue type').cells[0].sampleSize, 2);
});

test('browseUrl turns a REST self link into a clickable issue link', () => {
  assert.equal(
    browseUrl('https://acme.atlassian.net/rest/api/3/issue/10042'),
    'https://acme.atlassian.net/browse/10042',
  );
  assert.equal(browseUrl(undefined), '');
  assert.equal(browseUrl('https://acme.atlassian.net/rest/api/2/issue/1'), '');
});

test('accepting our recount does not make our own warning look wrong', () => {
  // We warned at 4h, the team recounted to 10h, the work really took 11h.
  const stats = scorecard([
    { estimateHours: 10, baselineHours: 4, actualHours: 11, actualRatio: 2.75, warned: true, recountApplied: true, basis: 'time' },
  ]);
  assert.equal(stats.unplannedHours, 7);
  assert.equal(stats.recountsApplied, 1);
  assert.equal(stats.precisionPct, 100);
});

test('scorecard grades the warnings against what really happened', () => {
  const receipts = [
    { estimateHours: 4, actualHours: 11, actualRatio: 2.75, warned: true, checked: true, basis: 'time' },
    { estimateHours: 4, actualHours: 9, actualRatio: 2.25, warned: true, checked: true, basis: 'time' },
    { estimateHours: 4, actualHours: 10, actualRatio: 2.5, warned: false, checked: true, basis: 'clock' },
    { estimateHours: 8, actualHours: 8, actualRatio: 1, warned: false, checked: true, basis: 'time' },
  ];
  const stats = scorecard(receipts);
  assert.equal(stats.settled, 4);
  assert.equal(stats.precisionPct, 100);
  assert.equal(stats.missedPct, 25);
  assert.equal(stats.unplannedHours, 18);
  assert.equal(stats.timeBasis, 3);
});

test('groupTable ranks labels and types worst drift first', async () => {
  const { groupTable } = await import('../src/lib/evidence.js');
  const rows = groupTable([
    raw({ key: 'G-1', type: 'Task', labels: ['backend'], estHours: 4, spentHours: 10, tookDays: 2 }),
    raw({ key: 'G-2', type: 'Task', labels: ['frontend'], estHours: 4, spentHours: 4, tookDays: 2 }),
  ]);
  assert.equal(rows[0].name, 'backend');
  assert.equal(rows[0].driftRatio, 2.5);
  assert.equal(rows.at(-1).name, 'frontend');
  assert.ok(rows.some((r) => r.kind === 'Issue type' && r.name === 'Task'));
});

test('recount offers a half-hour rounded estimate to write back', () => {
  const history = [4, 6, 3, 8].map((h, i) =>
    raw({ key: `R-${i}`, labels: ['backend'], estHours: h, spentHours: h * 2.5, tookDays: 3 }),
  );
  const result = predict(raw({ key: 'R-9', labels: ['backend'], estHours: 3 }), history);
  assert.equal(result.suggestedHours, 7.5);
});

// ---------- the gate: when a warning is allowed to stop work ----------

const warning = (over = {}) => ({
  mode: 'recount',
  verdict: 'severe',
  basis: 'time',
  sampleSize: MIN_SAMPLE,
  medianRatio: 2.6,
  suggestedLowHours: 6.8,
  exemplars: [{ key: 'E-1' }, { key: 'E-2' }, { key: 'E-3' }],
  ...over,
});

test('gate blocks only the verdict the logged time actually proves', () => {
  const blocked = gateDecision(warning(), { currentHours: 3 });
  assert.equal(blocked.block, true);
  assert.match(blocked.message, /E-1, E-2, E-3/);
  assert.match(blocked.message, /2.6x/);
  assert.match(blocked.message, /at least 6.5h/);

  const at3 = { currentHours: 3 };
  assert.equal(gateDecision(warning({ basis: 'clock' }), at3).block, false, 'calendar time is directional, not proof');
  assert.equal(gateDecision(warning({ verdict: 'optimistic' }), at3).block, false);
  assert.equal(gateDecision(warning({ sampleSize: MIN_SAMPLE - 1 }), at3).block, false);
  assert.equal(gateDecision(undefined, at3).block, false, 'no prediction at all');
});

test('gate opens the moment the estimate is raised to the evidence', () => {
  assert.equal(gateDecision(warning(), { currentHours: 6.5 }).block, false);
});

// ---------- The workflow gate ----------

const backendHistory = () =>
  [4, 6, 3, 8].map((h, i) => raw({ key: `G-${i}`, summary: `endpoint ${i}`, labels: ['backend'], estHours: h, spentHours: h * 2.5, tookDays: 3 }));

test('gate blocks an estimate the team history refutes, and names the proof', async () => {
  const { gateDecision } = await import('../src/lib/evidence.js');
  const prediction = predict(raw({ key: 'G-9', summary: 'webhooks endpoint', labels: ['backend'], estHours: 2 }), backendHistory());
  const gate = gateDecision(prediction, { currentHours: 2, labels: ['backend'] });
  assert.equal(gate.block, true);
  assert.equal(gate.state, 'blocked');
  assert.ok(gate.floorHours >= 4);
  assert.match(gate.message, /G-\d/);
  assert.match(gate.message, /estimate-override/);
});

test('gate opens once the estimate meets the evidence, however it was raised', async () => {
  const { gateDecision } = await import('../src/lib/evidence.js');
  const prediction = predict(raw({ key: 'G-9', labels: ['backend'], estHours: 2 }), backendHistory());
  const floor = gateDecision(prediction, { currentHours: 2 }).floorHours;
  assert.equal(gateDecision(prediction, { currentHours: floor }).state, 'met');
});

test('the override label lets work start and is reported as such', async () => {
  const { gateDecision } = await import('../src/lib/evidence.js');
  const prediction = predict(raw({ key: 'G-9', labels: ['backend'], estHours: 2 }), backendHistory());
  const gate = gateDecision(prediction, { currentHours: 2, labels: ['backend', 'Estimate-Override'] });
  assert.equal(gate.block, false);
  assert.equal(gate.state, 'overridden');
});

test('gate never blocks on thin or calendar-only evidence', async () => {
  const { gateDecision } = await import('../src/lib/evidence.js');
  const thin = predict(raw({ key: 'T-9', labels: ['backend'], estHours: 2 }), backendHistory().slice(0, 2));
  assert.equal(gateDecision(thin, { currentHours: 2 }).block, false);
  const clockOnly = Array.from({ length: 5 }, (_, i) => raw({ key: `C-${i}`, labels: ['db'], estHours: 2, tookDays: 5 }));
  const soft = predict(raw({ key: 'C-9', labels: ['db'], estHours: 2 }), clockOnly);
  assert.equal(gateDecision(soft, { currentHours: 2 }).block, false);
});

test('baseline keeps judging the first estimate after it was raised', async () => {
  const { baselineHours } = await import('../src/lib/evidence.js');
  assert.equal(baselineHours(8, null, { fromHours: 3, toHours: 8 }), 3); // via Recount
  assert.equal(baselineHours(7, { estimateHours: 3 }, null), 3); // typed by hand
  assert.equal(baselineHours(3, null, null), 3); // first look
  assert.equal(baselineHours(2, { estimateHours: 3 }, null), 2); // lowered: judge the new, worse number
});

test('cited examples are the typical overruns, not an accurate outlier', () => {
  const history = [
    raw({ key: 'X-1', labels: ['backend'], estHours: 4, spentHours: 10, tookDays: 2 }),
    raw({ key: 'X-2', labels: ['backend'], estHours: 4, spentHours: 10, tookDays: 2 }),
    raw({ key: 'X-3', labels: ['backend'], estHours: 4, spentHours: 11, tookDays: 2 }),
    raw({ key: 'X-4', labels: ['backend'], estHours: 4, spentHours: 9, tookDays: 2 }),
    // Most recent, but on target: it must not be the first thing we cite for a 2.5x warning.
    raw({ key: 'X-5', labels: ['backend'], estHours: 8, spentHours: 8, tookDays: 9 }),
  ];
  const result = predict(raw({ key: 'X-9', labels: ['backend'], estHours: 2 }), history);
  assert.equal(result.verdict, 'severe');
  assert.equal(result.exemplars.some((e) => e.key === 'X-5'), false);
  assert.ok(result.exemplars.every((e) => e.ratio >= 2));
});
