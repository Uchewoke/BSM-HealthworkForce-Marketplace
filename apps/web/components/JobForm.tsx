'use client';
import { useEffect, useState } from 'react';
import { Alert, Button, CheckField, ErrorAlert, SelectField, TextArea, TextField, centsToDollars, dollarsToCents, isoToZonedLocal, titleCase, useAction, useApi, useClient, zonedTimeToIso } from '@bsm/ui';
import { useLocations } from '@/lib/org';

export interface JobData {
  id?: string; title: string; description: string; location_id: string; department_id: string | null; profession_id: string; specialty_id: string | null;
  employment_type: string; pay_unit: string; pay_min_cents: number | null; pay_max_cents: number | null; application_deadline: string | null;
  positions_count: number; min_years_experience: number | null; no_credential_requirements: boolean; status?: string;
}

const blank = {
  title: '', description: '', locationId: '', departmentId: '', professionId: '', specialtyId: '', employmentType: 'per_diem', payUnit: 'hour',
  payMin: '', payMax: '', deadline: '', positionsCount: '1', minYears: '', noCredentialRequirements: false,
};

/**
 * Create or edit a job. After a job leaves draft the server freezes the fields that define what the job is
 * (location, profession, type, pay unit, credential statement); the form shows them read-only so the rule is visible.
 */
