'use client';
import { useState } from 'react';
import { Alert, Badge, Card, PageHeader, QueryBoundary, SelectField, titleCase, useApi } from '@bsm/ui';
import { BarList, ChartCard, ChartStyles, DataTable, ForecastChart, StatTile, percent, type ForecastBar } from '@/components/Charts';
import { useOrg } from '@/lib/org';

interface Backtest { weeks: number; meanAbsoluteError: number; typicalErrorShare: number | null; withinRange: number | null }
interface Ok {
  status: 'ok'; method: string; confidence: 'low' | 'medium' | 'high'; backtest: Backtest; weeksOfHistory: number;
  history: { week: string; positions: number }[];
  forecast: { week: string; expected: number; low: number; high: number; alreadyPosted: number; expectedUnfilled: number | null }[];
}
interface Insufficient { status: 'insufficient_history'; reason: string; history: { week: string; positions: number }[] }
type Result = Ok | Insufficient;
interface Data { generatedAt: string; horizonWeeks: number; currentWeek: string; recentFillRate: number | null; overall: Result; byProfession: (Result & { profession: string })[] }

const CONFIDENCE: Record<string, { tone: 'warning' | 'info' | 'success'; text: string }> = {
  low: { tone: 'warning', text: 'Low confidence: short or erratic history. Treat as a rough guide.' },
  medium: { tone: 'info', text: 'Medium confidence.' },
  high: { tone: 'success', text: 'Higher confidence: a long, fairly steady history.' },
};

interface PoolSummary { professions: { profession: string; members: number | null; label: string }[] }

/** Demand needs supply: how many professionals are in the regional pools the organization participates in. */
function PoolCapacity({ orgId }: { orgId: string }) {
  const regions = useApi<{ regions: { id: string; name: string; participation: string | null }[] }>(`/organizations/${orgId}/exchange/regions`);
  const active = regions.data?.regions.filter((r) => r.participation === 'active') ?? [];
  const first = active[0];
  const summary = useApi<PoolSummary>(first ? `/organizations/${orgId}/exchange/pool/summary` : null, { regionId: first?.id });
  if (!first) {
    return <Card title="Float pool capacity"><p className="muted">Join your region’s exchange to see how many professionals are available to cover expected demand. <a href={`/facility/${orgId}/exchange`}>Regional exchange</a></p></Card>;
  }
  return (
    <Card title={`Float pool capacity: ${first.name}`}>
      <p className="muted small">Professionals who have opted in to this region’s pool, by profession. Counts under {5} are not shown so a handful of people cannot be inferred. Being in the pool is not a guarantee of availability for any one shift.</p>
      <QueryBoundary state={summary}>
        {(d) => d.professions.length === 0 ? <p className="muted">No one has joined this pool yet.</p> : <BarList rows={d.professions.map((p) => ({ name: p.profession, value: p.members ?? 0, label: p.members === null ? p.label : p.label }))} />}
      </QueryBoundary>
    </Card>
  );
}

