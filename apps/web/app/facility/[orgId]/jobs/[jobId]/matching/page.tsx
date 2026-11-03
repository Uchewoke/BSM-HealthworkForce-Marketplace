'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Alert, ApplicationStatusBadge, Badge, Button, Card, DataTable, EligibilityBadge, EmptyState, ErrorAlert, PageHeader, Pagination, QueryBoundary, SelectField, formatDateTime, titleCase, useAction, useApi, useClient } from '@bsm/ui';
import { useOrg } from '@/lib/org';

interface Factor { key: string; label: string; weight: number; value: number | null; contribution: number | null; note: string; withheld?: boolean }
interface Result {
  resultId: string; source: 'applicant' | 'talent'; rank: number | null; score: number | null; factors: Factor[] | null;
  eligibility: { outcome: string; reasons: { code: string; message: string }[] };
  applicationId?: string; applicationStatus?: string; applicant?: { name: string; headline: string | null; city: string | null; state: string | null };
  talentRef?: string; talent?: { profession: string; specialties: string[]; city: string | null; state: string | null; yearsExperience: number | null };
}
interface Run { id: string; scope: string; candidateCount: number; truncated: boolean; rulesVersion: string; rankingVersion: string; weightsVersion: number; createdAt: string }

const SCOPES = [
  { value: 'applicants', label: 'People who applied' },
  { value: 'talent', label: 'Opted-in professionals (anonymous)' },
  { value: 'both', label: 'Both' },
];

function Invite({ orgId, jobId, talentRef }: { orgId: string; jobId: string; talentRef: string }) {
  const client = useClient();
  const [sent, setSent] = useState(false);
  const send = useAction(async () => { await client.post(`/organizations/${orgId}/talent/invitations`, { talentRef, jobId }); setSent(true); });
  if (sent) return <Badge tone="success">Invitation sent</Badge>;
  return <><ErrorAlert error={send.error} /><Button tone="secondary" pending={send.pending} onClick={() => void send.run()}>Invite to apply</Button></>;
}

