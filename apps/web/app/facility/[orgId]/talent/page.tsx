'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Alert, Badge, Button, Card, CheckField, CredentialStatusBadge, DAYS, EligibilityBadge, EmptyState, ErrorAlert, PageHeader, Pagination, QueryBoundary, SelectField, TextArea, TextField, US_STATE_CODES,
  formatDate, titleCase, useAction, useApi, useClient,
} from '@bsm/ui';
import { useOrg } from '@/lib/org';

interface Card_ {
  talentRef: string; profession: string; specialties: string[]; city: string | null; state: string | null; yearsExperience: number;
  credentials: { kind: string; credentialType: string; jurisdiction: string | null; status: string; verificationMethod: string | null; statusLabel: string }[];
  availability: { daysOfWeek: number[]; employmentTypes: string[]; shiftTypes: string[]; preferredStates: string[]; availableFrom: string | null };
  match: null | { outcome: string; score: number | null; reasons: { code: string; message: string }[] };
}
interface JobOpt { id: string; title: string }
const EMPTY = { professionId: '', specialtyId: '', state: '', employmentType: '', licenseType: '', licenseState: '', verifiedOnly: false, minYears: '', jobId: '' };

function Invite({ orgId, card, jobs, onDone }: { orgId: string; card: Card_; jobs: JobOpt[]; onDone: () => void }) {
  const client = useClient();
  const [jobId, setJobId] = useState(jobs[0]?.id ?? '');
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);
  const send = useAction(async () => { await client.post(`/organizations/${orgId}/talent/invitations`, { talentRef: card.talentRef, jobId, message: message || undefined }); setSent(true); onDone(); });
  if (sent) return <Alert tone="success">Invitation sent. They will see your organization and the job, and decide whether to apply. You will see who they are only if they apply.</Alert>;
  if (jobs.length === 0) return <p className="small muted">Publish a job to invite people.</p>;
  return (
    <details>
      <summary>Invite to apply</summary>
      <form onSubmit={(e) => { e.preventDefault(); void send.run(); }} noValidate>
        <ErrorAlert error={send.error} />
        <SelectField label="Which job?" name="jobId" required value={jobId} onChange={setJobId} options={jobs.map((j) => ({ value: j.id, label: j.title }))} error={send.error} />
        <TextArea label="Message (optional)" name="message" rows={3} value={message} onChange={setMessage} maxLength={500} error={send.error} hint="Do not include personal contact details. They will not see your name." />
        <Button type="submit" pending={send.pending} disabled={!jobId}>Send invitation</Button>
      </form>
    </details>
  );
}

function SentInvitations({ orgId, refreshKey }: { orgId: string; refreshKey: number }) {
  const client = useClient();
  const state = useApi<{ invitations: { id: string; status: string; job_title: string; profession: string; created_at: string; application_id: string | null }[] }>(`/organizations/${orgId}/talent/invitations`, { k: refreshKey });
  const withdraw = useAction(async (id: string) => { await client.delete(`/organizations/${orgId}/talent/invitations/${id}`); await state.reload(); });
  return (
    <Card title="Invitations you have sent">
      <ErrorAlert error={withdraw.error} />
      <QueryBoundary state={state}>
        {(d) => d.invitations.length === 0 ? <p className="muted">None yet.</p> : (
          <ul>{d.invitations.map((i) => (
            <li key={i.id}>{i.profession} → {i.job_title} <Badge tone={i.status === 'applied' ? 'success' : i.status === 'pending' ? 'info' : 'neutral'}>{titleCase(i.status)}</Badge>{' '}
              {i.application_id && <Link href={`/facility/${orgId}/applications/${i.application_id}`}>View application</Link>}
              {i.status === 'pending' && <Button tone="secondary" onClick={() => void withdraw.run(i.id)}>Withdraw</Button>}</li>
          ))}</ul>
        )}
      </QueryBoundary>
    </Card>
  );
}

