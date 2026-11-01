'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  Alert, Badge, Card, CheckField, DefinitionList, EligibilityPanel, ErrorAlert, LinkButton, PageHeader, QueryBoundary, TextArea,
  formatDateTime, formatPay, titleCase, useAction, useApi, useClient, type EligibilityData,
} from '@bsm/ui';
import type { JobSummary } from '../page';
import { RatingText, type RatingSummary } from '@/components/Reviews';

interface Detail {
  job: JobSummary & { description: string; positions_count: number; min_years_experience: number | null };
  requirements: { kind: string; credential_type: string | null; jurisdiction: string | null; description: string | null; mandatory: boolean }[];
  shifts: { id: string; starts_at: string; ends_at: string; positions: number; hourly_rate_cents: number | null; notes: string | null }[];
  organizationRating?: RatingSummary | null;
}

const reqText = (r: Detail['requirements'][number]) => r.kind === 'license' ? `${r.credential_type} license (${r.jurisdiction})` : r.kind === 'certification' ? `${r.credential_type} certification` : r.description;

function Apply({ d }: { d: Detail }) {
  const client = useClient();
  const [shiftIds, setShiftIds] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<{ id: string; eligibility: EligibilityData } | null>(null);
  const apply = useAction(async () => {
    const r = await client.post<{ application: { id: string }; eligibility: EligibilityData }>(`/jobs/${d.job.id}/apply`, { coverNote: note || undefined, shiftIds: shiftIds.length ? shiftIds : undefined });
    setResult({ id: r.application.id, eligibility: r.eligibility });
  });
  if (result) {
    return (
      <Card title="Application sent">
        <Alert tone="success">The facility has been notified. You can follow its progress under My applications.</Alert>
        <EligibilityPanel eligibility={result.eligibility} heading="How your application currently measures up" />
        <p><LinkButton href={`/professional/applications/${result.id}`}>View application</LinkButton></p>
      </Card>
    );
  }
  const details = apply.error?.details;
  return (
    <Card title="Apply">
      <form onSubmit={(e) => { e.preventDefault(); void apply.run(); }}>
        {apply.error && !details?.reasons && <ErrorAlert error={apply.error} />}
        {details?.reasons && (
          <div className="stack">
            <Alert tone="warning" title="You can’t apply yet">{apply.error?.message}</Alert>
            <EligibilityPanel eligibility={{ outcome: details.outcome, reasons: details.reasons }} heading="What is missing" />
            <p className="small"><Link href="/professional/credentials">Add or update credentials</Link> · <Link href="/professional/availability">Update availability</Link></p>
          </div>
        )}
        {d.shifts.length > 0 && (
          <fieldset>
            <legend>Which shifts can you work? (optional)</legend>
            {d.shifts.map((s) => (
              <CheckField key={s.id} label={`${formatDateTime(s.starts_at, d.job.timezone)} – ${formatDateTime(s.ends_at, d.job.timezone)}`}
                checked={shiftIds.includes(s.id)} onChange={(v) => setShiftIds(v ? [...shiftIds, s.id] : shiftIds.filter((x) => x !== s.id))} />
            ))}
            <p className="small muted">If you choose shifts, they must fit your weekly availability and not overlap shifts you have already accepted.</p>
          </fieldset>
        )}
        <TextArea label="Note to the facility (optional)" name="coverNote" value={note} onChange={setNote} maxLength={2000} rows={3} />
        <p className="small muted">When you apply, the facility can see your name, profile details and the status of your credentials. It cannot see your credential numbers or documents.</p>
        <button type="submit" className="btn" disabled={apply.pending}>{apply.pending ? 'Sending…' : 'Submit application'}</button>
      </form>
    </Card>
  );
}

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<Detail>(`/jobs/${id}`);
  return (
    <>
      <p><Link href="/professional/jobs">← Search results</Link></p>
      <QueryBoundary state={state}>
        {(d) => (
          <>
            <PageHeader title={d.job.title} subtitle={<>{d.job.organization_name} · {d.job.facility_name} · {d.job.city}, {d.job.state}</>} actions={<Badge tone="info">{titleCase(d.job.employment_type)}</Badge>} />
            <Card title="About this job">
              <p style={{ whiteSpace: 'pre-wrap' }}>{d.job.description}</p>
              <DefinitionList items={[
                ['Profession', `${d.job.profession}${d.job.specialty ? ` · ${d.job.specialty}` : ''}`],
                ['Rated by professionals', d.organizationRating ? <RatingText key="or" rating={d.organizationRating} who={d.job.organization_name} /> : '—'], ['Pay', formatPay(d.job.pay_unit, d.job.pay_min_cents, d.job.pay_max_cents)],
                ['Openings', String(d.job.positions_count)], ['Minimum experience', d.job.min_years_experience != null ? `${d.job.min_years_experience} years` : 'Not stated'],
                ['Apply by', d.job.application_deadline ? formatDateTime(d.job.application_deadline, d.job.timezone) : 'Open until filled'],
              ]} />
            </Card>
            <Card title="Requirements">
              {d.requirements.length === 0 ? <p className="muted">This facility lists no license or certification requirements.</p> : (
                <ul>{d.requirements.map((r, i) => <li key={i}>{reqText(r)} <Badge tone={r.mandatory ? 'warning' : 'neutral'}>{r.mandatory ? 'Required' : 'Preferred'}</Badge></li>)}</ul>
              )}
              <p className="small muted">Required items must be verified and unexpired before a facility can send you an offer.</p>
            </Card>
            {d.shifts.length > 0 && (
              <Card title="Upcoming shifts">
                <ul>{d.shifts.map((s) => <li key={s.id}>{formatDateTime(s.starts_at, d.job.timezone)} – {formatDateTime(s.ends_at, d.job.timezone)} · {s.positions} needed{s.hourly_rate_cents ? ` · $${(s.hourly_rate_cents / 100).toFixed(2)}/hr` : ''}{s.notes ? ` · ${s.notes}` : ''}</li>)}</ul>
              </Card>
            )}
            <Apply d={d} />
          </>
        )}
      </QueryBoundary>
    </>
  );
}