export default function ForecastPage() {
  const { org } = useOrg();
  const [horizon, setHorizon] = useState('8');
  const state = useApi<Data>(`/organizations/${org.id}/forecast`, { horizon });
  return (
    <>
      <ChartStyles />
      <PageHeader title="Demand forecast" subtitle="How many staff positions you are likely to need in the coming weeks, based on your own shift history." />
      <Alert tone="info" title="An estimate, not a promise">
        This is a statistical projection from the shifts you have posted. It cannot know about new contracts, closures, seasonal surges or policy changes, and it does not model seasons. Use the range, not just the middle number, and plan around what you already know.
      </Alert>
      <SelectField label="Look ahead" name="horizon" value={horizon} onChange={setHorizon} options={[{ value: '4', label: '4 weeks' }, { value: '8', label: '8 weeks' }, { value: '12', label: '12 weeks' }]} />
      <QueryBoundary state={state}>
        {(d) => {
          const o = d.overall;
          if (o.status !== 'ok') {
            return <Alert tone="warning" title="Not enough history to forecast yet">{o.reason} Forecasts appear once you have posted shifts over a couple of months. The longer the history, the better the forecast.</Alert>;
          }
          const bars: ForecastBar[] = [
            ...o.history.slice(-26).map((h) => ({ week: h.week, past: h.positions })),
            ...o.forecast.map((f) => ({ week: f.week, expected: f.expected, low: f.low, high: f.high, posted: f.alreadyPosted })),
          ];
          const next4 = o.forecast.slice(0, 4);
          const c = CONFIDENCE[o.confidence]!;
          const bt = o.backtest;
          const ok = d.byProfession.filter((p): p is Ok & { profession: string } => p.status === 'ok');
          return (
            <>
              <div className="grid">
                <StatTile label="Expected next 4 weeks" value={Math.round(next4.reduce((s, f) => s + f.expected, 0))} note="Positions needed, including what is already posted" />
                <StatTile label="Busiest coming week" value={Math.max(...o.forecast.map((f) => f.expected))} note={`Week of ${o.forecast.reduce((a, b) => (b.expected > a.expected ? b : a)).week}`} />
                <StatTile label="Expected to go unfilled" value={o.forecast[0]!.expectedUnfilled === null ? '—' : Math.round(next4.reduce((s, f) => s + (f.expectedUnfilled ?? 0), 0))} note={d.recentFillRate === null ? 'Needs more recent shifts to estimate' : `Next 4 weeks, at your recent fill rate of ${d.recentFillRate}%`} />
                <StatTile label="Confidence" value={titleCase(o.confidence)} note={`${o.weeksOfHistory} weeks of history`} />
              </div>
              <Alert tone={c.tone}>{c.text}</Alert>

              <ChartCard title="Positions needed per week" subtitle="Past weeks, then the forecast. The line on each forecast column is the likely range."
                table={<DataTable caption="Forecast by week" rows={o.forecast} rowKey={(f) => f.week} columns={[
                  { header: 'Week of', cell: (f) => f.week }, { header: 'Expected', cell: (f) => f.expected }, { header: 'Likely range', cell: (f) => `${f.low}–${f.high}` },
                  { header: 'Already posted', cell: (f) => f.alreadyPosted }, { header: 'Expected unfilled', cell: (f) => (f.expectedUnfilled === null ? '—' : f.expectedUnfilled) },
                ]} />}>
                <ForecastChart bars={bars} caption="Positions needed per week, past and forecast" />
              </ChartCard>

              <Card title="How accurate has this been?">
                <p>{o.method}</p>
                {bt.weeks === 0 ? <p className="muted">There is not yet enough history to test it on past weeks.</p> : (
                  <p>
                    Tested on your last {bt.weeks} weeks (each predicted using only the weeks before it), it was off by about <strong>{bt.meanAbsoluteError} positions</strong> a week
                    {bt.typicalErrorShare !== null && <> (roughly <strong>{Math.round(bt.typicalErrorShare * 100)}%</strong> of your average weekly demand)</>}.
                    {bt.withinRange !== null && <> The actual number fell inside the stated range <strong>{percent(Math.round(bt.withinRange * 100))}</strong> of the time; the range is meant to hold about 80%.</>}
                  </p>
                )}
                <p className="small muted">Positions already posted for a week are treated as a minimum. “Expected to go unfilled” applies your fill rate over the last 12 weeks to the expected demand.</p>
              </Card>

              <PoolCapacity orgId={org.id} />

              <ChartCard title="By profession" subtitle="Expected positions over the next 4 weeks for your busiest professions."
                table={<DataTable caption="Forecast by profession" rows={d.byProfession} rowKey={(p) => p.profession} columns={[
                  { header: 'Profession', cell: (p) => p.profession },
                  { header: 'Next 4 weeks (expected)', cell: (p) => (p.status === 'ok' ? Math.round(p.forecast.slice(0, 4).reduce((s, f) => s + f.expected, 0)) : '—') },
                  { header: 'Confidence', cell: (p) => (p.status === 'ok' ? <Badge tone={CONFIDENCE[p.confidence]!.tone}>{titleCase(p.confidence)}</Badge> : <span className="muted small">{p.reason}</span>) },
                ]} />}>
                <BarList rows={ok.map((p) => { const t = Math.round(p.forecast.slice(0, 4).reduce((s, f) => s + f.expected, 0)); return { name: p.profession, value: t, label: `${t} · ${p.confidence} confidence` }; })} />
                {d.byProfession.length > ok.length && <p className="small muted">{d.byProfession.length - ok.length} profession(s) do not have enough history to forecast on their own.</p>}
              </ChartCard>
            </>
          );
        }}
      </QueryBoundary>
    </>
  );
}
