'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  Alert, Badge, Button, Card, CheckGroup, DataTable, DefinitionList, ErrorAlert, PageHeader, QueryBoundary, SelectField, TextArea,
  centsToDollars, formatDateTime, formatPay, titleCase, useAction, useApi, useClient,
} from '@bsm/ui';
import { useOrg } from '@/lib/org';

interface Detail {
  job: { id: string; title: string; description: string; employment_type: string; pay_min_cents: number | null; pay_max_cents: number | null; min_years_experience: number | null; facility_name: string; city: string; state: string; profession: string; specialty: string | null };
  requirements: { kind: string; credential_type: string | null; jurisdiction: string | null; description: string | null; mandatory: boolean }[];
  shifts: { id: string; starts_at: string; ends_at: string; hourly_rate_cents: number | null }[];
}
interface RosterRow { id: string; status: string; full_name: string; professional_id: string | null }

function SubmitCard({ orgId, d }: { orgId: string; d: Detail }) {
  const client = useClient();
  const roster = useApi<{ roster: RosterRow[] }>(`/organizations/${orgId}/agency/roster`);
  const [professionalId, setProfessionalId] = useState('');
  const [shiftIds, setShiftIds] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<{ outcome: string; reasons: unknown } | null>(null);
  const submit = useAction(async () => {
    const r = await client.post<{ eligibility: { outcome: string; reasons: unknown } }>(`/organizations/${orgId}/agency/jobs/${d.job.id}/submissions`, {
      professionalId, shiftIds: shiftIds.length ? shiftIds : undefined, coverNote: note.trim() || undefined,
    });
    setResult(r.eligibility); setProfessionalId(''); setShiftIds([]); setNote('');
  });
  const refusal = submit.error?.details as { outcome?: string; reasons?: unknown } | undefined;
  return (
    <Card title="Submit a candidate">
      <QueryBoundary state={roster}>
        {(r) => {
          const active = r.roster.filter((m) => m.status === 'active');
          if (active.length === 0) return <Alert tone="info">Only professionals who accepted your roster invitation can be submitted. <Link href={`/agency/${orgId}/roster`}>Go to your roster</Link>.</Alert>;
          return (
            <form onSubmit={(e) => { e.preventDefault(); setResult(null); void submit.run(); }} noValidate>
              {refusal?.outcome ? <Alert tone="warning" title="This candidate cannot be submitted right now"><p>{submit.error?.message}</p><p className="small">Outcome: {titleCase(refusal.outcome)}. The candidate must meet every mandatory requirement before a submission is accepted.</p></Alert> : <ErrorAlert error={submit.error} />}
              {result && <Alert tone="success" title="Submitted">The facility has been notified. Eligibility at submission: {titleCase(result.outcome)}. Track progress under Submissions.</Alert>}
              <SelectField label="Candidate" name="professionalId" required value={professionalId} onChange={setProfessionalId} placeholder="Choose a roster member"
                options={active.map((m) => ({ value: m.professional_id ?? '', label: m.full_name }))} error={submit.error} />
              {d.shifts.length > 0 && d.job.employment_type !== 'permanent' && (
                <CheckGroup legend="Shifts the candidate can work (optional)" value={shiftIds} onChange={setShiftIds}
                  options={d.shifts.map((s) => ({ value: s.id, label: `${formatDateTime(s.starts_at)} – ${formatDateTime(s.ends_at)}${s.hourly_rate_cents ? ` · $${centsToDollars(s.hourly_rate_cents)}/h` : ''}` }))} />
              )}
              <TextArea label="Note to the facility (optional)" name="coverNote" value={note} onChange={setNote} rows={3} maxLength={2000} error={submit.error} />
              <p className="small muted">You are submitting on the candidate’s behalf with their agreement. Their credentials are checked by BSM; you cannot mark anything verified.</p>
              <Button type="submit" pending={submit.pending} disabled={!professionalId}>Submit candidate</Button>
            </form>
          );
        }}
      </QueryBoundary>
    </Card>
  );
}

export default function AgencyJobPage() {
  const { org, can, approved } = useOrg();
  const { jobId } = useParams<{ jobId: string }>();
  const state = useApi<Detail>(`/organizations/${org.id}/agency/jobs/${jobId}`);
  return (
    <>
      <p><Link href={`/agency/${org.id}/jobs`}>← All jobs</Link></p>
      <QueryBoundary state={state}>
        {(d) => (
          <>
            <PageHeader title={d.job.title} subtitle={`${d.job.facility_name} · ${d.job.city}, ${d.job.state}`} />
            <Card title="Details">
              <DefinitionList items={[
                ['Profession', d.job.specialty ? `${d.job.profession} — ${d.job.specialty}` : d.job.profession], ['Type', titleCase(d.job.employment_type)],
                ['Pay', formatPay('hour', d.job.pay_min_cents, d.job.pay_max_cents) || 'Not stated'], ['Minimum experience', d.job.min_years_experience != null ? `${d.job.min_years_experience} years` : 'Not stated'],
              ]} />
              <p style={{ whiteSpace: 'pre-wrap' }}>{d.job.description}</p>
            </Card>
            <Card title="Requirements">
              <DataTable caption="Job requirements" rows={d.requirements} rowKey={(r) => `${r.kind}-${r.credential_type}-${r.jurisdiction}-${r.description}`} empty={<p className="muted">No credential requirements listed.</p>}
                columns={[
                  { header: 'Requirement', cell: (r) => [titleCase(r.kind), r.credential_type, r.jurisdiction, r.description].filter(Boolean).join(' · ') },
                  { header: 'Level', cell: (r) => <Badge tone={r.mandatory ? 'warning' : 'neutral'}>{r.mandatory ? 'Mandatory' : 'Preferred'}</Badge> },
                ]} />
            </Card>
            {d.shifts.length > 0 && (
              <Card title="Open shifts">
                <DataTable caption="Open shifts" rows={d.shifts} rowKey={(s) => s.id}
                  columns={[{ header: 'Starts', cell: (s) => formatDateTime(s.starts_at) }, { header: 'Ends', cell: (s) => formatDateTime(s.ends_at) }, { header: 'Rate', cell: (s) => (s.hourly_rate_cents ? `$${centsToDollars(s.hourly_rate_cents)}/h` : '—') }]} />
              </Card>
            )}
            {!approved ? <Alert tone="info">You can submit candidates once BSM has approved your agency.</Alert>
              : can('agency.submissions.manage') ? <SubmitCard orgId={org.id} d={d} /> : <Alert tone="info">Your role can view this job but not submit candidates.</Alert>}
          </>
        )}
      </QueryBoundary>
    </>
  );
}
