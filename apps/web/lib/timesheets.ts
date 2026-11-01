export const TIMESHEET_TONE: Record<string, 'neutral' | 'info' | 'success' | 'warning'> = { submitted: 'info', returned: 'warning', approved: 'success' };
export const hoursText = (minutes: number) => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
/** `datetime-local` value (local time, no offset) for an ISO instant. */
export const toLocalInput = (iso: string) => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
/** ISO instant from a `datetime-local` value, interpreted in the user's own time zone. */
export const fromLocalInput = (v: string) => new Date(v).toISOString();
