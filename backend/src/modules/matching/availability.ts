export interface Window { dayOfWeek: number; startTime: string; endTime: string } // HH:MM, endTime <= startTime means overnight

const WEEK = 7 * 1440;
const DAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const hm = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Minute of the week (Sun 00:00 = 0) for an instant, as seen in the given IANA time zone. */
export function localMinuteOfWeek(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  return DAY_INDEX[get('weekday')]! * 1440 + Number(get('hour')) * 60 + Number(get('minute'));
}

/** True when the whole shift lies inside the union of the weekly windows (windows wrap across the week boundary). */
export function shiftWithinAvailability(startsAt: Date, endsAt: Date, timeZone: string, windows: Window[]): boolean {
  const duration = Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000);
  if (duration <= 0 || windows.length === 0) return false;
  const start = localMinuteOfWeek(startsAt, timeZone);
  const intervals: [number, number][] = [];
  for (const w of windows) {
    const s = w.dayOfWeek * 1440 + hm(w.startTime);
    const e = hm(w.endTime) > hm(w.startTime) ? w.dayOfWeek * 1440 + hm(w.endTime) : (w.dayOfWeek + 1) * 1440 + hm(w.endTime);
    for (const shift of [-WEEK, 0, WEEK]) intervals.push([s + shift, e + shift]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  return merged.some(([s, e]) => s <= start && e >= start + duration);
}
