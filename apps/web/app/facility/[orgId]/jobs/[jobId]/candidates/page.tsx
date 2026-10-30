'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Alert, ApplicationStatusBadge, Badge, CheckField, DataTable, EligibilityBadge, EmptyState, PageHeader, Pagination, QueryBoundary, formatDateTime, useApi } from '@bsm/ui';
import { useOrg } from '@/lib/org';

interface C {
  applicationId: string; status: string; appliedAt: string; rank: number | null; score: number | null;
  eligibility: { outcome: string; reasons: { code: string; message: string }[] }; applicant: { name: string; headline: string | null; city: string | null; state: string | null };
}

export default function CandidatesPage() {
  const { org } = useOrg();
  const { jobId } = useParams<{ jobId: string }>();
  const [includeClosed, setIncludeClosed] = useState(false);
  const [page, setPage] = useState(1);
  const state = useApi<{ candidates: C[]; total: number; pageSize: number; truncated: boolean; note: string }>(`/organizations/${org.id}/jobs/${jobId}/candidates`, { includeClosed: includeClosed ? 'true' : 'false', page, pageSize: 20 });
  return (
    <>
      <p><Link href={`/facility/${org.id}/jobs/${jobId}`}>← Back to the job</Link></p>
      <PageHeader title="Applicants" subtitle="Eligible applicants are ranked first. Everyone else is listed with exactly what is unmet." />
      <Alert tone="info">Ranking only orders applicants who already meet every mandatory requirement, using job-related factors. It never overrides a requirement, and an offer can only be sent to someone who is currently eligible.</Alert>
      <CheckField label="Include withdrawn, declined and rejected applicants" checked={includeClosed} onChange={(v) => { setIncludeClosed(v); setPage(1); }} />
      <QueryBoundary state={state}>
        {(d) => d.candidates.length === 0 ? <EmptyState title="No applicants yet">Applications will appear here as professionals apply.</EmptyState> : (
          <>
            {d.truncated && <Alert tone="warning">Only the first 500 applications are evaluated.</Alert>}
            <DataTable caption="Applicants" rows={d.candidates} rowKey={(c) => c.applicationId}
              columns={[
                { header: 'Rank', cell: (c) => (c.rank ? <Badge tone="info">#{c.rank} · {c.score?.toFixed(1)}</Badge> : <span className="muted">Not ranked</span>) },
                { header: 'Applicant', cell: (c) => <><Link href={`/facility/${org.id}/applications/${c.applicationId}`}>{c.applicant.name}</Link><br /><span className="muted small">{[c.applicant.headline, [c.applicant.city, c.applicant.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</span></> },
                { header: 'Eligibility', cell: (c) => (
                  <>
                    <EligibilityBadge outcome={c.eligibility.outcome} />
                    {c.eligibility.reasons.length > 0 && <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 16 }}>{c.eligibility.reasons.map((r, i) => <li key={i}>{r.message}</li>)}</ul>}
                  </>) },
                { header: 'Status', cell: (c) => <ApplicationStatusBadge status={c.status} /> }, { header: 'Applied', cell: (c) => formatDateTime(c.appliedAt) },
              ]} />
            <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
            <p className="small muted">Ranking factors and weights are shown on each eligible applicant’s detail page.</p>
          </>
        )}
      </QueryBoundary>
    </>
  );
}
