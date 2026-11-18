import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import {
  CLOCK_RATIO_CAP,
  DRIFT_THRESHOLD,
  OVERRIDE_LABEL,
  SECONDS_PER_HOUR,
  baselineHours,
  gateDecision,
  groupTable,
  normalizeIssue,
  outcomeOf,
  predict,
  scorecard,
  summarize,
  toHours,
} from './lib/evidence';
import {
  getAdjustment,
  getPrediction,
  listReceipts,
  readHistory,
  saveAdjustment,
  savePrediction,
  saveReceipt,
  writeHistory,
} from './lib/store';

// How Estimate Guard works, in four steps:
//   1. PREDICT  - the issue panel compares a new ticket with similar finished ones.
//   2. DECIDE   - one click writes the corrected estimate back to Jira.
//   3. SETTLE   - when the ticket reaches Done, a trigger grades our warning.
//   4. SCORE    - the project page shows drift per label/type and how often we were right.

const PAGE_SIZE = 100;
const MAX_PAGES = 4;
const LOOKBACK_DAYS = 365;
const FIELDS = ['summary', 'issuetype', 'labels', 'timeoriginalestimate', 'timespent', 'created', 'resolutiondate', 'status', 'project', 'statuscategorychangedate'];

// ---------- JQL safety: validate keys, quote everything else ----------

const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{0,254}$/i;
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/i;

const assertProjectKey = (key) => {
  if (!key || !PROJECT_KEY_RE.test(key)) throw new Error(`Invalid project key: ${key}`);
  return String(key).toUpperCase();
};

const assertIssueKey = (key) => {
  if (!key || !ISSUE_KEY_RE.test(key)) throw new Error(`Invalid issue key: ${key}`);
  return String(key).toUpperCase();
};

const q = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// Deliberately no "timeSpent is not EMPTY": teams that never log time still have
// calendar evidence, which keeps the app useful on a brand-new project.
const doneJql = (projectKey) =>
  `project = ${q(assertProjectKey(projectKey))} AND statusCategory = Done AND updated >= -${LOOKBACK_DAYS}d ORDER BY updated DESC`;

// ---------- Jira calls ----------

