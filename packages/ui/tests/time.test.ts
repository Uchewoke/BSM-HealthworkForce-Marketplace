import { describe, expect, it } from 'vitest';
import { isoToZonedLocal, tzOffsetMinutes, zonedTimeToIso } from '../src/time';

describe('facility time zones (never the browser zone)', () => {
  it('knows the offset of a zone, including daylight time', () => {
    expect(tzOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-300);
    expect(tzOffsetMinutes(new Date('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(-240);
    expect(tzOffsetMinutes(new Date('2026-07-15T12:00:00Z'), 'America/Phoenix')).toBe(-420); // no DST
    expect(tzOffsetMinutes(new Date('2026-07-15T12:00:00Z'), 'Pacific/Honolulu')).toBe(-600);
  });

  it('turns a facility wall-clock time into the right instant, winter and summer', () => {
    expect(zonedTimeToIso('2026-01-15T07:00', 'America/New_York')).toBe('2026-01-15T12:00:00.000Z');
    expect(zonedTimeToIso('2026-07-15T07:00', 'America/New_York')).toBe('2026-07-15T11:00:00.000Z');
    expect(zonedTimeToIso('2026-07-15T07:00', 'America/Los_Angeles')).toBe('2026-07-15T14:00:00.000Z');
    expect(zonedTimeToIso('2026-07-15T07:00', 'America/Phoenix')).toBe('2026-07-15T14:00:00.000Z');
  });

  it('handles the day daylight saving time starts and ends', () => {
    // US clocks change on 2026-03-08 (spring forward at 02:00) and 2026-11-01 (fall back at 02:00).
    expect(zonedTimeToIso('2026-03-08T01:30', 'America/New_York')).toBe('2026-03-08T06:30:00.000Z'); // still EST
    expect(zonedTimeToIso('2026-03-08T03:30', 'America/New_York')).toBe('2026-03-08T07:30:00.000Z'); // already EDT
    expect(zonedTimeToIso('2026-11-01T00:30', 'America/New_York')).toBe('2026-11-01T04:30:00.000Z'); // EDT
    expect(zonedTimeToIso('2026-11-01T03:30', 'America/New_York')).toBe('2026-11-01T08:30:00.000Z'); // EST
  });

  it('round-trips through the zone', () => {
    for (const [local, tz] of [['2026-02-03T19:00', 'America/Chicago'], ['2026-08-30T06:15', 'America/Denver'], ['2026-12-31T23:45', 'America/Anchorage']] as const) {
      expect(isoToZonedLocal(zonedTimeToIso(local, tz), tz)).toBe(local);
    }
  });
});
