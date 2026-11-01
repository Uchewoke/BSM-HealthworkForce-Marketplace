import { describe, expect, it } from 'vitest';
import { formatDateTime } from '../src';

describe('formatDateTime', () => {
  it('formats in the viewer\'s zone when none is given', () => {
    expect(formatDateTime('2026-11-10T14:00:00Z')).toMatch(/2026/);
    expect(formatDateTime(null)).toBe('—');
  });

  it('formats in a given zone and names it, without throwing (browsers reject dateStyle with timeZoneName)', () => {
    const text = formatDateTime('2026-11-10T14:00:00Z', 'America/New_York');
    expect(text).toMatch(/9:00\s?AM/);
    expect(text).toMatch(/E[SD]T|GMT-5/);
    expect(formatDateTime('2026-07-10T14:00:00Z', 'America/New_York')).toMatch(/10:00\s?AM.*(EDT|GMT-4)/);
    expect(formatDateTime('2026-11-10T14:00:00Z', 'UTC')).toMatch(/2:00\s?PM.*(UTC|GMT)/);
  });
});