async function readJson(res, what) {
  if (!res.ok) throw new Error(`${what} failed (${res.status}): ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function searchHistory(projectKey, as = 'user') {
  const requester = as === 'app' ? api.asApp() : api.asUser();
  const issues = [];
  let nextPageToken;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await requester.requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jql: doneJql(projectKey), fields: FIELDS, maxResults: PAGE_SIZE, nextPageToken }),
    });
    const data = await readJson(res, 'Jira search');
    issues.push(...(data.issues ?? []).map(normalizeIssue));
    nextPageToken = data.nextPageToken;
    if (!nextPageToken || data.isLast) break;
  }
  return issues;
}

// Cached per user: search results are permission-filtered, so a shared cache
// could show one user issues they are not allowed to see.
// The workflow gate has no user session, so it reads as the app under its own cache key.
async function getHistory(projectKey, accountId, as = 'user') {
  const cacheId = as === 'app' ? 'app' : accountId;
  const cached = await readHistory(projectKey, cacheId);
  if (cached) return cached;
  const issues = await searchHistory(projectKey, as);
  await writeHistory(projectKey, cacheId, issues);
  return issues;
}

/**
 * The single assessment behind the panel and the workflow gate:
 * judge the estimate the team first gave, then decide whether work may start.
 */
async function assess(issueKey, { projectKey, accountId, as = 'user' }) {
  const [{ raw }, history, stored, adjustment] = await Promise.all([
    fetchIssue(issueKey, as),
    getHistory(projectKey, accountId, as),
    getPrediction(issueKey),
    getAdjustment(issueKey),
  ]);
  const issue = normalizeIssue(raw);
  const currentHours = toHours(issue.estimateSeconds);
  const baseline = baselineHours(currentHours, stored, adjustment);
  const judged = { ...issue, estimateSeconds: Math.round(baseline * SECONDS_PER_HOUR) };
  const prediction = predict(judged, history.filter((i) => i.key !== issueKey));
  const gate = gateDecision(prediction, { currentHours, labels: issue.labels });
  return { issue, currentHours, baseline, stored, prediction, gate };
}

async function fetchIssue(issueKey, as = 'user') {
  const requester = as === 'app' ? api.asApp() : api.asUser();
  const res = await requester.requestJira(route`/rest/api/3/issue/${assertIssueKey(issueKey)}?fields=${FIELDS.join(',')}`, {
    headers: { Accept: 'application/json' },
  });
  return { raw: await readJson(res, `Loading ${issueKey}`) };
}

const resolver = new Resolver();

// ---------- 1. PREDICT: issue panel ----------

resolver.define('getIssuePrediction', async ({ context }) => {
  const issueKey = context.extension.issue.key;
  const projectKey = context.extension.project.key;
  const { currentHours, baseline, stored, prediction, gate } = await assess(issueKey, { projectKey, accountId: context.accountId });
  const result = { issueKey, ...prediction, currentHours, gate, overrideLabel: OVERRIDE_LABEL };

  // The estimate was raised to meet the evidence: confirm instead of asking for more.
  if (baseline < currentHours && gate.state === 'met') {
    return { ...result, recounted: { fromHours: baseline, toHours: currentHours } };
  }
  // Record the first warning only, so the Done trigger grades what we said up front.
  if (!stored || baseline === currentHours) await savePrediction(issueKey, result);
  return result;
});

// ---------- 2. DECIDE: write the corrected estimate back to Jira ----------

resolver.define('applyRecount', async ({ payload, context }) => {
  const issueKey = context.extension.issue.key;
  const hours = Number(payload?.hours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 1000) throw new Error('Estimate must be between 0 and 1000 hours.');

  const issue = normalizeIssue((await fetchIssue(issueKey)).raw);
  // As the user, so Jira enforces their edit permission and the history shows their name.
  const res = await api.asUser().requestJira(route`/rest/api/3/issue/${assertIssueKey(issueKey)}`, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { timetracking: { originalEstimate: `${hours}h` } } }),
  });
  await readJson(res, 'Updating the estimate');
  await saveAdjustment(issueKey, toHours(issue.estimateSeconds), hours);
  return { issueKey, estimateHours: hours };
});

// ---------- 4. SCORE: project page ----------

resolver.define('getProjectScorecard', async ({ context }) => {
  const projectKey = context.extension.project.key;
  const [issues, settled] = await Promise.all([getHistory(projectKey, context.accountId), listReceipts(projectKey)]);
  return {
    projectKey,
    analysed: issues.length,
    lookbackDays: LOOKBACK_DAYS,
    threshold: DRIFT_THRESHOLD,
    overall: summarize(issues),
    rows: groupTable(issues),
    grading: scorecard(settled),
    recent: settled.sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0)).slice(0, 10),
  };
});

export const handler = resolver.getDefinitions();

// ---------- 2b. GATE: refuse to start work on an estimate our own history refutes ----------

/**
 * Runs on a workflow transition as a validator, so it gets the issue key and must
 * answer { result, errorMessage }.
 *
 * Deliberately narrow about what it blocks, and deliberately cheap:
 *  - It reads only the warning the panel already stored. No Jira call, so it cannot
 *    stall a transition or time out, and the gate and the panel can never disagree.
 *  - It blocks on "severe" backed by logged time only. Calendar-elapsed evidence is
 *    directional and peer samples are thin, so neither is allowed to stop work.
 *  - A recount the developer applied opens the gate: they engaged with the evidence,
 *    which is all the app was ever asking for.
 *  - Anything unexpected lets the transition through. A bug in our app must never
 *    lock a team out of their own board.
 */
export const validateEstimateGuard = async (input) => {
  const issueKey = input?.issue?.key;
  if (!issueKey) return { result: true };
  try {
    // Live check as the app: works even if nobody ever opened the panel.
    const projectKey = assertProjectKey(String(issueKey).split('-')[0]);
    const { prediction, gate } = await assess(issueKey, { projectKey, as: 'app' });
    if (!gate.block) return { result: true };
    // Remember the warning, so the trigger can grade it (and any override) at Done.
    await savePrediction(issueKey, prediction);
    return { result: false, errorMessage: gate.message };
  } catch (err) {
    console.warn('Estimate Guard validator failed open', err.message);
    return { result: true };
  }
};

// ---------- 3. SETTLE: trigger on every issue update ----------

/**
 * When an issue moves into Done, compare what we predicted with what happened
 * and store a "receipt". Runs as the app, because a trigger has no user session.
 */
export async function onIssueUpdated(event) {
  const issueKey = event?.issue?.key;
  const movedStatus = (event?.changelog?.items ?? []).some((item) => item.field === 'status');
  if (!issueKey || !movedStatus) return { skipped: 'not a status change' };

  const { raw } = await fetchIssue(issueKey, 'app');
  if (raw.fields?.status?.statusCategory?.key !== 'done') return { skipped: 'not Done' };

  const issue = normalizeIssue(raw);
  const projectKey = raw.fields.project.key;
  // No "already settled" check: if a ticket is reopened, corrected and closed
  // again, the new receipt replaces the old one.

  const [prediction, adjustment] = await Promise.all([getPrediction(issue.key), getAdjustment(issue.key)]);
  // Grade against the estimate as it stood when we warned, not the corrected one.
  const baselineHours = adjustment?.fromHours || toHours(issue.estimateSeconds);
  if (baselineHours <= 0) return { skipped: 'never estimated' };

  const outcome = outcomeOf(issue);
  const actualHours =
    outcome.basis === 'time' ? toHours(issue.spentSeconds) : Math.min(outcome.elapsedHours, CLOCK_RATIO_CAP * baselineHours);
  if (actualHours <= 0) return { skipped: 'no evidence of effort' };

  const receipt = {
    key: issue.key,
    url: issue.url,
    projectKey,
    summary: issue.summary,
    baselineHours,
    estimateHours: toHours(issue.estimateSeconds),
    actualHours: Math.round(actualHours * 10) / 10,
    actualRatio: Math.round((actualHours / baselineHours) * 100) / 100,
    basis: outcome.basis,
    warned: Boolean(prediction?.warned),
    // False when nobody opened the panel before the work was done.
    checked: Boolean(prediction),
    // The team started against our advice; graded like any other call.
    overridden: issue.labels.some((l) => String(l).toLowerCase() === OVERRIDE_LABEL),
    recountApplied: Boolean(adjustment),
    resolvedAt: issue.resolvedMs || Date.now(),
  };
  await saveReceipt(receipt);
  await postReceiptComment(receipt, prediction);
  return { settled: receipt.key, ratio: receipt.actualRatio };
}

// Jira's document format wants marks as objects: { type: 'strong' }, not 'bold'.
const MARKS = { bold: { type: 'strong' }, italic: { type: 'em' } };
const text = (value, marks = []) => ({
  type: 'text',
  text: String(value),
  ...(marks.length ? { marks: marks.map((m) => MARKS[m]).filter(Boolean) } : {}),
});
const paragraph = (runs) => ({ type: 'paragraph', content: runs });

/**
 * The receipt is stored first and the comment is best-effort: a webhook has no
 * user session, and a comment Jira refuses must not cost us the grading record.
 */
async function postReceiptComment(receipt, prediction) {
  const verdict = receipt.warned ? 'Estimate Guard warned before this ticket started.' : 'Estimate Guard saw no risk before this ticket started.';
  const body = {
    body: {
      type: 'doc',
      version: 1,
      content: [
        paragraph([text('Estimate Guard receipt', ['bold']), text(`  ·  ${verdict}`)]),
        paragraph([
          text('Planned '),
          text(`${receipt.baselineHours}h`, ['bold']),
          text(`  ·  Evidence (${receipt.basis}) `),
          text(`${receipt.actualHours}h`, ['bold']),
          text(`  ·  Ratio `),
          text(`${receipt.actualRatio}x`, ['bold']),
        ]),
        ...(prediction?.suggestedHighHours
          ? [paragraph([text(`We had suggested up to ${Math.round(prediction.suggestedHighHours)}h, from `),
              text(`${prediction.sampleSize ?? 0} comparable finished tickets`, ['italic']),
              text(receipt.recountApplied ? ' - and the recount was applied.' : ' - the estimate was left as it was.')])]
          : []),
      ],
    },
  };
  try {
    const res = await api.asApp().requestJira(route`/rest/api/3/issue/${assertIssueKey(receipt.key)}/comment`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.warn(`Receipt comment refused (${res.status})`);
  } catch (err) {
    console.warn('Receipt comment failed', err.message);
  }
}

// ---------- Rovo agent + MCP tools (read-only, as the user) ----------

const resolveProjectKey = (payload) => assertProjectKey(payload?.projectKey || payload?.context?.jira?.projectKey);

const guard = async (name, fn) => {
  try {
    return await fn();
  } catch (err) {
    console.error(`${name} failed`, err);
    return { error: err.message };
  }
};

/** "What will this ticket really take?" for a hypothetical or existing ticket. */
export const predictEffort = (payload) =>
  guard('predictEffort', async () => {
    const projectKey = resolveProjectKey(payload);
    const hours = Number(payload?.hours);
    const label = payload?.label?.trim();
    const issueType = payload?.issueType?.trim();
    const target = normalizeIssue({
      key: '__target__',
      fields: {
        summary: payload?.summary?.trim() || `${label ?? ''} ${issueType ?? ''} work`,
        issuetype: { name: issueType || 'Task' },
        labels: label ? [label] : [],
        timeoriginalestimate: Number.isFinite(hours) && hours > 0 ? Math.round(hours * SECONDS_PER_HOUR) : null,
      },
    });
    const history = await searchHistory(projectKey);
    return { projectKey, ...predict(target, history) };
  });

/** Project-wide accuracy: worst labels/types, and how often past warnings were right. */
export const getAccuracyScorecard = (payload) =>
  guard('getAccuracyScorecard', async () => {
    const projectKey = resolveProjectKey(payload);
    const [issues, settled] = await Promise.all([searchHistory(projectKey), listReceipts(projectKey)]);
    return {
      projectKey,
      analysed: issues.length,
      threshold: DRIFT_THRESHOLD,
      overall: summarize(issues),
      worst: groupTable(issues).slice(0, 10),
      grading: scorecard(settled),
    };
  });