export function JobForm({ orgId, job, onSaved }: { orgId: string; job?: JobData; onSaved: (id: string) => void }) {
  const client = useClient();
  const locations = useLocations(orgId);
  const taxonomy = useApi<{ professions: { id: string; name: string; specialties: { id: string; name: string }[] }[] }>('/taxonomies/professions');
  const frozen = !!job && job.status !== 'draft';
  const [f, setF] = useState(blank);
  const [saved, setSaved] = useState(false);

  const loc = locations.locations.find((l) => l.id === f.locationId);
  const depts = useApi<{ departments: { id: string; name: string; active: boolean }[] }>(loc ? `/organizations/${orgId}/facilities/${loc.facilityId}/locations/${loc.id}/departments` : null);
  const specialties = taxonomy.data?.professions.find((p) => p.id === f.professionId)?.specialties ?? [];

  useEffect(() => {
    if (!job || locations.loading) return;
    const tz = locations.locations.find((l) => l.id === job.location_id)?.timezone ?? 'UTC';
    setF({
      title: job.title, description: job.description, locationId: job.location_id, departmentId: job.department_id ?? '', professionId: job.profession_id,
      specialtyId: job.specialty_id ?? '', employmentType: job.employment_type, payUnit: job.pay_unit, payMin: centsToDollars(job.pay_min_cents), payMax: centsToDollars(job.pay_max_cents),
      deadline: job.application_deadline ? isoToZonedLocal(job.application_deadline, tz) : '', positionsCount: String(job.positions_count),
      minYears: job.min_years_experience?.toString() ?? '', noCredentialRequirements: job.no_credential_requirements,
    });
  }, [job, locations.loading, locations.locations]);

  const save = useAction(async () => {
    const tz = loc?.timezone ?? 'UTC';
    const body: Record<string, unknown> = {
      title: f.title, description: f.description, payMinCents: dollarsToCents(f.payMin) ?? null, payMaxCents: dollarsToCents(f.payMax) ?? null,
      applicationDeadline: f.deadline ? zonedTimeToIso(f.deadline, tz) : null, positionsCount: Number(f.positionsCount) || 1,
      minYearsExperience: f.minYears === '' ? null : Number(f.minYears),
    };
    if (!frozen) Object.assign(body, {
      locationId: f.locationId, departmentId: f.departmentId || null, professionId: f.professionId, specialtyId: f.specialtyId || null,
      employmentType: f.employmentType, payUnit: f.payUnit, noCredentialRequirements: f.noCredentialRequirements,
    });
    if (job?.id) { await client.patch(`/organizations/${orgId}/jobs/${job.id}`, body); setSaved(true); onSaved(job.id); }
    else { const r = await client.post<{ job: { id: string } }>(`/organizations/${orgId}/jobs`, body); onSaved(r.job.id); }
  });

  const set = (k: keyof typeof blank) => (v: string) => { setSaved(false); setF({ ...f, [k]: v, ...(k === 'locationId' ? { departmentId: '' } : {}), ...(k === 'professionId' ? { specialtyId: '' } : {}) }); };
  const unit = f.payUnit === 'year' ? 'year' : 'hour';
  const ready = f.title.trim().length >= 3 && f.locationId && f.professionId;
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save.run(); }} noValidate>
      <ErrorAlert error={save.error} />
      {saved && <Alert tone="success">Saved.</Alert>}
      {frozen && <Alert tone="info">This job is {job?.status}. Location, profession, type, pay unit and the credential statement are fixed so applicants are not misled. Pause or close this job and create a new one to change them.</Alert>}
      <TextField label="Job title" name="title" required value={f.title} onChange={set('title')} maxLength={160} error={save.error} />
      <TextArea label="Description" name="description" required value={f.description} onChange={set('description')} rows={6} maxLength={8000} error={save.error}
        hint="Describe the role, unit and schedule. At least 20 characters to publish. Do not include patient information." />
      <fieldset disabled={frozen} style={{ border: 0, padding: 0 }}>
        <div className="form-grid">
          <SelectField label="Location" name="locationId" required value={f.locationId} onChange={set('locationId')} placeholder={locations.loading ? 'Loading…' : 'Choose a location'}
            options={locations.locations.map((l) => ({ value: l.id, label: l.label }))} error={save.error} hint={locations.locations.length === 0 && !locations.loading ? 'Add a location first.' : undefined} />
          <SelectField label="Department (optional)" name="departmentId" value={f.departmentId} onChange={set('departmentId')} placeholder="—"
            options={(depts.data?.departments ?? []).filter((d) => d.active).map((d) => ({ value: d.id, label: d.name }))} error={save.error} />
          <SelectField label="Profession" name="professionId" required value={f.professionId} onChange={set('professionId')} placeholder="Choose…"
            options={(taxonomy.data?.professions ?? []).map((p) => ({ value: p.id, label: p.name }))} error={save.error} />
          <SelectField label="Specialty (optional)" name="specialtyId" value={f.specialtyId} onChange={set('specialtyId')} placeholder="Any"
            options={specialties.map((s) => ({ value: s.id, label: s.name }))} error={save.error} hint="If set, applicants without this specialty are flagged for your review." />
          <SelectField label="Type of work" name="employmentType" required value={f.employmentType} onChange={set('employmentType')}
            options={['permanent', 'per_diem', 'contract', 'travel'].map((v) => ({ value: v, label: titleCase(v) }))} error={save.error} hint="Non-permanent jobs need at least one upcoming shift to publish." />
          <SelectField label="Pay is quoted per" name="payUnit" value={f.payUnit} onChange={set('payUnit')} options={[{ value: 'hour', label: 'Hour' }, { value: 'year', label: 'Year' }]} error={save.error} />
        </div>
      </fieldset>
      <div className="form-grid">
        <TextField label={`Minimum pay ($ per ${unit})`} name="payMinCents" type="number" min={0} step="0.01" value={f.payMin} onChange={set('payMin')} error={save.error} />
        <TextField label={`Maximum pay ($ per ${unit})`} name="payMaxCents" type="number" min={0} step="0.01" value={f.payMax} onChange={set('payMax')} error={save.error} hint="Some states require pay ranges in listings. Check your obligations." />
        <TextField label={`Application deadline${loc ? ` (${loc.timezone})` : ''}`} name="applicationDeadline" type="datetime-local" value={f.deadline} onChange={set('deadline')} error={save.error} />
        <TextField label="Number of openings" name="positionsCount" type="number" min={1} max={500} value={f.positionsCount} onChange={set('positionsCount')} error={save.error} />
        <TextField label="Minimum years of experience (optional)" name="minYearsExperience" type="number" min={0} max={50} value={f.minYears} onChange={set('minYears')} error={save.error} hint="Applicants with less self-reported experience are flagged for your review, not rejected." />
      </div>
      <fieldset disabled={frozen} style={{ border: 0, padding: 0 }}>
        <CheckField label="This job has no mandatory license or certification requirement" checked={f.noCredentialRequirements} onChange={(v) => { setSaved(false); setF({ ...f, noCredentialRequirements: v }); }}
          hint="Otherwise list at least one mandatory license or certification below before publishing." />
      </fieldset>
      <Button type="submit" pending={save.pending} disabled={!ready}>{job?.id ? 'Save changes' : 'Create draft'}</Button>
    </form>
  );
}
