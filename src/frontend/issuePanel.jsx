import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Button, Heading, Link, SectionMessage, Spinner, Stack, Text } from '@forge/react';
import { invoke, view } from '@forge/bridge';

const APPEARANCE = {
  severe: 'error',
  optimistic: 'warning',
  trustworthy: 'success',
  ok: 'information',
  unknown: 'information',
};

const mid = (low, high) => Math.round(((low + high) / 2) * 2) / 2;

const headline = (d) => {
  if (d.verdict === 'severe') {
    return `Plan ${d.suggestedLowHours}-${d.suggestedHighHours}h. ${d.estimateHours}h has never worked here.`;
  }
  if (d.verdict === 'optimistic') {
    return `${d.estimateHours}h is tight. Comparable work landed nearer ${d.suggestedHighHours}h.`;
  }
  if (d.verdict === 'trustworthy') {
    return `${d.estimateHours}h looks right. Work like this runs ${d.medianRatio}x its estimate.`;
  }
  if (d.mode === 'suggest') {
    return d.basis === 'elapsed'
      ? `Nothing estimated yet. Tickets like this close in ${d.elapsedDaysLow}-${d.elapsedDaysHigh} days.`
      : `Comparable tickets cost ${d.suggestedLowHours}-${d.suggestedHighHours}h.`;
  }
  return `Work like this runs ${d.medianRatio}x its estimate.`;
};

const Exemplar = ({ issue }) => (
  <Stack space="space.025">
    <Text>
      {issue.url ? <Link href={issue.url} openNewTab>{issue.key}</Link> : issue.key}
      {` ${issue.summary}`}
    </Text>
    <Text size="small" color="color.text.subtlest">
      {issue.basis === 'time'
        ? `estimated ${issue.estimateHours}h, logged ${issue.actualHours}h (${issue.ratio}x)`
        : `estimated ${issue.estimateHours}h, closed after ${issue.elapsedDays} days`}
    </Text>
  </Stack>
);

const App = () => {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(null);

  const load = () => invoke('getIssuePrediction').then(setData).catch((e) => setError(e.message || String(e)));
  useEffect(() => {
    load();
  }, []);

  const recount = async () => {
    setBusy(true);
    try {
      const target = mid(data.suggestedLowHours, data.suggestedHighHours);
      await invoke('applyRecount', { hours: target });
      setApplied(target);
      await load();
      // Ask Jira to reload the issue so the Original estimate field shows the new value.
      view.refresh().catch(() => {});
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return <SectionMessage appearance="error" title="Estimate Guard could not read this project"><Text>{error}</Text></SectionMessage>;
  }
  if (!data) return <Spinner label="Reading your completed work" />;

  if (data.verdict === 'unknown' && data.mode !== 'suggest') {
    return (
      <SectionMessage appearance="information" title="Not enough history yet">
        <Stack space="space.050">
          <Text>{`Only ${data.sampleSize} completed ticket(s) match ${data.evidence}. Estimate Guard needs a few finished issues before it will give an opinion.`}</Text>
          {data.exemplars?.length > 0 && <Text color="color.text.subtlest">{`Closest so far: ${data.exemplars.map((e) => e.key).join(', ')}`}</Text>}
        </Stack>
      </SectionMessage>
    );
  }

  // Recount already applied: confirm it, keep the evidence, offer no further button.
  if (data.recounted) {
    return (
      <SectionMessage appearance="success" title={`Estimate updated from ${data.recounted.fromHours}h to ${data.recounted.toHours}h`}>
        <Stack space="space.050">
          <Text>{`${data.recounted.fromHours}h would have run about ${data.medianRatio}x over, like ${data.sampleSize} similar finished tickets. ${data.recounted.toHours}h is in line with what this work really costs.`}</Text>
          {data.exemplars?.length > 0 && (
            <Stack space="space.025">
              <Heading size="small">Based on</Heading>
              {data.exemplars.map((issue) => <Exemplar key={issue.key} issue={issue} />)}
            </Stack>
          )}
        </Stack>
      </SectionMessage>
    );
  }

  const actionable = data.mode === 'recount' && (data.verdict === 'severe' || data.verdict === 'optimistic');
  const suggestable = data.mode === 'suggest' && data.basis === 'time';

  return (
    <SectionMessage appearance={APPEARANCE[data.verdict] ?? 'information'} title={headline(data)}>
      <Stack space="space.050">
        <Text size="small" color="color.text.subtlest">
          {`From ${data.sampleSize} completed issues matched on ${data.evidence}${data.medianRatio ? `, median ${data.medianRatio}x planned` : ''}.`}
        </Text>
        {data.soft && (
          <Text size="small" color="color.text.subtlest">
            Directional: this project logs no work, so this is calendar time from creation to done, not effort.
          </Text>
        )}
        {data.unplannedHours > 0 && (
          <Text size="small">{`Unplanned work at stake: about ${data.unplannedHours}h.`}</Text>
        )}
        {data.verdict === 'severe' && data.basis === 'time' && (
          <Text size="small">
            This is the one verdict strong enough to stop work: while it stands, an Estimate Guard
            validator on the start transition will refuse to move this ticket into progress.
          </Text>
        )}
        {applied && <Text>{`Original estimate set to ${applied}h.`}</Text>}
        {data.gate?.state === 'blocked' && (
          <Text weight="bold">
            {`Start is blocked until the estimate is at least ${data.gate.floorHours}h (now ${data.currentHours}h), or the ticket carries the label "${data.overrideLabel}".`}
          </Text>
        )}
        {data.gate?.state === 'overridden' && (
          <Text weight="bold">{`Overridden with "${data.overrideLabel}": work can start. This call is graded when the ticket is done.`}</Text>
        )}

        {data.exemplars?.length > 0 && (
          <Stack space="space.025">
            <Heading size="small">Why we say so</Heading>
            {data.exemplars.map((issue) => <Exemplar key={issue.key} issue={issue} />)}
          </Stack>
        )}

        {(actionable || suggestable) && (
          <Button isLoading={busy} onClick={recount}>
            {`Recount to ${mid(data.suggestedLowHours, data.suggestedHighHours)}h`}
          </Button>
        )}
      </Stack>
    </SectionMessage>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
