/** Offset (minutes east of UTC) of an IANA time zone at a given instant. */
export function tzOffsetMinutes(date: Date, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return Math.round((asUtc - date.getTime() - date.getMilliseconds()) / 60_000);
}

/**
 * Turns a wall-clock value typed for a facility ("2026-11-02T07:00", from a datetime-local input) into the exact instant
 * in that facility's time zone, as an ISO string with an offset. The browser's own zone is deliberately ignored.
 */
export function zonedTimeToIso(local: string, timeZone: string): string {
  const [d, t] = local.split('T');
  const [y, m, day] = d!.split('-').map(Number);
  const [h, min] = t!.split(':').map(Number);
  const wall = Date.UTC(y!, m! - 1, day!, h!, min!);
  let result = wall - tzOffsetMinutes(new Date(wall), timeZone) * 60_000;
  const second = tzOffsetMinutes(new Date(result), timeZone);            // re-check once: the first guess may sit across a DST change
  result = wall - second * 60_000;
  return new Date(result).toISOString();
}

/** The inverse: an instant shown as the facility's wall-clock "YYYY-MM-DDTHH:mm" for a datetime-local input. */
export function isoToZonedLocal(iso: string, timeZone: string): string {
  const date = new Date(iso);
  const wall = new Date(date.getTime() + tzOffsetMinutes(date, timeZone) * 60_000);
  return wall.toISOString().slice(0, 16);
}
