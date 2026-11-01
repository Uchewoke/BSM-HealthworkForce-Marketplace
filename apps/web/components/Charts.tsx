'use client';
import { useId, useState, type ReactNode } from 'react';
import { Card, DataTable } from '@bsm/ui';

/**
 * Small, dependency-free charts. Colors are the first two slots of the validated categorical palette (blue, orange);
 * single-series charts use blue alone. The app has a light theme only, so only the light values are defined.
 * Every chart has a legend (when it has 2+ series), hover values, and a table view of the same numbers.
 */
const TOKENS = `.viz{--viz-s1:#2a78d6;--viz-s2:#eb6834;--viz-grid:#e1e5eb;--viz-axis:#4a5668;--viz-ink:#1a2433}
.viz-tile{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px}
.viz-tile .v{font-size:1.75rem;font-weight:600;line-height:1.2;color:var(--text)}
.viz-tile .l{color:var(--muted);font-size:.85rem}.viz-tile .n{color:var(--muted);font-size:.8rem;margin-top:2px}
.viz-tip{position:absolute;pointer-events:none;background:#fff;border:1px solid var(--border);border-radius:6px;padding:6px 9px;font-size:.8rem;box-shadow:0 2px 8px rgba(0,0,0,.12);z-index:2;min-width:140px}
.viz-legend{display:flex;gap:16px;flex-wrap:wrap;margin:0 0 8px;padding:0;list-style:none;font-size:.85rem}
.viz-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}
.viz-bar{display:grid;grid-template-columns:minmax(110px,24%) 1fr minmax(70px,auto);gap:10px;align-items:center;padding:3px 0;font-size:.9rem}
.viz-bar .track{height:12px;background:var(--neutral-bg);border-radius:0 4px 4px 0;position:relative}
.viz-bar .fill{height:100%;background:var(--viz-s1);border-radius:0 4px 4px 0}
.viz-bar:focus-within .track,.viz-bar:hover .track{outline:2px solid var(--viz-s1);outline-offset:1px}`;

export function ChartStyles() { return <style>{TOKENS}</style>; }