function Results({ orgId, jobId, runId }: { orgId: string; jobId: string; runId: string }) {
  const [page, setPage] = useState(1);
  const [group, setGroup] = useState<'all' | 'eligible'>('all');
  const state = useApi<{ results: Result[]; total: number; pageSize: number; hiddenSinceRun: number | null; note: string; run: Run }>(`/organizations/${orgId}/match-runs/${runId}`, { group, page, pageSize: 20 });
  return (
    <QueryBoundary state={state}>
      {(d) => (
        <>
          <Alert tone="info">{d.note}</Alert>
          {d.run.truncated && <Alert tone="warning">More candidates existed than a run evaluates. Narrow the job or run again later.</Alert>}
          {!!d.hiddenSinceRun && <Alert tone="info">{d.hiddenSinceRun} professional(s) have opted out since this run and are no longer shown.</Alert>}
          <SelectField label="Show" name="group" value={group} onChange={(v) => { setGroup(v as 'all' | 'eligible'); setPage(1); }} options={[{ value: 'all', label: 'Everyone, with reasons' }, { value: 'eligible', label: 'Eligible only' }]} />
          {d.results.length === 0 ? <EmptyState title="No candidates">Nobody matched this run.</EmptyState> : (
            <>
              <DataTable caption="Match results" rows={d.results} rowKey={(r) => r.resultId}
                columns={[
                  { header: 'Rank', cell: (r) => (r.rank ? <Badge tone="info">#{r.rank} · {r.score?.toFixed(1)}</Badge> : <span className="muted">Not ranked</span>) },
                  { header: 'Candidate', cell: (r) => r.source === 'applicant'
                    ? <><Link href={`/facility/${orgId}/applications/${r.applicationId}`}>{r.applicant!.name}</Link> <ApplicationStatusBadge status={r.applicationStatus!} /><br /><span className="muted small">{[r.applicant!.headline, [r.applicant!.city, r.applicant!.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</span></>
                    : <>{r.talent!.profession} <Badge tone="neutral">Anonymous</Badge><br /><span className="muted small">{[r.talent!.specialties.join(', '), [r.talent!.city, r.talent!.state].filter(Boolean).join(', '), r.talent!.yearsExperience != null ? `${r.talent!.yearsExperience} yrs` : ''].filter(Boolean).join(' · ')}</span></> },
                  { header: 'Eligibility', cell: (r) => (
                    <>
                      <EligibilityBadge outcome={r.eligibility.outcome} />
                      {r.eligibility.reasons.length > 0 && <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 16 }}>{r.eligibility.reasons.map((x, i) => <li key={i}>{x.message}</li>)}</ul>}
                    </>) },
                  { header: 'Why this score', cell: (r) => (r.factors ? (
                    <details><summary>Factors</summary>
                      <ul className="small" style={{ paddingLeft: 16 }}>{r.factors.map((f) => <li key={f.key}><strong>{f.label}</strong> ({f.weight}%): {f.contribution == null ? 'not shown' : f.contribution.toFixed(1)}. {f.note}</li>)}</ul>
                    </details>) : <span className="muted small">Not ranked</span>) },
                  { header: 'Next step', cell: (r) => (r.source === 'talent' && r.eligibility.outcome !== 'ineligible' && r.talentRef ? <Invite orgId={orgId} jobId={jobId} talentRef={r.talentRef} /> : <span className="muted small">{r.source === 'applicant' ? 'Review the application' : '—'}</span>) },
                ]} />
              <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
            </>
          )}
        </>
      )}
    </QueryBoundary>
  );
}

export default function MatchingPage() {
  const { org } = useOrg();
  const { jobId } = useParams<{ jobId: string }>();
  const client = useClient();
  const runs = useApi<{ runs: Run[] }>(`/organizations/${org.id}/jobs/${jobId}/match-runs`);
  const [scope, setScope] = useState('applicants');
  const [selected, setSelected] = useState<string | null>(null);
  const start = useAction(async () => {
    const res = await client.post<{ run: { id: string } }>(`/organizations/${org.id}/jobs/${jobId}/match-runs`, { scope });
    await runs.reload();
    setSelected(res.run.id);
  });
  const active = selected ?? runs.data?.runs[0]?.id ?? null;
  return (
    <>
      <p><Link href={`/facility/${org.id}/jobs/${jobId}`}>← Back to the job</Link></p>
      <PageHeader title="Candidate matching" subtitle="A ranked shortlist for this job, with the reason behind every result." />
      <Alert tone="info">Matching is advisory. Mandatory requirements are checked first and are never overridden by a score; only people who meet them are ranked. Nothing here sends an offer or changes an application: you decide, and eligibility is checked again when someone applies and at every offer and acceptance. This does not verify credentials.</Alert>
      <Card title="Run matching">
        <ErrorAlert error={start.error} />
        <form onSubmit={(e) => { e.preventDefault(); void start.run(); }} noValidate>
          <SelectField label="Who to include" name="scope" value={scope} onChange={setScope} options={SCOPES} />
          <Button type="submit" pending={start.pending}>Run matching</Button>
        </form>
      </Card>
      <QueryBoundary state={runs}>
        {(d) => d.runs.length === 0 ? <EmptyState title="No runs yet">Run matching to see a ranked shortlist.</EmptyState> : (
          <>
            <SelectField label="Run" name="run" value={active ?? ''} onChange={setSelected}
              options={d.runs.map((r) => ({ value: r.id, label: `${formatDateTime(r.createdAt)} · ${titleCase(r.scope)} · ${r.candidateCount} candidates` }))} />
            {active && <Results key={active} orgId={org.id} jobId={jobId} runId={active} />}
          </>
        )}
      </QueryBoundary>
    </>
  );
}
