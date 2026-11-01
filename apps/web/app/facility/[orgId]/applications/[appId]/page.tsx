'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  Alert, ApplicationStatusBadge, Button, Card, ConfirmButton, CredentialStatusBadge, DataTable, DefinitionList, EligibilityPanel, ErrorAlert, PageHeader, QueryBoundary, RankingBreakdown,
  TextField, Timeline, formatDate, formatDateTime, titleCase, useAction, useApi, useClient, type EligibilityData, type RankingData,
} from '@bsm/ui';
import { RatingText, type RatingSummary } from '@/components/Reviews';
import { useOrg } from '@/lib/org';
import { ApplicationShiftOffers } from '../shift-sections';

interface Detail {
  application: { id: string; status: string; cover_note: string | null; created_at: string; job_id: string; job_title: string; full_name: string; headline: string | null; summary: string | null; city: string | null; state: string | null; profession: string; submitted_by_agency?: string | null; source?: string };
  applicant: {
    specialties: string[]; experience: { employer: string; title: string; start_date: string; end_date: string | null; is_current: boolean }[];
    education: { institution: string; degree: string; field_of_study: string | null }[];
    credentials: { kind: string; credential_type: string; jurisdiction: string | null; expiration_date: string | null; effective_status: string; verification_method: string | null; status_label: string }[];
  };
  selectedShifts: { id: string; starts_at: string; ends_at: string }[];
  eligibility: EligibilityData & { rulesVersion: string };
  ranking: RankingData | null;
  track: { reliability: { completedShifts: number; noShows: number; cancellations: number; lateCancellations: number; completionRate: number | null; sampleSize: number }; rating: RatingSummary };
  history: { actor_kind: string; from_status: string | null; to_status: string; reason: string | null; created_at: string }[];
}

const NEXT: Record<string, { to: string; label: string; needsReason?: boolean }[]> = {
  submitted: [{ to: 'under_review', label: 'Start review' }, { to: 'shortlisted', label: 'Shortlist' }, { to: 'rejected', label: 'Reject', needsReason: true }],
  under_review: [{ to: 'shortlisted', label: 'Shortlist' }, { to: 'interview_requested', label: 'Request interview' }, { to: 'rejected', label: 'Reject', needsReason: true }],
  shortlisted: [{ to: 'interview_requested', label: 'Request interview' }, { to: 'offer_sent', label: 'Send offer' }, { to: 'rejected', label: 'Reject', needsReason: true }],
  interview_requested: [{ to: 'interviewed', label: 'Mark interviewed' }, { to: 'rejected', label: 'Reject', needsReason: true }],
  interviewed: [{ to: 'offer_sent', label: 'Send offer' }, { to: 'rejected', label: 'Reject', needsReason: true }],
  offer_sent: [{ to: 'cancelled', label: 'Withdraw offer', needsReason: true }],
};

function Actions({ d, orgId, reload, canManage }: { d: Detail; orgId: string; reload: () => Promise<void>; canManage: boolean }) {
  const client = useClient();
  const [reason, setReason] = useState('');
  const move = useAction(async (to: string) => { await client.post(`/organizations/${orgId}/applications/${d.application.id}/status`, { to, reason: reason || undefined }); setReason(''); await reload(); });
  const options = NEXT[d.application.status] ?? [];
  const eligible = d.eligibility.outcome === 'eligible';
  const blocked = move.error?.details?.reasons;
  if (!canManage) return <Alert tone="info">Your role can view applications but not change their status.</Alert>;
  if (options.length === 0) return <p className="muted">No further actions: this application is {titleCase(d.application.status).toLowerCase()}.</p>;
  return (
    <div className="stack">
      {blocked && <Alert tone="warning" title="Blocked">{move.error?.message}<EligibilityPanel eligibility={{ outcome: move.error!.details.outcome, reasons: blocked }} heading="Why" /></Alert>}
      {move.error && !blocked && <ErrorAlert error={move.error} />}
      {options.some((o) => o.needsReason) && <TextField label="Message to the applicant (needed to reject or withdraw an offer)" name="reason" value={reason} onChange={setReason} maxLength={2000} hint="The applicant will see this message." />}
      <div className="row">
        {options.map((o) => {
          if (o.to === 'offer_sent' && !eligible) return <Button key={o.to} tone="secondary" disabled aria-describedby="offer-blocked">{o.label}</Button>;
          if (o.needsReason) return reason.trim().length < 3 ? <Button key={o.to} tone="secondary" disabled>{o.label}</Button> : <ConfirmButton key={o.to} label={o.label} message={`${o.label}? The applicant will be notified.`} pending={move.pending} onConfirm={() => move.run(o.to)} />;
          if (o.to === 'offer_sent') return <ConfirmButton key={o.to} tone="primary" label={o.label} message="Send an offer to this applicant? Their eligibility is checked again at this moment. Terms are agreed directly between you and the professional." pending={move.pending} onConfirm={() => move.run(o.to)} />;
          return <Button key={o.to} pending={move.pending} onClick={() => void move.run(o.to)}>{o.label}</Button>;
        })}
      </div>
      {options.some((o) => o.to === 'offer_sent') && !eligible && <p id="offer-blocked" className="small">An offer can only be sent when the applicant is <strong>eligible</strong>. See the reasons below.</p>}
    </div>
  );
}

