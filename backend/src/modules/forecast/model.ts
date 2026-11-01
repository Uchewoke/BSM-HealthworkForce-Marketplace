/**
 * Weekly demand forecasting. Deliberately simple and explainable: a recency-weighted average of recent weeks, nudged by a
 * damped recent trend, with a range taken from how wrong the same method has actually been on this series. No training,
 * no hidden state: the same history always gives the same forecast. Seasonality is NOT modelled (most organizations have
 * less than a year of history), and the result says so.
 */
/** Twelve weeks: a quarter of history before the forecast speaks at all. Revisit once it has been checked against pilot data. */
export const MIN_WEEKS = 12;
export const MIN_TOTAL = 10;
const LEVEL_WEEKS = 6;
const Z_80 = 1.28; // an 80% range if errors are roughly normal: a guide, not a guarantee

export interface ForecastPoint { week: number; mean: number; low: number; high: number }
export interface Backtest {
  /** Weeks the method was scored on, each predicted using only the weeks before it. */
  weeks: number;
  meanAbsoluteError: number;
  /** Typical miss as a share of average weekly demand (0.2 = about 20% off). Null when there was no demand. */
  typicalErrorShare: number | null;
  /** Share of scored weeks that landed inside the stated range. Null when too few weeks to say. */
  withinRange: number | null;
}
export type Confidence = 'low' | 'medium' | 'high';
export type ForecastResult =
  | { status: 'insufficient_history'; reason: string }
  | { status: 'ok'; method: string; confidence: Confidence; points: ForecastPoint[]; backtest: Backtest; weeksOfHistory: number };

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const stdev = (xs: number[]) => { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)); };
const rmse = (xs: number[]) => Math.sqrt(mean(xs.map((x) => x * x)));

/** Recency-weighted level of the last few weeks (the newest week counts most). */
function level(past: number[]): number {
  const recent = past.slice(-LEVEL_WEEKS);
  const weights = recent.map((_, i) => i + 1);
  return recent.reduce((s, x, i) => s + x * weights[i]!, 0) / weights.reduce((a, b) => a + b, 0);
}

/** Last four weeks against the four before, clipped so one odd month cannot swing the forecast, and damped over four weeks. */
function trendFactor(past: number[], ahead: number): number {
  if (past.length < 8) return 1;
  const ratio = (mean(past.slice(-4)) + 0.5) / (mean(past.slice(-8, -4)) + 0.5);
  const clipped = Math.min(1.25, Math.max(0.8, ratio));
  return clipped ** (Math.min(ahead, 4) / 4);
}

export const predict = (past: number[], ahead: number) => Math.max(0, level(past) * trendFactor(past, ahead));

/** Predict each week from only the weeks before it. */
function walkForward(history: number[]) {
  const out: { index: number; actual: number; predicted: number }[] = [];
  for (let t = LEVEL_WEEKS; t < history.length; t++) out.push({ index: t, actual: history[t]!, predicted: predict(history.slice(0, t), 1) });
  return out;
}

/** The spread of recent one-week-ahead misses. Falls back to the plain variation of the series when there are too few. */
function errorSpread(history: number[], walk: ReturnType<typeof walkForward>): number {
  const errors = walk.slice(-12).map((w) => w.actual - w.predicted);
  return errors.length >= 3 ? rmse(errors) : stdev(history.slice(-8));
}

export function backtest(history: number[]): Backtest {
  const walk = walkForward(history).slice(-8);
  if (walk.length === 0) return { weeks: 0, meanAbsoluteError: 0, typicalErrorShare: null, withinRange: null };
  const mae = mean(walk.map((w) => Math.abs(w.actual - w.predicted)));
  const avg = mean(walk.map((w) => w.actual));
  // Score the range honestly: the spread for week t uses only misses made before t.
  const full = walkForward(history);
  const scored = walk.filter((w) => full.filter((f) => f.index < w.index).length >= 3);
  const inside = scored.filter((w) => {
    const prior = full.filter((f) => f.index < w.index);
    const spread = rmse(prior.slice(-12).map((f) => f.actual - f.predicted));
    return Math.abs(w.actual - w.predicted) <= Z_80 * spread;
  });
  return {
    weeks: walk.length, meanAbsoluteError: round1(mae), typicalErrorShare: avg > 0 ? Math.round((mae / avg) * 100) / 100 : null,
    withinRange: scored.length >= 3 ? Math.round((inside.length / scored.length) * 100) / 100 : null,
  };
}

/**
 * @param history positions needed per COMPLETE week, oldest first (zeros for quiet weeks)
 * @param horizon how many weeks ahead to forecast
 */
export function forecastDemand(history: number[], horizon: number): ForecastResult {
  const total = history.reduce((a, b) => a + b, 0);
  if (history.length < MIN_WEEKS) return { status: 'insufficient_history', reason: `At least ${MIN_WEEKS} weeks of shift history are needed; there are ${history.length}.` };
  if (total < MIN_TOTAL) return { status: 'insufficient_history', reason: `Too little demand to forecast from: ${total} positions in ${history.length} weeks.` };

  const spread = errorSpread(history, walkForward(history));
  const points: ForecastPoint[] = Array.from({ length: horizon }, (_, i) => {
    const h = i + 1;
    const m = predict(history, h);
    const width = Z_80 * spread * (1 + 0.1 * (h - 1)); // less certain the further out
    return { week: h, mean: round1(m), low: round1(Math.max(0, m - width)), high: round1(m + width) };
  });
  const bt = backtest(history);
  const confidence: Confidence = history.length < 16 || (bt.typicalErrorShare ?? 1) > 0.5 ? 'low' : history.length >= 26 && (bt.typicalErrorShare ?? 1) <= 0.25 ? 'high' : 'medium';
  return {
    status: 'ok', confidence, points, backtest: bt, weeksOfHistory: history.length,
    method: `Recency-weighted average of the last ${Math.min(LEVEL_WEEKS, history.length)} weeks with a damped recent trend. Seasonality is not modelled.`,
  };
}
