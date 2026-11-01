'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, ApplicationStatusBadge, DataTable, EmptyState, PageHeader, Pagination, QueryBoundary, SelectField, formatDateTime, titleCase, useApi } from '@bsm/ui';
import { useOrg } from '@/lib/org';
import { OrgAssignmentsSection } from './shift-sections';

interface A { id: string; status: string; job_id: string; title: string; applicant_name: string; created_at: string; updated_at: string }
const STATUSES = ['submitted', 'under_review', 'shortlisted', 'interview_requested', 'interviewed', 'offer_sent', 'accepted', 'declined', 'withdrawn', 'rejected', 'cancelled'];

export default function ApplicationsPage() {
  const { org, approved, can } = useOrg();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const list = useApi<{ applications: A[]; total: number; pageSize: number }>(approved ? `/organizations/${org.id}/applications` : null, { status, page, pageSize: 20 });
  return (
    <>
      <PageHeader title="Applications" />
      {!approved && <Alert tone="info">Applications arrive once your organization is approved and you have published jobs.</Alert>}
      {approved && (
        <>
          <SelectField label="Status" name="status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} placeholder="All" options={STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} />
          <QueryBoundary state={list}>
            {(d) => d.applications.length === 0 ? <EmptyState title="No applications" /> : (
              <>
                <DataTable caption="Applications" rows={d.applications} rowKey={(a) => a.id}
                  columns={[
                    { header: 'Applicant', cell: (a) => <Link href={`/facility/${org.id}/applications/${a.id}`}>{a.applicant_name}</Link> },
                    { header: 'Job', cell: (a) => <Link href={`/facility/${org.id}/jobs/${a.job_id}/candidates`}>{a.title}</Link> },
                    { header: 'Status', cell: (a) => <ApplicationStatusBadge status={a.status} /> }, { header: 'Applied', cell: (a) => formatDateTime(a.created_at) }, { header: 'Updated', cell: (a) => formatDateTime(a.updated_at) },
                  ]} />
                <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
              </>
            )}
          </QueryBoundary>
          <OrgAssignmentsSection orgId={org.id} canManage={can('applications.manage')} />
        </>
      )}
    </>
  );
}