export default function TalentPage() {
  const { org, approved, can } = useOrg();
  const [draft, setDraft] = useState(EMPTY);
  const [applied, setApplied] = useState(EMPTY);
  const [page, setPage] = useState(1);
  const [key, setKey] = useState(0);
  const allowed = approved && can('professionals.search');
  useEffect(() => { const j = new URLSearchParams(window.location.search).get('jobId'); if (j) { setDraft((d) => ({ ...d, jobId: j })); setApplied((d) => ({ ...d, jobId: j })); } }, []);
  const taxonomy = useApi<{ professions: { id: string; name: string; specialties: { id: string; name: string }[] }[] }>('/taxonomies/professions');
  const jobs = useApi<{ jobs: JobOpt[] }>(allowed ? `/organizations/${org.id}/jobs` : null, { status: 'published', pageSize: 50 });
  const results = useApi<{ talent: Card_[]; total: number; pageSize: number }>(allowed ? `/organizations/${org.id}/talent` : null, {
    professionId: applied.professionId, specialtyId: applied.specialtyId, state: applied.state, employmentType: applied.employmentType, licenseType: applied.licenseType,
    licenseState: applied.licenseState, verifiedOnly: applied.verifiedOnly ? 'true' : undefined, minYears: applied.minYears, jobId: applied.jobId, page, pageSize: 12,
  });
  const set = (k: keyof typeof EMPTY) => (v: string) => setDraft({ ...draft, [k]: v, ...(k === 'professionId' ? { specialtyId: '' } : {}) });
  const specialties = taxonomy.data?.professions.find((p) => p.id === draft.professionId)?.specialties ?? [];
  if (!allowed) return <><PageHeader title="Find professionals" /><Alert tone="info">{approved ? 'Your role cannot search professionals.' : 'Searching professionals unlocks once BSM approves your organization.'}</Alert></>;
  return (
    <>
      <PageHeader title="Find professionals" subtitle="Professionals who chose to be discoverable, shown anonymously." />
      <Alert tone="info" title="Privacy">Results show a profession, specialties, general location, experience, credential status and availability. They never show a name, contact details, employers, schools, pay expectations or credential numbers. A person’s identity is revealed only if they apply to your job.</Alert>
      <Card>
        <form role="search" onSubmit={(e) => { e.preventDefault(); setApplied(draft); setPage(1); }}>
          <div className="form-grid">
            <SelectField label="Match against one of my jobs" name="jobId" value={draft.jobId} onChange={set('jobId')} placeholder="No job (just search)" options={(jobs.data?.jobs ?? []).map((j) => ({ value: j.id, label: j.title }))} hint="Shows who is eligible for it, with reasons." />
            <SelectField label="Profession" name="professionId" value={draft.professionId} onChange={set('professionId')} placeholder="Any" options={(taxonomy.data?.professions ?? []).map((p) => ({ value: p.id, label: p.name }))} />
            <SelectField label="Specialty" name="specialtyId" value={draft.specialtyId} onChange={set('specialtyId')} placeholder="Any" options={specialties.map((s) => ({ value: s.id, label: s.name }))} />
            <SelectField label="Located in" name="state" value={draft.state} onChange={set('state')} placeholder="Any state" options={US_STATE_CODES.map((s) => ({ value: s, label: s }))} />
            <SelectField label="Looking for" name="employmentType" value={draft.employmentType} onChange={set('employmentType')} placeholder="Any" options={['permanent', 'per_diem', 'contract', 'travel'].map((v) => ({ value: v, label: titleCase(v) }))} />
            <TextField label="Has license type" name="licenseType" value={draft.licenseType} onChange={set('licenseType')} hint="e.g. RN" />
            <SelectField label="License state" name="licenseState" value={draft.licenseState} onChange={set('licenseState')} placeholder="Any" options={US_STATE_CODES.map((s) => ({ value: s, label: s }))} />
            <TextField label="Minimum years of experience" name="minYears" type="number" min={0} max={50} value={draft.minYears} onChange={set('minYears')} />
          </div>
          <CheckField label="Only people with a verified, unexpired credential" checked={draft.verifiedOnly} onChange={(v) => setDraft({ ...draft, verifiedOnly: v })} />
          <div className="row"><button type="submit" className="btn">Search</button><button type="button" className="btn secondary" onClick={() => { setDraft(EMPTY); setApplied(EMPTY); setPage(1); }}>Clear</button></div>
        </form>
      </Card>
      <QueryBoundary state={results}>
        {(d) => d.talent.length === 0 ? <EmptyState title="No professionals match">Only people who opted in appear. Try fewer filters.</EmptyState> : (
          <>
            <p aria-live="polite" className="muted">{d.total} professional{d.total === 1 ? '' : 's'}</p>
            <div className="grid">
              {d.talent.map((c) => (
                <Card key={c.talentRef} title={c.profession} actions={c.match ? <EligibilityBadge outcome={c.match.outcome} /> : undefined}>
                  <p className="muted" style={{ marginTop: 0 }}>{[c.city, c.state].filter(Boolean).join(', ') || 'Location not stated'} · {c.yearsExperience} yrs experience</p>
                  {c.specialties.length > 0 && <p>{c.specialties.join(', ')}</p>}
                  {c.match && (
                    <div className="small">
                      {c.match.score !== null && <p><Badge tone="info">Score {c.match.score.toFixed(1)}</Badge> (ranks only eligible people)</p>}
                      {c.match.reasons.length > 0 && <ul style={{ paddingLeft: 16 }}>{c.match.reasons.map((r, i) => <li key={i}>{r.message}</li>)}</ul>}
                    </div>
                  )}
                  <div className="stack">{c.credentials.map((cr, i) => (<div key={i} className="small">{cr.credentialType}{cr.jurisdiction ? ` (${cr.jurisdiction})` : ''}: <CredentialStatusBadge status={cr.status} method={cr.verificationMethod} label={cr.statusLabel} /></div>))}</div>
                  <p className="small muted">Available {c.availability.daysOfWeek.length ? c.availability.daysOfWeek.map((n) => DAYS[n]!.slice(0, 3)).join(', ') : 'days not stated'}
                    {c.availability.employmentTypes.length ? ` · prefers ${c.availability.employmentTypes.map(titleCase).join(', ').toLowerCase()}` : ''}
                    {c.availability.availableFrom ? ` · from ${formatDate(c.availability.availableFrom)}` : ''}</p>
                  {can('applications.manage') && <Invite orgId={org.id} card={c} jobs={jobs.data?.jobs ?? []} onDone={() => setKey((k) => k + 1)} />}
                </Card>
              ))}
            </div>
            <Pagination page={page} pageSize={d.pageSize} total={Math.min(d.total, 300)} onPage={setPage} />
          </>
        )}
      </QueryBoundary>
      {can('applications.read') && <SentInvitations orgId={org.id} refreshKey={key} />}
    </>
  );
}