export default function ApplicationDetailPage() {
  const { org, can } = useOrg();
  const { appId } = useParams<{ appId: string }>();
  const state = useApi<Detail>(`/organizations/${org.id}/applications/${appId}`);
  return (
    <>
      <p><Link href={`/facility/${org.id}/applications`}>← Applications</Link></p>
      <QueryBoundary state={state}>
        {(d) => (
          <>
            <PageHeader title={d.application.full_name} subtitle={<>{d.application.profession} · applied to <Link href={`/facility/${org.id}/jobs/${d.application.job_id}/candidates`}>{d.application.job_title}</Link> · <ApplicationStatusBadge status={d.application.status} />{d.application.submitted_by_agency && <> · submitted by {d.application.submitted_by_agency}</>}{d.application.source === 'float_pool' && <> · booked through the regional float pool</>}</>} />
            <Card title="Actions"><Actions d={d} orgId={org.id} reload={state.reload} canManage={can('applications.manage')} /></Card>
            <ApplicationShiftOffers orgId={org.id} applicationId={d.application.id} shifts={d.selectedShifts} canManage={can('applications.manage')} />
            <Card title="Eligibility"><EligibilityPanel eligibility={d.eligibility} /><p className="small muted">Rules version {d.eligibility.rulesVersion}. Credentials show their status; numbers and documents are never shown to facilities.</p></Card>
            <Card title="Work record on BSM">
              <p className="muted">Context for you to weigh. It is not part of the eligibility check and does not change the ranking.</p>
              <DefinitionList items={[
                ['Completed shifts', d.track.reliability.completedShifts], ['No-shows', d.track.reliability.noShows],
                ['Cancellations by the professional', `${d.track.reliability.cancellations} (${d.track.reliability.lateCancellations} within 48 hours of the start)`],
                ['Completion rate', d.track.reliability.completionRate === null ? 'No shifts yet' : `${d.track.reliability.completionRate}% of ${d.track.reliability.sampleSize}`],
                ['Facility ratings', <RatingText key="r" rating={d.track.rating} who="This professional" />],
              ]} />
            </Card>
            <Card title="Ranking">
              {d.ranking ? <RankingBreakdown ranking={d.ranking} /> : <p className="muted">Not ranked: only applicants who are currently eligible are ranked.</p>}
            </Card>
            <Card title="Applicant">
              <DefinitionList items={[
                ['Headline', d.application.headline], ['Location', [d.application.city, d.application.state].filter(Boolean).join(', ') || null], ['Specialties', d.applicant.specialties.join(', ') || null],
                ['Applied', formatDateTime(d.application.created_at)], ['Note from applicant', d.application.cover_note], ['Summary', d.application.summary],
              ]} />
              {d.selectedShifts.length > 0 && <><h3>Shifts they selected</h3><ul>{d.selectedShifts.map((s) => <li key={s.id}>{formatDateTime(s.starts_at)} – {formatDateTime(s.ends_at)}</li>)}</ul></>}
            </Card>
            <Card title="Licenses & certifications">
              <DataTable caption="Applicant credentials" rows={d.applicant.credentials} rowKey={(c) => `${c.credential_type}-${c.jurisdiction}-${c.kind}`} empty={<p className="muted">No credentials on file.</p>}
                columns={[
                  { header: 'Credential', cell: (c) => `${c.credential_type}${c.jurisdiction ? ` (${c.jurisdiction})` : ''}` }, { header: 'Kind', cell: (c) => titleCase(c.kind) },
                  { header: 'Expires', cell: (c) => formatDate(c.expiration_date) },
                  { header: 'Status', cell: (c) => <CredentialStatusBadge status={c.effective_status} method={c.verification_method} label={c.status_label} /> },
                ]} />
            </Card>
            <Card title="Experience & education">
              <ul>{d.applicant.experience.map((e, i) => <li key={i}><strong>{e.title}</strong>, {e.employer} · {formatDate(e.start_date)} – {e.is_current ? 'present' : formatDate(e.end_date)}</li>)}</ul>
              <ul>{d.applicant.education.map((e, i) => <li key={i}>{e.degree}{e.field_of_study ? `, ${e.field_of_study}` : ''} — {e.institution}</li>)}</ul>
              <p className="small muted">Work history is self-reported by the applicant and has not been verified by BSM.</p>
            </Card>
            <Card title="History"><Timeline items={d.history.map((h, i) => ({ key: String(i), at: h.created_at, title: `${h.actor_kind === 'professional' ? 'Applicant' : 'Your team'}: ${h.from_status ? `${titleCase(h.from_status)} → ` : ''}${titleCase(h.to_status)}`, detail: h.reason ?? undefined }))} /></Card>
          </>
        )}
      </QueryBoundary>
    </>
  );
}
