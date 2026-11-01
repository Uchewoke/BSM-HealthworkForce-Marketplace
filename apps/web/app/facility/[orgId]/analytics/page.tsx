'use client';
import { useMemo, useState } from 'react';
import { Alert, PageHeader, QueryBoundary, SelectField, titleCase, useApi } from '@bsm/ui';
import { BarList, ChartCard, ChartStyles, ColumnChart, DataTable, StatTile, money, percent } from '@/components/Charts';
import { useOrg } from '@/lib/org';

interface Data {
  range: { from: string; to: string; days: number; bucket: 'week' | 'month' };
  includesCosts: boolean;
  fill: { positionsPosted: number; positionsFilled: number; fillRate: number | null; upcomingOpenPositions: number };
  trend: { bucket: string; positionsPosted: number; positionsFilled: number; applications: number }[];
  byProfession: { profession: string; positionsPosted: number; positionsFilled: number; fillRate: number | null }[];
  outcomes: { confirmed: number; completed: number; noShow: number; cancelledByProfessional: number; cancelledByFacility: number; finished: number; noShowRate: number | null; cancellationRate: number | null; completionRate: number | null };
  timeToFill: { medianHours: number | null; sample: number };
  funnel: { applications: number; viaAgency: number; offersSent: number; offersAccepted: number; offersDeclined: number; offersExpired: number; offerAcceptanceRate: number | null };
  costs?: {
    approvedHours: number; agreedPayCents: number; averageHourlyRateCents: number | null; platformFeesInvoicedCents: number; platformFeesPaidCents: number;
    trend: { bucket: string; hours: number; payCents: number }[]; byProfession: { profession: string; hours: number; payCents: number }[];
  };
}

const PERIODS = [{ value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }, { value: '180', label: 'Last 6 months' }, { value: '365', label: 'Last 12 months' }];
const hoursLabel = (h: number | null) => (h === null ? '—' : h < 48 ? `${h} h` : `${Math.round(h / 24)} days`);

