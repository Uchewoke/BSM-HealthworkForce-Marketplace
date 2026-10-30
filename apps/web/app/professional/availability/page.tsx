'use client';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, CheckGroup, DAYS, ErrorAlert, PageHeader, QueryBoundary, SelectField, TextField, US_STATE_CODES, centsToDollars, dollarsToCents, useAction, useApi, useClient } from '@bsm/ui';

interface Win { dayOfWeek: number; startTime: string; endTime: string }
const EMPLOYMENT = [{ value: 'permanent', label: 'Permanent' }, { value: 'per_diem', label: 'Per diem' }, { value: 'contract', label: 'Contract' }, { value: 'travel', label: 'Travel' }];
const SHIFTS = [{ value: 'day', label: 'Day' }, { value: 'evening', label: 'Evening' }, { value: 'night', label: 'Night' }, { value: 'weekend', label: 'Weekend' }];

function Availability() {
  const client = useClient();
  const state = useApi<{ windows: Win[] }>('/professionals/me/availability');
  const [wins, setWins] = useState<Win[]>([]);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (state.data) setWins(state.data.windows); }, [state.data]);
  const save = useAction(async () => { await client.put('/professionals/me/availability', { windows: wins }); setSaved(true); await state.reload(); });
  const update = (i: number, patch: Partial<Win>) => { setSaved(false); setWins(wins.map((w, j) => (j === i ? { ...w, ...patch } : w))); };
  return (
    <Card title="Weekly availability">
      <p className="muted">When you are generally available. Times are interpreted in the time zone of each facility. A window that ends earlier than it starts continues overnight (for example 19:00–07:00).</p>
      <QueryBoundary state={state}>
        {() => (
          <form onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
            <ErrorAlert error={save.error} />
            {saved && <Alert tone="success">Availability saved.</Alert>}
            <div className="weekgrid">
              {DAYS.map((day, d) => (
                <div key={day} className="day">
                  <strong>{day}</strong>
                  {wins.map((w, i) => w.dayOfWeek !== d ? null : (
                    <div key={i} className="stack" style={{ marginTop: 8 }}>
                      <TextField label={`${day} start`} name={`start-${i}`} type="time" value={w.startTime} onChange={(v) => update(i, { startTime: v })} />
                      <TextField label={`${day} end`} name={`end-${i}`} type="time" value={w.endTime} onChange={(v) => update(i, { endTime: v })} />
                      <Button tone="secondary" onClick={() => { setSaved(false); setWins(wins.filter((_, j) => j !== i)); }}>Remove</Button>
                    </div>
                  ))}
                  <div style={{ marginTop: 8 }}><Button tone="secondary" onClick={() => { setSaved(false); setWins([...wins, { dayOfWeek: d, startTime: '07:00', endTime: '19:00' }]); }}>Add window</Button></div>
                </div>
              ))}
            </div>
            <p><Button type="submit" pending={save.pending}>Save availability</Button></p>
          </form>
        )}
      </QueryBoundary>
    </Card>
  );
}

function Preferences() {
  const client = useClient();
  const state = useApi<{ preferences: null | { employment_types: string[]; shift_types: string[]; preferred_states: string[]; max_travel_miles: number | null; min_hourly_rate_cents: number | null; available_from: string | null } }>('/professionals/me/preferences');
  const [f, setF] = useState({ employmentTypes: [] as string[], shiftTypes: [] as string[], preferredStates: [] as string[], maxTravelMiles: '', minRate: '', availableFrom: '' });
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const p = state.data?.preferences;
    if (p) setF({ employmentTypes: p.employment_types, shiftTypes: p.shift_types, preferredStates: p.preferred_states, maxTravelMiles: p.max_travel_miles?.toString() ?? '', minRate: centsToDollars(p.min_hourly_rate_cents), availableFrom: p.available_from?.slice(0, 10) ?? '' });
  }, [state.data]);
  const save = useAction(async () => {
    await client.put('/professionals/me/preferences', {
      employmentTypes: f.employmentTypes, shiftTypes: f.shiftTypes, preferredStates: f.preferredStates,
      maxTravelMiles: f.maxTravelMiles ? Number(f.maxTravelMiles) : undefined, minHourlyRateCents: dollarsToCents(f.minRate), availableFrom: f.availableFrom || undefined,
    });
    setSaved(true);
  });
  const touch = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => { setSaved(false); setF({ ...f, [k]: v }); };
  return (
    <Card title="Work preferences">
      <QueryBoundary state={state}>
        {() => (
          <form onSubmit={(e) => { e.preventDefault(); void save.run(); }} noValidate>
            <ErrorAlert error={save.error} />
            {saved && <Alert tone="success">Preferences saved.</Alert>}
            <CheckGroup legend="Types of work" options={EMPLOYMENT} value={f.employmentTypes} onChange={(v) => touch('employmentTypes', v)} />
            <CheckGroup legend="Shifts" options={SHIFTS} value={f.shiftTypes} onChange={(v) => touch('shiftTypes', v)} />
            <CheckGroup legend="States where you would work" options={US_STATE_CODES.map((s) => ({ value: s, label: s }))} value={f.preferredStates} onChange={(v) => touch('preferredStates', v)} />
            <div className="form-grid">
              <TextField label="Maximum travel (miles)" name="maxTravelMiles" type="number" min={0} max={3000} value={f.maxTravelMiles} onChange={(v) => touch('maxTravelMiles', v)} error={save.error} />
              <TextField label="Minimum hourly pay ($)" name="minHourlyRateCents" type="number" min={0} step="0.01" value={f.minRate} onChange={(v) => touch('minRate', v)} error={save.error} hint="Private: never shown to facilities in search. Used only to compare against job pay when ranking eligible applicants." />
              <TextField label="Available from" name="availableFrom" type="date" value={f.availableFrom} onChange={(v) => touch('availableFrom', v)} error={save.error} />
            </div>
            <Button type="submit" pending={save.pending}>Save preferences</Button>
          </form>
        )}
      </QueryBoundary>
    </Card>
  );
}

export default function AvailabilityPage() {
  return (<><PageHeader title="Availability & preferences" /><Availability /><Preferences /></>);
}
