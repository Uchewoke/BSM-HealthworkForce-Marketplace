'use client';
import Link from 'next/link';
import { Alert, DataTable, EmptyState, PageHeader, QueryBoundary, formatDateTime, formatPay, titleCase, useApi } from '@bsm/ui';
import { useOrg } from '@/lib/org';

interface Job { id: string; title: string; employment_type: string; pay_min_cents: number | null; pay_max_cents: number | null; facility_name: string; city: string; state: string; profession: string; next_shift_at: string | null }

export default function AgencyJobsPage() {
  const { org, approved } = useOrg();
  const jobs = useApi<{ jobs: Job[] }>(`/organizations/${org.id}/agency/jobs`);
  return (
    <>
      <PageHeader title="Open jobs" subtitle="Jobs that facilities have shared with your agency. You only see jobs you were given access to." />
      {!approved && <Alert tone="info">You can submit candidates once BSM has approved your agency.</Alert>}
      <QueryBoundary state={jobs}>
        {(d) => d.jobs.length === 0 ? <EmptyState title="No jobs shared with you yet">A facility gives your agency access to a job from its job page. Share your agency name with your facility contacts.</EmptyState> : (
          <DataTable caption="Jobs open to your agency" rows={d.jobs} rowKey={(j) => j.id}
            columns={[
              { header: 'Job', cell: (j) => <Link href={`/agency/${org.id}/jobs/${j.id}`}>{j.title}</Link> }, { header: 'Facility', cell: (j) => j.facility_name },
              { header: 'Profession', cell: (j) => j.profession }, { header: 'Type', cell: (j) => titleCase(j.employment_type) },
              { header: 'Location', cell: (j) => `${j.city}, ${j.state}` }, { header: 'Pay', cell: (j) => formatPay('hour', j.pay_min_cents, j.pay_max_cents) || '—' },
              { header: 'Next shift', cell: (j) => (j.next_shift_at ? formatDateTime(j.next_shift_at) : '—') },
            ]} />
        )}
      </QueryBoundary>
    </>
  );
}
