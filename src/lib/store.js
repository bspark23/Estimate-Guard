import { kvs, WhereConditions } from '@forge/kvs';

// Short, so edits to finished tickets show up on the next page load within minutes.
const HISTORY_TTL = { value: 2, unit: 'MINUTES' };

// The Jira history cache is keyed per account on purpose: search results are
// permission-filtered for the caller, so one shared project key would let a
// user read issues they are not allowed to see.
// Forge KVS keys only allow [a-zA-Z0-9:._-#] - a "/" is rejected at runtime with
// "Field 'key' must match pattern", so ":" is the separator throughout.
export const historyKey = (projectKey, accountId) => `hist:${projectKey}:${accountId}`;
export const predictionKey = (issueKey) => `pred:${issueKey}`;
export const adjustmentKey = (issueKey) => `adj:${issueKey}`;
export const receiptKey = (projectKey, issueKey) => `receipt:${projectKey}:${issueKey}`;
const receiptPrefix = (projectKey) => `receipt:${projectKey}:`;

export async function readHistory(projectKey, accountId) {
  if (!accountId) return undefined;
  const hit = await kvs.get(historyKey(projectKey, accountId));
  return hit?.issues;
}

export async function writeHistory(projectKey, accountId, issues) {
  if (!accountId) return;
  await kvs.set(historyKey(projectKey, accountId), { issues, cachedAt: Date.now() }, { ttl: HISTORY_TTL });
}

/** What we told the developer, kept so the warning can be graded after the fact. */
export async function savePrediction(issueKey, prediction) {
  await kvs.set(predictionKey(issueKey), {
    verdict: prediction.verdict,
    // The estimate we judged, so a later manual raise is recognised as taking the advice.
    estimateHours: prediction.estimateHours ?? 0,
    medianRatio: prediction.medianRatio ?? null,
    suggestedHighHours: prediction.suggestedHighHours ?? null,
    basis: prediction.basis,
    sampleSize: prediction.sampleSize,
    exemplarKeys: (prediction.exemplars ?? []).map((e) => e.key),
    warned: prediction.verdict === 'severe' || prediction.verdict === 'optimistic',
    at: Date.now(),
  });
}

export const getPrediction = (issueKey) => kvs.get(predictionKey(issueKey));

/** A recount the developer accepted, so grading uses the number we started from. */
export async function saveAdjustment(issueKey, fromHours, toHours) {
  await kvs.set(adjustmentKey(issueKey), { fromHours, toHours, at: Date.now() });
}

export const getAdjustment = (issueKey) => kvs.get(adjustmentKey(issueKey));

export const hasReceipt = (projectKey, issueKey) => kvs.get(receiptKey(projectKey, issueKey));

export async function saveReceipt(receipt) {
  await kvs.set(receiptKey(receipt.projectKey, receipt.key), receipt);
}

// KVS rejects a list-query limit of 100 or more, so read 99 at a time and walk
// the cursor until the caller's budget is met.
const PAGE_SIZE = 99;
const MAX_PAGES = 10;

export async function listReceipts(projectKey, limit = 300) {
  const receipts = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES && receipts.length < limit; page += 1) {
    const query = kvs
      .query()
      .where('key', WhereConditions.beginsWith(receiptPrefix(projectKey)))
      .limit(Math.min(PAGE_SIZE, limit - receipts.length));
    const result = await (cursor ? query.cursor(cursor) : query).getMany();
    receipts.push(...(result.results ?? []).map((entry) => entry.value));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return receipts.slice(0, limit);
}
