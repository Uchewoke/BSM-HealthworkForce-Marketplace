import { describe, expect, it } from 'vitest';
import { MIN_TOTAL, MIN_WEEKS, backtest, forecastDemand, predict } from '../src/modules/forecast/model.js';

const flat = (n: number, v: number) => Array.from({ length: n }, () => v);
const ok = (r: ReturnType<typeof forecastDemand>) => { if (r.status !== 'ok') throw new Error(`expected ok, got ${r.reason}`); return r; };

describe('demand forecast model', () => {
  it('refuses to guess from too little history', () => {
    const short = forecastDemand(flat(MIN_WEEKS - 1, 5), 8);
    expect(short).toMatchObject({ status: 'insufficient_history' });
    expect(short.status === 'insufficient_history' && short.reason).toMatch(/8 weeks/);
    const quiet = forecastDemand([...flat(MIN_WEEKS + 4, 0), 1, 2], 8);
    expect(quiet).toMatchObject({ status: 'insufficient_history' });
    expect(quiet.status === 'insufficient_history' && quiet.reason).toContain(`${3}`);
    expect(MIN_TOTAL).toBe(10);
    expect(forecastDemand([], 8).status).toBe('insufficient_history');
  });

  it('forecasts a steady series as steady, with no invented uncertainty', () => {
    const r = ok(forecastDemand(flat(20, 4), 6));
    expect(r.points).toHaveLength(6);
    for (const p of r.points) expect(p).toMatchObject({ mean: 4, low: 4, high: 4 });
    expect(r.backtest).toMatchObject({ meanAbsoluteError: 0, typicalErrorShare: 0, withinRange: 1 });
  });

  it('follows a recent rise, but limits how far a trend can run', () => {
    const history = [...flat(8, 2), ...flat(4, 4)];
    const r = ok(forecastDemand(history, 8));
    const means = r.points.map((p) => p.mean);
    expect(means[0]!).toBeGreaterThan(2);
    expect(means[3]!).toBeGreaterThanOrEqual(means[0]!); // the trend builds...
    expect(means[7]!).toBe(means[3]!); // ...then is damped flat rather than extrapolated forever
    expect(Math.max(...means)).toBeLessThanOrEqual(predict(history, 1) * 1.25 + 0.2);
    // A sudden doubling is capped: nothing like a straight-line extrapolation to 8, 16, ...
    expect(Math.max(...means)).toBeLessThan(8);
  });

  it('never forecasts negative demand and follows a fall', () => {
    const r = ok(forecastDemand([...flat(8, 10), 6, 3, 1, 0], 6));
    for (const p of r.points) { expect(p.low).toBeGreaterThanOrEqual(0); expect(p.mean).toBeGreaterThanOrEqual(0); expect(p.high).toBeGreaterThanOrEqual(p.mean); }
    expect(r.points[0]!.mean).toBeLessThan(10);
  });

  it('is less certain further ahead', () => {
    const noisy = [3, 7, 2, 8, 4, 6, 1, 9, 5, 5, 2, 8, 4, 6];
    const r = ok(forecastDemand(noisy, 8));
    const width = r.points.map((p) => p.high - p.low);
    for (let i = 1; i < width.length; i++) expect(width[i]!).toBeGreaterThan(width[i - 1]! - 1e-9);
    expect(width[7]!).toBeGreaterThan(width[0]!);
  });

  it('scores itself honestly on weeks it had not seen', () => {
    const noisy = [3, 7, 2, 8, 4, 6, 1, 9, 5, 5, 2, 8, 4, 6, 3, 7, 5, 4];
    const bt = backtest(noisy);
    expect(bt.weeks).toBe(8);
    expect(bt.meanAbsoluteError).toBeGreaterThan(0);
    expect(bt.typicalErrorShare).toBeGreaterThan(0);
    expect(bt.withinRange).toBeGreaterThanOrEqual(0);
    expect(bt.withinRange).toBeLessThanOrEqual(1);
    expect(backtest([1, 2, 3]).weeks).toBe(0); // not enough history to score anything
  });

  it('labels confidence by history length and how wrong it has been', () => {
    expect(ok(forecastDemand(flat(9, 5), 4)).confidence).toBe('low'); // short history
    expect(ok(forecastDemand(flat(30, 5), 4)).confidence).toBe('high');
    const wild = Array.from({ length: 30 }, (_, i) => (i % 2 ? 20 : 0));
    expect(ok(forecastDemand(wild, 4)).confidence).toBe('low'); // long but unpredictable
  });

  it('is deterministic and does not modify its input', () => {
    const history = [4, 6, 3, 8, 5, 5, 7, 2, 6, 9, 4, 5];
    const copy = [...history];
    const a = forecastDemand(history, 8);
    expect(history).toEqual(copy);
    expect(forecastDemand(history, 8)).toEqual(a);
    expect(ok(a).method).toMatch(/Seasonality is not modelled/);
  });
});
