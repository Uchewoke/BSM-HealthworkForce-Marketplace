'use client';
import { useState } from 'react';
import { ApplicationStatusBadge, DataTable, EmptyState, PageHeader, Pagination, QueryBoundary, formatDateTime, useApi } from '@bsm/ui';
import { useOrg } from '@/lib/org';

interface Sub { id: string; status: string; created_at: string; updated_at: string; title: string; facility_name: string; candidate_name: string }

export default function SubmissionsPage() {
  const { org } = useOrg();
  const [page, setPage] = useState(1);
  const subs = useApi<{ submissions: Sub[]; total: number; pageSize: number }>(`/organizations/${org.id}/agency/submissions`, { page });
  return (
    <>
      <PageHeader title="Submissions" subtitle="Candidates you have submitted. The facility decides what happens next; you see the status." />
      <QueryBoundary state={subs}>
        {(d) => d.submissions.length === 0 ? <EmptyState title="No submissions yet">Open a job that a facility shared with you and submit a roster member.</EmptyState> : (
          <>
            <DataTable caption="Agency submissions" rows={d.submissions} rowKey={(s) => s.id}
              columns={[
                { header: 'Candidate', cell: (s) => s.candidate_name }, { header: 'Job', cell: (s) => s.title }, { header: 'Facility', cell: (s) => s.facility_name },
                { header: 'Status', cell: (s) => <ApplicationStatusBadge status={s.status} /> }, { header: 'Submitted', cell: (s) => formatDateTime(s.created_at) }, { header: 'Updated', cell: (s) => formatDateTime(s.updated_at) },
              ]} />
            <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </>
        )}
      </QueryBoundary>
    </>
  );
}
