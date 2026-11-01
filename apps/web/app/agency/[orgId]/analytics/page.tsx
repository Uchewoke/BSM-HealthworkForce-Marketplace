'use client';
import { useMemo, useState } from 'react';
import { PageHeader, QueryBoundary, SelectField, titleCase, useApi } from '@bsm/ui';
import { BarList, ChartCard, ChartStyles, ColumnChart, DataTable, StatTile, percent } from '@/components/Charts';
import { useOrg } from '@/lib/org';

interface Data {
  range: { from: string; to: string; days: number; bucket: 'week' | 'month' };
  totals: { submissions: number; placements: number; placementRate: number | null; approvedHours: number; rejected: number; withdrawn: number };
  byStatus: { status: string; count: number }[];
  trend: { bucket: string; submissions: number; placements: number }[];
  byFacility: { facility: string; submissions: number; placements: number }[];
}

const PERIODS = [{ value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }, { value: '180', label: 'Last 6 months' }, { value: '365', label: 'Last 12 months' }];

export default function AgencyAnalyticsPage() {
  const { org } = useOrg();
  const [period, setPeriod] = useState('90');
  const query = useMemo(() => {
    const to = new Date(); const from = new Date(to.getTime() - (Number(period) - 1) * 86_400_000);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }, [period]);
  const state = useApi<Data>(`/organizations/${org.id}/agency/analytics`, query);
  return (
    <>
      <ChartStyles />
      <PageHeader title="Agency analytics" subtitle="What you submitted and what came of it. Figures cover your agency only, in UTC days." />
      <SelectField label="Period" name="period" value={period} onChange={setPeriod} options={PERIODS} />
      <QueryBoundary state={state}>
        {(d) => (
          <>
            <div className="grid">
              <StatTile label="Candidates submitted" value={d.totals.submissions} />
              <StatTile label="Placements" value={d.totals.placements} note="Candidates who accepted a shift offer" />
              <StatTile label="Placement rate" value={percent(d.totals.placementRate)} note="Placements per submission in the period" />
              <StatTile label="Approved hours" value={d.totals.approvedHours.toLocaleString()} note="Worked by your placed candidates" />
            </div>
            <ChartCard title="Submissions and placements" subtitle={`By ${d.range.bucket}. Both series count people on one scale.`}
              table={<DataTable caption="Submissions and placements" rows={d.trend} rowKey={(t) => t.bucket} columns={[{ header: d.range.bucket === 'week' ? 'Week of' : 'Month', cell: (t) => t.bucket }, { header: 'Submissions', cell: (t) => t.submissions }, { header: 'Placements', cell: (t) => t.placements }]} />}>
              <ColumnChart data={d.trend} bucket={d.range.bucket} caption="Submissions and placements" series={[{ key: 'submissions', label: 'Submissions' }, { key: 'placements', label: 'Placements' }]} />
            </ChartCard>
            <ChartCard title="Where submissions stand"
              table={<DataTable caption="Submissions by status" rows={d.byStatus} rowKey={(s) => s.status} columns={[{ header: 'Status', cell: (s) => titleCase(s.status) }, { header: 'Submissions', cell: (s) => s.count }]} />}>
              <BarList rows={d.byStatus.map((s) => ({ name: titleCase(s.status), value: s.count, label: String(s.count) }))} />
            </ChartCard>
            <ChartCard title="Facilities you submit to" subtitle="Top 10 by submissions."
              table={<DataTable caption="By facility" rows={d.byFacility} rowKey={(f) => f.facility} columns={[{ header: 'Facility', cell: (f) => f.facility }, { header: 'Submissions', cell: (f) => f.submissions }, { header: 'Placements', cell: (f) => f.placements }]} />}>
              <BarList rows={d.byFacility.map((f) => ({ name: f.facility, value: f.submissions, label: `${f.submissions} submitted · ${f.placements} placed` }))} />
            </ChartCard>
          </>
        )}
      </QueryBoundary>
    </>
  );
}
