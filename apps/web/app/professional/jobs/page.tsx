'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Card, EmptyState, PageHeader, Pagination, QueryBoundary, SelectField, TextField, US_STATE_CODES, dollarsToCents, formatDateTime, formatPay, titleCase, useApi } from '@bsm/ui';

export interface JobSummary {
  id: string; title: string; summary: string; employment_type: string; pay_unit: string; pay_min_cents: number | null; pay_max_cents: number | null;
  application_deadline: string | null; organization_name: string; facility_name: string; city: string; state: string; timezone: string;
  profession: string; specialty: string | null; next_shift_at: string | null; open_shifts: string | null;
}

const EMPTY = { q: '', state: '', employmentType: '', minPay: '', payUnit: 'hour', sort: 'published_at' };

export default function JobSearchPage() {
  const [draft, setDraft] = useState(EMPTY);
  const [applied, setApplied] = useState(EMPTY);
  const [page, setPage] = useState(1);
  const minPayCents = dollarsToCents(applied.minPay);
  const results = useApi<{ jobs: JobSummary[]; total: number; pageSize: number }>('/jobs', {
    q: applied.q, state: applied.state, employmentType: applied.employmentType, minPayCents, payUnit: minPayCents !== undefined ? applied.payUnit : undefined,
    sort: applied.sort, order: 'desc', page, pageSize: 10,
  });
  const set = (k: keyof typeof EMPTY) => (v: string) => setDraft({ ...draft, [k]: v });
  return (
    <>
      <PageHeader title="Find jobs" subtitle="Search open jobs and shifts, then apply directly to the facility." />
      <Card>
        <form role="search" onSubmit={(e) => { e.preventDefault(); setApplied(draft); setPage(1); }}>
          <div className="form-grid">
            <TextField label="Keywords" name="q" type="search" value={draft.q} onChange={set('q')} />
            <SelectField label="State" name="state" value={draft.state} onChange={set('state')} placeholder="Any state" options={US_STATE_CODES.map((s) => ({ value: s, label: s }))} />
            <SelectField label="Type of work" name="employmentType" value={draft.employmentType} onChange={set('employmentType')} placeholder="Any"
              options={['permanent', 'per_diem', 'contract', 'travel'].map((v) => ({ value: v, label: titleCase(v) }))} />
            <TextField label="Minimum pay ($)" name="minPay" type="number" min={0} step="0.01" value={draft.minPay} onChange={set('minPay')} />
            <SelectField label="Pay is per" name="payUnit" value={draft.payUnit} onChange={set('payUnit')} options={[{ value: 'hour', label: 'Hour' }, { value: 'year', label: 'Year' }]} />
            <SelectField label="Sort by" name="sort" value={draft.sort} onChange={set('sort')} options={[{ value: 'published_at', label: 'Newest' }, { value: 'pay_max', label: 'Highest pay' }, { value: 'next_shift', label: 'Soonest shift' }]} />
          </div>
          <div className="row"><button type="submit" className="btn">Search</button><button type="button" className="btn secondary" onClick={() => { setDraft(EMPTY); setApplied(EMPTY); setPage(1); }}>Clear</button></div>
        </form>
      </Card>
      <QueryBoundary state={results}>
        {(d) => d.jobs.length === 0 ? <EmptyState title="No jobs match your search">Try fewer filters. New jobs appear as facilities publish them.</EmptyState> : (
          <>
            <p aria-live="polite" className="muted">{d.total} job{d.total === 1 ? '' : 's'} found</p>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {d.jobs.map((j) => (
                <li key={j.id}>
                  <Card>
                    <div className="row between"><h2 style={{ margin: 0 }}><Link href={`/professional/jobs/${j.id}`}>{j.title}</Link></h2><Badge tone="info">{titleCase(j.employment_type)}</Badge></div>
                    <p className="muted" style={{ margin: '4px 0' }}>{j.organization_name} · {j.facility_name} · {j.city}, {j.state}</p>
                    <p style={{ margin: '4px 0' }}>{j.summary}{j.summary.length >= 300 ? '…' : ''}</p>
                    <div className="row small">
                      <span>Pay: <strong>{formatPay(j.pay_unit, j.pay_min_cents, j.pay_max_cents)}</strong></span>
                      <span>{j.profession}{j.specialty ? ` · ${j.specialty}` : ''}</span>
                      {j.next_shift_at && <span>Next shift: {formatDateTime(j.next_shift_at, j.timezone)}</span>}
                      {j.application_deadline && <span>Apply by {formatDateTime(j.application_deadline, j.timezone)}</span>}
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
            <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </>
        )}
      </QueryBoundary>
    </>
  );
}
