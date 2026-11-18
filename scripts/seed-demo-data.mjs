#!/usr/bin/env node
/**
 * Gives an empty Jira project a believable estimation history in one command, so a
 * judge (or your demo video) sees a red row and a green row immediately.
 *
 *   JIRA_SITE=acme.atlassian.net JIRA_EMAIL=you@example.com \
 *   JIRA_API_TOKEN=... JIRA_PROJECT_KEY=ENG node scripts/seed-demo-data.mjs
 *
 * Credentials are read from the environment only. Never put a token in this file,
 * in git, or in the demo video.
 */

const SITE = process.env.JIRA_SITE;
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT = process.env.JIRA_PROJECT_KEY?.toUpperCase();

const missing = [
  ['JIRA_SITE', SITE],
  ['JIRA_EMAIL', EMAIL],
  ['JIRA_API_TOKEN', TOKEN],
  ['JIRA_PROJECT_KEY', PROJECT],
].filter(([, v]) => !v).map(([k]) => k);

if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  console.error('Create an API token at id.atlassian.com > Security > API tokens.');
  process.exit(1);
}

const BASE = `https://${SITE.replace(/^https?:\/\//, '')}`;
const AUTH = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`;

// Two areas with opposite personalities: the bias map needs contrast to mean anything.
const RECIPE = [
  { label: 'backend', type: 'Story', summaries: ['Payment retry endpoint', 'Auth token refresh', 'Webhook fan-out', 'Ledger reconciliation job'], estimates: [4, 6, 3, 8], overrun: 2.6 },
  { label: 'db-migration', type: 'Bug', summaries: ['Schema drift on orders', 'Missing index on sessions', 'Deadlock in queue table'], estimates: [2, 4, 3], overrun: 3.2 },
  { label: 'frontend', type: 'Task', summaries: ['Empty state for wallet', 'Copy tweaks on settings', 'Date format in reports', 'Tooltip on invoice'], estimates: [2, 3, 1, 4], overrun: 1.0 },
];

const api = async (path, options = {}) => {
  const res = await fetch(`${BASE}/rest/api/3${path}`, {
    ...options,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: AUTH, ...options.headers },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${options.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

// Issue type names differ per project, so resolve them instead of assuming.
async function issueTypeIds() {
  const meta = await api(`/issue/createmeta/${PROJECT}?expansion=project`);
  const project = (meta.projects ?? [])[0];
  if (!project) throw new Error(`Project ${PROJECT} not found for this site/token.`);
  return new Map((project.issues ?? []).map((t) => [String(t.name).toLowerCase(), t.id]));
}

const findDoneTransition = async (issueKey) => {
  const { transitions = [] } = await api(`/issue/${issueKey}/transitions`);
  const toStatuses = transitions.map((t) => t.to?.statusCategory?.key).filter(Boolean);
  const index = toStatuses.indexOf('done');
  if (index >= 0) return transitions[index];
  return transitions.find((t) => /done|closed|resolved/i.test(t.to?.name ?? ''));
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const types = await issueTypeIds();
  const plan = RECIPE.flatMap((group) =>
    group.summaries.map((summary, i) => ({ ...group, summary, estimateHours: group.estimates[i] ?? 4 })),
  );

  console.log(`Creating ${plan.length} completed issues in ${PROJECT} on ${BASE}`);
  console.log(`  ${RECIPE.map((g) => `${g.label}: ~${g.overrun}x over`.padEnd(28)).join('')}\n`);

  let created = 0;
  for (const item of plan) {
    const typeId = types.get(item.type.toLowerCase()) ?? types.get('task') ?? [...types.values()][0];
    const issue = await api('/issue', {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          project: { key: PROJECT },
          issuetype: { id: String(typeId) },
          summary: `[${item.label}] ${item.summary}`,
          labels: [item.label, 'estimate-guard-demo'],
          timeoriginalestimate: Math.round(item.estimateHours * 3600),
        },
      }),
    });

    // Log the reality, deliberately different from the plan.
    await api(`/issue/${issue.key}/worklog`, {
      method: 'POST',
      body: JSON.stringify({
        timeSpentSeconds: Math.round(item.estimateHours * item.overrun * 3600),
        comment: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Demo work log' }] }] },
      }),
    });

    const transition = await findDoneTransition(issue.key);
    if (!transition) {
      console.warn(`${issue.key}: no Done transition found, leaving it open. The app needs completed work.`);
      continue;
    }
    await api(`/issue/${issue.key}/transitions`, { method: 'POST', body: JSON.stringify({ transition: { id: transition.id } }) });

    created += 1;
    console.log(`${issue.key.padEnd(10)} ${String(item.estimateHours).padStart(2)}h planned -> ${(item.estimateHours * item.overrun).toFixed(1)}h logged (${item.overrun}x)`);
    await sleep(400); // stay well clear of Jira rate limits
  }

  console.log(`\nDone. ${created} issues settled.`);
  console.log(`Now open a NEW issue in ${PROJECT} with label "backend" and an estimate of 4h -`);
  console.log('the panel should tell you to plan 9-13h and name the tickets that prove it.');
  console.log(`(Delete the demo data later with: https://${SITE}/jira/searchjql?jql=label%3Destimate-guard-demo)`);
}

main().catch((err) => {
  console.error(`\nSeed failed: ${err.message}`);
  process.exit(1);
});
