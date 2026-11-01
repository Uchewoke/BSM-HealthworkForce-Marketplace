'use client';
import { Alert, AssignmentStatusBadge, DataTable, EmptyState, PageHeader, QueryBoundary, centsToDollars, formatDateTime, titleCase, useApi } from '@bsm/ui';
import { useOrg } from '@/lib/org';

interface Placement { id: string; status: string; hourly_rate_cents: number; starts_at: string; ends_at: string; title: string; facility_name: string; candidate_name: string; timesheet_status: string | null; minutes_worked: number | null }

export default function PlacementsPage() {
  const { org } = useOrg();
  const placements = useApi<{ placements: Placement[] }>(`/organizations/${org.id}/agency/placements`);
  return (
    <>
      <PageHeader title="Placements" subtitle="Confirmed shifts that came from your submissions." />
      <Alert tone="info">Rates shown are the hourly rate agreed in the shift offer. Invoicing between you and the facility is not handled here.</Alert>
      <QueryBoundary state={placements}>
        {(d) => d.placements.length === 0 ? <EmptyState title="No placements yet">A placement appears when a facility sends an offer for a submitted candidate and the candidate accepts.</EmptyState> : (
          <DataTable caption="Agency placements" rows={d.placements} rowKey={(p) => p.id}
            columns={[
              { header: 'Candidate', cell: (p) => p.candidate_name }, { header: 'Job', cell: (p) => p.title }, { header: 'Facility', cell: (p) => p.facility_name },
              { header: 'Shift', cell: (p) => `${formatDateTime(p.starts_at)} – ${formatDateTime(p.ends_at)}` }, { header: 'Rate', cell: (p) => `$${centsToDollars(p.hourly_rate_cents)}/h` },
              { header: 'Status', cell: (p) => <AssignmentStatusBadge status={p.status} /> },
              { header: 'Timesheet', cell: (p) => (p.timesheet_status ? `${titleCase(p.timesheet_status)}${p.minutes_worked ? ` · ${(p.minutes_worked / 60).toFixed(2)} h` : ''}` : 'Not submitted') },
            ]} />
        )}
      </QueryBoundary>
    </>
  );
}