export function StatTile({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return <div className="viz-tile viz"><div className="l">{label}</div><div className="v">{value}</div>{note && <div className="n">{note}</div>}</div>;
}

export const money = (cents: number) => `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
export const percent = (v: number | null) => (v === null ? '—' : `${v}%`);

/** A card with a table-view toggle: the same numbers as text, for screen readers, print and anyone who prefers them. */
export function ChartCard({ title, subtitle, children, table }: { title: string; subtitle?: string; children: ReactNode; table: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <Card title={title} actions={<button type="button" className="btn secondary" aria-pressed={asTable} onClick={() => setAsTable(!asTable)}>{asTable ? 'View as chart' : 'View as table'}</button>}>
      {subtitle && <p className="muted small" style={{ marginTop: 0 }}>{subtitle}</p>}
      {asTable ? table : children}
    </Card>
  );
}

export interface Series { key: string; label: string }
const SERIES_COLOR = ['var(--viz-s1)', 'var(--viz-s2)'];
const niceMax = (max: number) => {
  if (max <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 2.5, 5, 10].map((m) => m * pow).find((v) => v >= max) ?? max;
};
const shortDate = (iso: string, bucket: 'week' | 'month') => {
  const d = new Date(`${iso}T00:00:00Z`);
  return bucket === 'month' ? d.toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

/** Grouped columns over time (up to two series on ONE axis, same unit). */
export function ColumnChart({ data, series, bucket, unit = '', format = (n) => String(n), caption }: {
  data: { bucket: string }[]; series: Series[]; bucket: 'week' | 'month'; unit?: string; format?: (n: number) => string; caption: string;
}) {
  const id = useId();
  const val = (d: { bucket: string }, key: string) => Number((d as unknown as Record<string, number>)[key] ?? 0);
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = 240, L = 44, R = 8, T = 10, B = 28;
  const max = niceMax(Math.max(0, ...data.flatMap((d) => series.map((s) => val(d, s.key)))));
  const plotW = W - L - R, plotH = H - T - B;
  const group = plotW / Math.max(1, data.length);
  const barW = Math.max(2, Math.min(18, (group - 6) / series.length - 2));
  const y = (v: number) => T + plotH - (v / max) * plotH;
  const ticks = [0, 1, 2, 3, 4].map((i) => (max / 4) * i);
  const every = Math.ceil(data.length / 10);
  const summary = `${caption}. ${data.map((d) => `${shortDate(d.bucket, bucket)}: ${series.map((s) => `${s.label} ${format(val(d, s.key))}`).join(', ')}`).join('; ')}`;
  return (
    <div className="viz" style={{ position: 'relative' }}>
      {series.length > 1 && <ul className="viz-legend" aria-label="Legend">{series.map((s, i) => <li key={s.key}><i style={{ background: SERIES_COLOR[i] }} />{s.label}</li>)}</ul>}
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="group" aria-labelledby={id} onMouseLeave={() => setHover(null)}>
        <title id={id}>{summary}</title>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--viz-grid)" strokeWidth={t === 0 ? 1.5 : 1} />
            <text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--viz-axis)">{format(Math.round(t * 10) / 10)}{unit}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x0 = L + i * group + (group - series.length * (barW + 2)) / 2;
          return (
            <g key={d.bucket}>
              {series.map((s, si) => {
                const v = val(d, s.key);
                const h = (v / max) * plotH;
                return h > 0 ? <rect key={s.key} x={x0 + si * (barW + 2)} y={y(v)} width={barW} height={h} rx={Math.min(4, barW / 2)} fill={SERIES_COLOR[si]} opacity={hover === null || hover === i ? 1 : 0.45} /> : null;
              })}
              {i % every === 0 && <text x={L + i * group + group / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--viz-axis)">{shortDate(d.bucket, bucket)}</text>}
              <rect x={L + i * group} y={T} width={group} height={plotH} fill="transparent" tabIndex={0} role="img" aria-label={`${shortDate(d.bucket, bucket)}: ${series.map((s) => `${s.label} ${format(val(d, s.key))}`).join(', ')}`}
                onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
            </g>
          );
        })}
      </svg>
      {hover !== null && data[hover] && (
        <div className="viz-tip" role="status" style={{ left: `${Math.min(78, Math.max(0, ((L + hover * group) / W) * 100))}%`, top: 24 }}>
          <strong>{bucket === 'week' ? 'Week of ' : ''}{shortDate(data[hover]!.bucket, bucket)}</strong>
          {series.map((s, i) => <div key={s.key}><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: SERIES_COLOR[i], marginRight: 6 }} />{s.label}: {format(val(data[hover]!, s.key))}{unit}</div>)}
        </div>
      )}
    </div>
  );
}

export interface ForecastBar { week: string; past?: number; expected?: number; low?: number; high?: number; posted?: number }

/**
 * Past demand (blue columns) followed by the forecast (orange columns with a whisker for the likely range).
 * One axis, one unit. The whisker is a range, not a promise: the legend and caption say so.
 */
export function ForecastChart({ bars, caption }: { bars: ForecastBar[]; caption: string }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = 260, L = 44, R = 8, T = 10, B = 28;
  const max = niceMax(Math.max(0, ...bars.flatMap((b) => [b.past ?? 0, b.high ?? 0, b.expected ?? 0])));
  const plotW = W - L - R, plotH = H - T - B;
  const group = plotW / Math.max(1, bars.length);
  const barW = Math.max(3, Math.min(20, group - 4));
  const y = (v: number) => T + plotH - (v / max) * plotH;
  const firstForecast = bars.findIndex((b) => b.expected !== undefined);
  const every = Math.ceil(bars.length / 10);
  const label = (b: ForecastBar) => b.expected !== undefined
    ? `Week of ${shortDate(b.week, 'week')}: expected ${b.expected}, likely ${b.low} to ${b.high}${b.posted ? `, ${b.posted} already posted` : ''}`
    : `Week of ${shortDate(b.week, 'week')}: ${b.past ?? 0} positions needed`;
  return (
    <div className="viz" style={{ position: 'relative' }}>
      <ul className="viz-legend" aria-label="Legend">
        <li><i style={{ background: 'var(--viz-s1)' }} />Positions needed (past)</li>
        <li><i style={{ background: 'var(--viz-s2)' }} />Forecast (expected)</li>
        <li><span aria-hidden="true" style={{ display: 'inline-block', width: 2, height: 12, background: 'var(--viz-ink)', marginRight: 8, verticalAlign: 'middle' }} />Likely range</li>
      </ul>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="group" aria-labelledby={id} onMouseLeave={() => setHover(null)}>
        <title id={id}>{`${caption}. ${bars.map(label).join('; ')}`}</title>
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line x1={L} x2={W - R} y1={y((max / 4) * i)} y2={y((max / 4) * i)} stroke="var(--viz-grid)" strokeWidth={i === 0 ? 1.5 : 1} />
            <text x={L - 6} y={y((max / 4) * i) + 4} textAnchor="end" fontSize="11" fill="var(--viz-axis)">{Math.round((max / 4) * i * 10) / 10}</text>
          </g>
        ))}
        {firstForecast > 0 && (
          <g>
            <line x1={L + firstForecast * group} x2={L + firstForecast * group} y1={T} y2={T + plotH} stroke="var(--viz-axis)" strokeDasharray="4 4" />
            <text x={L + firstForecast * group + 6} y={T + 12} fontSize="11" fill="var(--viz-axis)">Forecast →</text>
          </g>
        )}
        {bars.map((b, i) => {
          const cx = L + i * group + group / 2;
          const v = b.expected ?? b.past ?? 0;
          const h = (v / max) * plotH;
          return (
            <g key={b.week}>
              {h > 0 && <rect x={cx - barW / 2} y={y(v)} width={barW} height={h} rx={Math.min(4, barW / 2)} fill={b.expected !== undefined ? 'var(--viz-s2)' : 'var(--viz-s1)'} opacity={hover === null || hover === i ? 1 : 0.45} />}
              {b.expected !== undefined && b.low !== undefined && b.high !== undefined && (
                <g stroke="var(--viz-ink)" strokeWidth="1.5">
                  <line x1={cx} x2={cx} y1={y(b.low)} y2={y(b.high)} />
                  <line x1={cx - 4} x2={cx + 4} y1={y(b.high)} y2={y(b.high)} />
                  <line x1={cx - 4} x2={cx + 4} y1={y(b.low)} y2={y(b.low)} />
                </g>
              )}
              {i % every === 0 && <text x={cx} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--viz-axis)">{shortDate(b.week, 'week')}</text>}
              <rect x={L + i * group} y={T} width={group} height={plotH} fill="transparent" tabIndex={0} role="img" aria-label={label(b)}
                onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
            </g>
          );
        })}
      </svg>
      {hover !== null && bars[hover] && (
        <div className="viz-tip" role="status" style={{ left: `${Math.min(70, Math.max(0, ((L + hover * group) / W) * 100))}%`, top: 24 }}>
          <strong>Week of {shortDate(bars[hover]!.week, 'week')}</strong>
          {bars[hover]!.expected !== undefined ? (
            <>
              <div>Expected: {bars[hover]!.expected}</div>
              <div>Likely range: {bars[hover]!.low}–{bars[hover]!.high}</div>
              {!!bars[hover]!.posted && <div>Already posted: {bars[hover]!.posted}</div>}
            </>
          ) : <div>Positions needed: {bars[hover]!.past ?? 0}</div>}
        </div>
      )}
    </div>
  );
}

/** Ranked horizontal bars in one hue. `value` sizes the bar; `label` is the text shown at the right. */
export function BarList({ rows, max }: { rows: { name: string; value: number; label: string; title?: string }[]; max?: number }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className="muted">No data for this period.</p>;
  return (
    <div className="viz" role="list">
      {rows.map((r) => (
        <div className="viz-bar" role="listitem" key={r.name} tabIndex={0} title={r.title ?? `${r.name}: ${r.label}`} aria-label={`${r.name}: ${r.label}`}>
          <span>{r.name}</span>
          <span className="track" aria-hidden="true"><span className="fill" style={{ display: 'block', width: `${Math.max(r.value > 0 ? 1.5 : 0, (r.value / top) * 100)}%` }} /></span>
          <span style={{ textAlign: 'right' }}>{r.label}</span>
        </div>
      ))}
    </div>
  );
}

export { DataTable };
