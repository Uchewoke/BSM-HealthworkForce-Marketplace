'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Alert, ApplicationStatusBadge, Card, ConfirmButton, DefinitionList, EligibilityPanel, ErrorAlert, PageHeader, QueryBoundary, Timeline, formatDateTime, titleCase, useAction, useApi, useClient, type EligibilityData } from '@bsm/ui';

interface Detail {
  application: { id: string; status: string; cover_note: string | null; created_at: string; job_id: string; title: string; employment_type: string; organization_name: string };
  eligibility: EligibilityData;
  history: { actor_kind: string; from_status: string | null; to_status: string; reason: string | null; created_at: string }[];
}
const WITHDRAWABLE = ['submitted', 'under_review', 'shortlisted', 'interview_requested', 'interviewed'];

function Body({ d, reload, id }: { d: Detail; reload: () => Promise<void>; id: string }) {
  const client = useClient();
  const act = useAction(async (to: 'withdrawn' | 'accepted' | 'declined') => { await client.post(`/professionals/me/applications/${id}/status`, { to }); await reload(); });
  const a = d.application;
  const blocked = act.error?.details?.reasons;
  return (
    <>
      <PageHeader title={a.title} subtitle={<>{a.organization_name} · <ApplicationStatusBadge status={a.status} /></>} />
      {a.status === 'offer_sent' && (
        <Alert tone="info" title="You have an offer">
          Accepting records your acceptance on the platform. Any pay, schedule and employment terms are agreed directly between you and the facility; BSM does not create an employment relationship.
          <div className="row" style={{ marginTop: 8 }}>
            <ConfirmButton tone="primary" label="Accept offer" message="Accept this offer? Your credentials are checked again at this moment." pending={act.pending} onConfirm={() => act.run('accepted')} />
            <ConfirmButton label="Decline offer" message="Decline this offer?" pending={act.pending} onConfirm={() => act.run('declined')} />
          </div>
        </Alert>
      )}
      {act.error && !blocked && <ErrorAlert error={act.error} />}
      {blocked && <Alert tone="warning" title="This step is blocked">{act.error?.message}<EligibilityPanel eligibility={{ outcome: act.error!.details.outcome, reasons: blocked }} heading="Why" /></Alert>}
      <Card title="Where you stand"><EligibilityPanel eligibility={d.eligibility} heading="Eligibility for this job" /></Card>
      <Card title="Details">
        <DefinitionList items={[['Type', titleCase(a.employment_type)], ['Applied', formatDateTime(a.created_at)], ['Your note', a.cover_note]]} />
        <p><Link href={`/professional/jobs/${a.job_id}`}>View the job</Link></p>
      </Card>
      <Card title="History">
        <Timeline items={d.history.map((h, i) => ({ key: String(i), at: h.created_at, title: `${h.actor_kind === 'professional' ? 'You' : 'Facility'}: ${h.from_status ? `${titleCase(h.from_status)} → ` : ''}${titleCase(h.to_status)}`, detail: h.reason ?? undefined }))} />
      </Card>
      {WITHDRAWABLE.includes(a.status) && (
        <Card title="Withdraw"><ConfirmButton label="Withdraw application" message="Withdraw this application? The facility will be notified." pending={act.pending} onConfirm={() => act.run('withdrawn')} /></Card>
      )}
    </>
  );
}

export default function ApplicationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<Detail>(`/professionals/me/applications/${id}`);
  return (<><p><Link href="/professional/applications">← My applications</Link></p><QueryBoundary state={state}>{(d) => <Body d={d} reload={state.reload} id={id} />}</QueryBoundary></>);
}
