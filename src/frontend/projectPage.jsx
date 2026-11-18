import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Box, DynamicTable, Heading, Inline, Link, Lozenge, SectionMessage, Spinner, Stack, Text, xcss } from '@forge/react';
import { invoke } from '@forge/bridge';

// Red = broken (>= 1.5x), yellow = optimistic, green = accurate.
const driftAppearance = (ratio) => (ratio >= 1.5 ? 'removed' : ratio >= 1.35 ? 'moved' : ratio > 0 && ratio < 1.2 ? 'success' : 'default');
const Drift = ({ ratio }) => (ratio ? <Lozenge appearance={driftAppearance(ratio)}>{`${ratio}x`}</Lozenge> : <Text>-</Text>);

const card = xcss({ padding: 'space.200', borderColor: 'color.border', borderWidth: 'border.width', borderStyle: 'solid', borderRadius: 'border.radius', minWidth: '180px' });

const Stat = ({ label, value, hint }) => (
  <Box xcss={card}>
    <Stack space="space.050">
      <Heading size="large">{value}</Heading>
      <Text weight="semibold">{label}</Text>
      {hint && <Text size="small" color="color.text.subtlest">{hint}</Text>}
    </Stack>
  </Box>
);

const IssueLink = ({ issueKey, url }) => (url ? <Link href={url} openNewTab>{issueKey}</Link> : <Text>{issueKey}</Text>);

// How the grade of a past warning is shown in the receipts table.
const callOf = (r, threshold) => {
  const overran = r.actualRatio >= threshold;
  // The team overrode us: whoever turned out right gets the credit.
  if (r.overridden) return overran ? ['success', 'overridden, we were right'] : ['moved', 'overridden, team was right'];
  if (r.warned) return overran ? ['success', 'warned, right'] : ['moved', 'warned, false alarm'];
  if (!r.checked) return overran ? ['removed', 'overran, not checked'] : ['default', 'not checked'];
  return overran ? ['removed', 'missed'] : ['default', 'quiet, fine'];
};

const App = () => {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    invoke('getProjectScorecard').then(setData).catch((e) => setError(e.message || String(e)));
  }, []);

  if (error) return <SectionMessage appearance="error" title="Could not load the scorecard"><Text>{error}</Text></SectionMessage>;
  if (!data) return <Spinner label="Grading this project" />;

  const { overall, grading } = data;

  // Spec table: per label / issue type, average estimate, average actual, drift. Worst first.
  const accuracyRows = data.rows.map((r) => ({
    key: `${r.kind}-${r.name}`,
    cells: [
      { key: 'name', content: r.name },
      { key: 'kind', content: r.kind },
      { key: 'n', content: String(r.sampleSize) },
      { key: 'est', content: `${r.avgEstimateHours}h` },
      { key: 'act', content: `${r.avgActualHours}h` },
      { key: 'drift', content: <Drift ratio={r.driftRatio} /> },
    ],
  }));

  const receiptRows = data.recent.map((r) => {
    const [appearance, text] = callOf(r, data.threshold);
    return {
      key: r.key,
      cells: [
        { key: 'key', content: <IssueLink issueKey={r.key} url={r.url} /> },
        { key: 'summary', content: r.summary },
        { key: 'planned', content: `${r.baselineHours}h` },
        { key: 'actual', content: `${r.actualHours}h` },
        { key: 'ratio', content: <Drift ratio={r.actualRatio} /> },
        { key: 'call', content: <Lozenge appearance={appearance}>{text}</Lozenge> },
      ],
    };
  });

  return (
    <Stack space="space.300">
      <Stack space="space.050">
        <Heading size="large">Estimation Accuracy</Heading>
        <Text color="color.text.subtlest">
          {`Plan vs. reality across ${data.analysed} completed issues in ${data.projectKey} (last ${data.lookbackDays} days). ` +
            `${overall.timeBasis} measured from logged work, ${overall.clockBasis} from calendar time.`}
        </Text>
      </Stack>

      <Inline space="space.200" shouldWrap>
        <Stat label="Unplanned work" value={`${grading.unplannedHours ?? 0}h`} hint="delivered beyond the estimate" />
        <Stat
          label="Warnings that were right"
          value={grading.precisionPct === null ? 'n/a' : `${grading.precisionPct}%`}
          hint={grading.warned ? `${grading.warnedAndRight} of ${grading.warned} warned tickets overran` : 'no warnings graded yet'}
        />
        <Stat label="Median drift" value={`${overall.medianDrift || 0}x`} hint={`problem above ${data.threshold}x`} />
        <Stat label="Silent overruns" value={grading.missedPct === null ? 'n/a' : `${grading.missedPct}%`} hint="overran with no warning" />
      </Inline>

      <Stack space="space.100">
        <Heading size="medium">Where we underestimate</Heading>
        <DynamicTable
          head={{
            cells: [
              { key: 'name', content: 'Label / issue type' },
              { key: 'kind', content: 'Grouped by' },
              { key: 'n', content: 'Issues' },
              { key: 'est', content: 'Avg estimate' },
              { key: 'act', content: 'Avg actual' },
              { key: 'drift', content: 'Drift (actual / estimate)' },
            ],
          }}
          rows={accuracyRows}
          emptyView="No completed issue has an original estimate yet. Estimate and close a few tickets and this fills in."
        />
      </Stack>

      <Stack space="space.100">
        <Heading size="medium">Receipts: were our warnings right?</Heading>
        <Text color="color.text.subtlest">Written automatically when a ticket reaches Done, and graded against what Estimate Guard said beforehand.</Text>
        <DynamicTable
          head={{
            cells: [
              { key: 'key', content: 'Issue' },
              { key: 'summary', content: 'Summary' },
              { key: 'planned', content: 'Planned' },
              { key: 'actual', content: 'Actual' },
              { key: 'ratio', content: 'Drift' },
              { key: 'call', content: 'Our call' },
            ],
          }}
          rows={receiptRows}
          emptyView="Nothing graded yet. Open a ticket's Estimate Guard panel, then move it to Done."
        />
      </Stack>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
