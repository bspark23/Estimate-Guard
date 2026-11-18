# Estimate Guard for Jira

**Everyone's AI guesses your estimate. Nothing checks whether the guess was right.**

Estimate Guard turns every ticket your team closes into a calibration record, warns you at
the moment you type the number, and then publishes a scorecard proving how often its own
warnings were correct.

Forge app for Codegeist 2026 - category **Apps for Software Teams**, bonus prizes **Best
Agents (Rovo)** and **Best app with Atlassian MCP**.

---

## The loop

Five beats, one closed circle. Nothing in the Marketplace closes it.

**1. Predict** - Open any ticket and the panel reads your own completed work, picks the
closest matches by label, issue type and wording, and says: *"Plan 9-13h. 4h has never
worked here."* It then names its evidence: `ENG-123 Payment retry endpoint - estimated 4h,
logged 11h (2.8x)`. Clickable. Verifiable. Not a vibe.

**2. Guard** - The warning is allowed to have teeth. Add the `jira:workflowValidator` to a
"start work" transition and dragging that ticket to In Progress is refused:

> Estimate Guard: 4h is below what this work really costs here. 11 finished tickets like it
> (ENG-123, ENG-141, ENG-150) ran 2.6x their estimate. Raise the estimate to at least 10.5h
> (one click in the Estimate Guard panel), or add the label "estimate-override" to start
> anyway - the override is graded when the ticket is done.

Panel and gate call the same `assess()` and the same `gateDecision()`, so they can never
disagree about what the evidence says - the gate just has teeth. Four things it will not do:
block on calendar-elapsed evidence (directional, not proof), block below the sample floor,
block once the estimate has been raised to meet the evidence, or block a ticket an explicit
`estimate-override` label was put on. Judging the estimate the team *first* gave, rather than
whatever is in the field now, is what stops the ratchet: raise 4h to 10.5h and it says
"confirmed", not "and now 10.5h isn't enough either". An override is not a silence - the receipt at Done carries `overridden: true`, so the team can
see which warnings were waved away. The scorecard grades each override on its own: "overridden,
we were right" or "overridden, team was right".

It fails open on any error - a bug in our app must never lock a team out of their own board.
And it only exists on transitions an admin chose, so installing Estimate Guard cannot break
anything.

**3. Decide** - One button writes the recount back to the ticket's original estimate. The
warning is allowed to change the plan, which is what the brief means by "a decision that
actually moves work forward" - and the recount is what unlocks the gate above.

**4. Settle** - A Forge trigger fires the moment an issue reaches Done and writes an
immutable **estimate receipt**: planned vs delivered, which evidence it used, and whether
we had warned. It posts the receipt onto the ticket, so the team sees reality in the
feed, not just on a dashboard.

**5. Score** - The receipts grade the warnings. *"We warned on 18 tickets; 15 overran.
83% precision, 4 silent overruns missed, 214h of work nobody planned for."* That number is
why you should trust the panel on ticket 19.

## What you install

| Module | Role |
| --- | --- |
| `jira:issuePanel` | Predict + the Recount button |
| `jira:workflowValidator` | Guard: refuses to start work on an estimate the team's own logs refute |
| `jira:projectPage` | Bias map, unplanned-hours headline, graded receipts |
| `trigger` (`avi:jira:updated:issue`) | Settle: writes and posts the receipt |
| `rovo:agent` "Estimate Coach" | Asks the same two questions in natural language |
| `action` x2 | `predict-effort`, `accuracy-scorecard` - shared by panel, agent and MCP |
| `rovo:mcp` | The same two actions exposed as an MCP server |

No external LLM, no paid APIs, no Forge LLM calls. Panel and trigger logic is
deterministic; only the agent is generative, and its prompt forbids inventing numbers.

## Why it is not another estimator

Every incumbent ([AI Estimator](https://marketplace.atlassian.com/apps/1017505204/ai-estimator),
[Intelligent Story Point Estimation](https://marketplace.atlassian.com/apps/1234430/intelligent-story-point-estimation),
[SprintPoker](https://marketplace.atlassian.com/apps/1143291390/sprintpoker-planning-poker-async-estimation),
[Estimate Accuracy Gadget](https://marketplace.atlassian.com/apps/1217982/estimate-accuracy-gadget-for-jira-cloud))
either produces a number or shows a historical ratio. Both stop there. Estimate Guard is the
only one that (a) acts at the moment of estimating, (b) can refuse to let that number start
work, (c) records what actually happened, and (d) is accountable for its own accuracy over
time. An advisor you can ignore is not a guard.

Two deliberate design choices:

- **Bias attaches to areas of work, never to people.** The scorecard cuts by label and issue
  type. Per-person accuracy is a surveillance feature that gets apps uninstalled; per-area
  accuracy is a planning input.
- **It works on projects that don't log time.** Three evidence tiers, best available wins:

  | Tier | Signal | Confidence |
  | --- | --- | --- |
  | `time` | logged work vs original estimate | exact |
  | `clock` | creation-to-done calendar vs estimate | directional, capped at 6x, labelled as such |
  | `elapsed` | peers' close time only | a days band, no hours claimed |

  The naive version of this app filters JQL on `originalEstimate is not EMPTY AND timeSpent
  is not EMPTY` and shows an empty table to most of the world. Estimate Guard never does.

## Technical notes

- `src/lib/evidence.js` - pure engine: comparability scoring, three-tier outcomes, drift
  medians, bias matrix, warning scorecard. No Forge imports, so it is unit-tested.
- `src/lib/store.js` - Key-Value Store (`@forge/kvs`). Keys use `:` separators because Forge
  rejects `/` in keys at runtime. The history cache is keyed **per account**
  (`hist:<project>:<accountId>`) because Jira search results are permission-filtered; a
  shared project cache would leak issues a user may not see.
- `src/lib/store.js` - `pred:<issueKey>` snapshots the warning *before* anyone can argue
  about it; `adj:<issueKey>` remembers an accepted recount.
- `src/index.js` - `onIssueUpdated` grades against **`baselineHours`, the estimate as it was
  when we warned**. Grading a recounted ticket against its new estimate would make every
  successful warning look like a false alarm - the observer effect that quietly breaks most
  feedback-loop apps.
- All user/LLM-supplied values are regex-validated or JQL-quoted before reaching Jira.
  Panels run `api.asUser()`; only the receipt comment uses `api.asApp()` (a webhook has no
  interactive session, and a refused comment must never cost us the receipt).
- 26 unit tests: `npm test`.

## Install (about 3 minutes)

```bash
npm install -g @forge/cli@latest   # 15.x; 14.x also builds this app
cd estimate-guard
npm install
forge login
forge register                     # writes your own app id into manifest.yml
forge deploy
forge install --product jira --site yourname.atlassian.net
```

Then seed a project so there is history to learn from:

```bash
JIRA_SITE=acme.atlassian.net JIRA_EMAIL=you@example.com \
JIRA_API_TOKEN=*** from id.atlassian.com> node scripts/seed-demo-data.mjs
```

It creates 11 completed issues in which `backend` runs ~2.6x over and `frontend` runs ~1.0x,
so the bias map and the panel both have something to say immediately. Every seeded issue is
labelled `estimate-guard-demo` for easy cleanup. The script takes credentials from the
environment only - never commit or screen-record a token.

## Using it

1. Open a ticket labelled `backend`, estimate 4h -> panel goes red and cites three tickets.
2. Press **Recount to 11h** -> the original estimate changes on the issue.
3. *(Optional, one admin click)* Add **Estimate Guard - estimate is evidence-backed** to the
   To Do -> In Progress transition. An unrecounted 4h ticket can no longer start work.
4. Move a ticket to **Done** -> a receipt comment appears, and the scorecard counts it.
5. Project sidebar -> **Estimate Guard** -> unplanned hours, precision, bias map.
6. Rovo Chat -> **Estimate Coach** -> *"What will a backend ticket really take?"*

To try step 3 on a company-managed project: **Project settings > Workflows > edit the
workflow > select the transition > Validators > Add validator > Estimate Guard**. Publish
the workflow draft; the validator then appears in the transition list with its own name.

## Bonus prize claims

- **Best Agents (Rovo)** - `rovo:agent` module "Estimate Coach" plus two reusable
  `action` modules (`predict-effort`, `accuracy-scorecard`) that other agents can invoke as
  tools. The prompt constrains it to citing the exemplar keys it was given.
- **Best app with Atlassian MCP** - `rovo:mcp` module `estimate-guard-mcp` exposing those
  same two actions as MCP tools. *Judge note: tools work in Rovo Studio immediately; external
  MCP exposure is off by default and is toggled in Atlassian Administration > Apps > Connected
  apps. If your sandbox has it disabled, the Rovo Studio view demonstrates the same module.*

## Known limits (honest list)

- `clock` evidence cannot separate work from waiting, so it caps the ratio at 6x and is
  always labelled directional. It never appears as a hard "you overran by Nx" claim.
- Receipts only grade tickets that had *some* estimate. Unestimated work is counted as
  "no baseline" rather than silently scored.
- History window is 365 days and at most 400 issues per project per page set; the bias map
  reflects that window, and the page says so.
- Teamwork Graph is **not** in this build. Reading the graph needs per-object scopes plus
  org-admin consent, and writing into it needs a `graph:connector` an admin must configure -
  both would break a 3-minute judge install. The receipts are deliberately stored as small
  flat objects so a connector is a follow-up, not a rewrite.
- `rovo:mcp` is Preview. If your site rejects it, delete that one manifest block; nothing
  else depends on it.
- Rovo itself ships with Jira **Standard, Premium and Enterprise**, not Free. On a Free
  sandbox the agent and MCP modules install but the chat is unavailable; the `action`
  modules they call are ordinary Forge functions and still run. Deleting `rovo:agent` and
  `rovo:mcp` leaves the panel, gate, trigger and scorecard untouched.
- `jira:workflowValidator` is a Preview module and company-managed projects are its default;
  `projectTypes` here opts team-managed in as well. It guards only the transitions an admin
  adds it to, re-reads the ticket through the same `assess()` the panel uses, and fails open on
  any error, so a broken deploy cannot freeze a board. That live read costs one Jira call at
  transition time, which is the price of guarding tickets nobody ever opened.

## Demo video script (target 3:45)

| Time | Shot | Line |
| --- | --- | --- |
| 0:00 | Empty board, someone typing "4h" | "Every team has a number they make up on a Tuesday." |
| 0:15 | Panel turns red, cites ENG-123 | "Estimate Guard refuses the number and shows you the three tickets that prove it." |
| 0:40 | Drag that ticket to In Progress - **refused**, the message names the tickets | "And this is the part no estimation app does. The board says no." |
| 1:05 | Open the panel, click Recount, drag again - it moves | "It doesn't just nag. One click changes the plan, and the gate opens itself." |
| 1:35 | Run `seed-demo-data`, an issue hits Done, receipt comment lands | "When the work is finished, it books the result." |
| 2:00 | Project page: 214h, 83% | "This is the part nobody ships: the app grading itself. 214 hours of work nobody planned for, and 83% of our warnings were right." |
| 2:30 | Bias map | "The red row is backend. Not a person - an area. That is why a team keeps this installed." |
| 2:50 | Rovo Chat, ask "what will a db-migration bug really take?" | "Same tools, conversational." |
| 3:15 | MCP tools list in Rovo Studio | "Same tools, exposed over MCP - so any agent in the company can ask before it plans." |
| 3:35 | Card | "Estimate Guard. Ship with the numbers you actually earned." |