export default function AnalyticsPage() {
  const { org } = useOrg();
  const [period, setPeriod] = useState('90');
  const query = useMemo(() => {
    const to = new Date(); const from = new Date(to.getTime() - (Number(period) - 1) * 86_400_000);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }, [period]);
  const state = useApi<Data>(`/organizations/${org.id}/analytics`, query);
  return (
    <>
      <ChartStyles />
      <PageHeader title="Staffing analytics" subtitle="How well your shifts are filled, how reliably they are worked, and what they cost. Figures cover your organization only, in UTC days." />
      <SelectField label="Period" name="period" value={period} onChange={setPeriod} options={PERIODS} />
      <QueryBoundary state={state}>
        {(d) => (
          <>
            <div className="grid">
              <StatTile label="Fill rate" value={percent(d.fill.fillRate)} note={`${d.fill.positionsFilled} of ${d.fill.positionsPosted} positions filled`} />
              <StatTile label="Median time to fill" value={hoursLabel(d.timeToFill.medianHours)} note={d.timeToFill.sample === 0 ? 'No filled shifts yet' : `From publishing to a confirmed booking · ${d.timeToFill.sample} bookings`} />
              <StatTile label="Shifts completed" value={percent(d.outcomes.completionRate)} note={`${d.outcomes.completed} of ${d.outcomes.finished} finished assignments`} />
              <StatTile label="Offer acceptance" value={percent(d.funnel.offerAcceptanceRate)} note={`${d.funnel.offersAccepted} of ${d.funnel.offersSent} offers accepted`} />
              <StatTile label="Open upcoming positions" value={d.fill.upcomingOpenPositions} note="Not yet filled, starting from now" />
            </div>

            <ChartCard title="Positions posted and filled" subtitle={`By ${d.range.bucket} of shift start. Both series count positions on one scale.`}
              table={<DataTable caption="Positions posted and filled" rows={d.trend} rowKey={(t) => t.bucket} columns={[{ header: d.range.bucket === 'week' ? 'Week of' : 'Month', cell: (t) => t.bucket }, { header: 'Posted', cell: (t) => t.positionsPosted }, { header: 'Filled', cell: (t) => t.positionsFilled }, { header: 'Applications', cell: (t) => t.applications }]} />}>
              <ColumnChart data={d.trend} bucket={d.range.bucket} caption="Positions posted and filled"
                series={[{ key: 'positionsPosted', label: 'Positions posted' }, { key: 'positionsFilled', label: 'Positions filled' }]} />
            </ChartCard>

            <ChartCard title="Fill rate by profession" subtitle="Share of posted positions that were filled."
              table={<DataTable caption="Fill rate by profession" rows={d.byProfession} rowKey={(p) => p.profession} columns={[{ header: 'Profession', cell: (p) => p.profession }, { header: 'Posted', cell: (p) => p.positionsPosted }, { header: 'Filled', cell: (p) => p.positionsFilled }, { header: 'Fill rate', cell: (p) => percent(p.fillRate) }]} />}>
              <BarList max={100} rows={[...d.byProfession].sort((a, b) => (b.fillRate ?? -1) - (a.fillRate ?? -1)).map((p) => ({ name: p.profession, value: p.fillRate ?? 0, label: `${percent(p.fillRate)} · ${p.positionsFilled}/${p.positionsPosted}` }))} />
            </ChartCard>

            <ChartCard title="How assignments ended" subtitle={`No-shows ${percent(d.outcomes.noShowRate)} · cancellations ${percent(d.outcomes.cancellationRate)} of finished assignments.`}
              table={<DataTable caption="Assignment outcomes" rows={Object.entries({ completed: d.outcomes.completed, noShow: d.outcomes.noShow, cancelledByProfessional: d.outcomes.cancelledByProfessional, cancelledByFacility: d.outcomes.cancelledByFacility, confirmed: d.outcomes.confirmed })} rowKey={([k]) => k} columns={[{ header: 'Outcome', cell: ([k]) => titleCase(k.replace(/([A-Z])/g, '_$1').toLowerCase()) }, { header: 'Assignments', cell: ([, n]) => n }]} />}>
              <BarList rows={[
                { name: 'Completed', value: d.outcomes.completed, label: String(d.outcomes.completed) }, { name: 'Upcoming (confirmed)', value: d.outcomes.confirmed, label: String(d.outcomes.confirmed) },
                { name: 'No-show', value: d.outcomes.noShow, label: String(d.outcomes.noShow) }, { name: 'Cancelled by professional', value: d.outcomes.cancelledByProfessional, label: String(d.outcomes.cancelledByProfessional) },
                { name: 'Cancelled by facility', value: d.outcomes.cancelledByFacility, label: String(d.outcomes.cancelledByFacility) },
              ]} />
            </ChartCard>

            <ChartCard title="Applications to offers" subtitle="Applications received in the period and what became of the offers sent."
              table={<DataTable caption="Hiring funnel" rows={[['Applications received', d.funnel.applications], ['…of which via agencies', d.funnel.viaAgency], ['Offers sent', d.funnel.offersSent], ['Offers accepted', d.funnel.offersAccepted], ['Offers declined', d.funnel.offersDeclined], ['Offers expired', d.funnel.offersExpired]] as [string, number][]} rowKey={([k]) => k} columns={[{ header: 'Step', cell: ([k]) => k }, { header: 'Count', cell: ([, n]) => n }]} />}>
              <BarList rows={[
                { name: 'Applications', value: d.funnel.applications, label: String(d.funnel.applications) }, { name: 'Offers sent', value: d.funnel.offersSent, label: String(d.funnel.offersSent) },
                { name: 'Offers accepted', value: d.funnel.offersAccepted, label: String(d.funnel.offersAccepted) },
              ]} max={Math.max(1, d.funnel.applications, d.funnel.offersSent)} />
              <p className="small muted">{d.funnel.viaAgency} of {d.funnel.applications} applications came through staffing agencies. {d.funnel.offersDeclined} offers were declined and {d.funnel.offersExpired} expired.</p>
            </ChartCard>

            {d.costs ? (
              <>
                <h2>Cost</h2>
                <div className="grid">
                  <StatTile label="Approved hours" value={d.costs.approvedHours.toLocaleString()} note="From approved timesheets" />
                  <StatTile label="Agreed pay" value={money(d.costs.agreedPayCents)} note="Approved hours × the agreed hourly rate. An estimate: pay is settled directly with professionals." />
                  <StatTile label="Average hourly rate" value={d.costs.averageHourlyRateCents === null ? '—' : `${money(d.costs.averageHourlyRateCents)}/h`} />
                  <StatTile label="Platform fees invoiced" value={money(d.costs.platformFeesInvoicedCents)} note={`${money(d.costs.platformFeesPaidCents)} paid`} />
                </div>
                <ChartCard title="Approved hours over time" subtitle={`By ${d.range.bucket} in which the work ended.`}
                  table={<DataTable caption="Approved hours" rows={d.costs.trend} rowKey={(t) => t.bucket} columns={[{ header: d.range.bucket === 'week' ? 'Week of' : 'Month', cell: (t) => t.bucket }, { header: 'Hours', cell: (t) => t.hours }, { header: 'Agreed pay', cell: (t) => money(t.payCents) }]} />}>
                  <ColumnChart data={d.costs.trend} bucket={d.range.bucket} caption="Approved hours" series={[{ key: 'hours', label: 'Approved hours' }]} />
                </ChartCard>
                <ChartCard title="Agreed pay by profession"
                  table={<DataTable caption="Pay by profession" rows={d.costs.byProfession} rowKey={(p) => p.profession} columns={[{ header: 'Profession', cell: (p) => p.profession }, { header: 'Hours', cell: (p) => p.hours }, { header: 'Agreed pay', cell: (p) => money(p.payCents) }]} />}>
                  <BarList rows={d.costs.byProfession.map((p) => ({ name: p.profession, value: p.payCents, label: `${money(p.payCents)} · ${p.hours} h` }))} />
                </ChartCard>
              </>
            ) : <Alert tone="info">Cost figures are shown to owners and finance team members.</Alert>}
          </>
        )}
      </QueryBoundary>
    </>
  );
}
