'use client';
import { useState } from 'react';
import { Card, CheckField, ConfirmButton, DataTable, ErrorAlert, PageHeader, QueryBoundary, SelectField, TextArea, TextField, US_STATE_CODES, formatDate, useAction, useApi, useClient } from '@bsm/ui';

interface Edu { id: string; institution: string; degree: string; field_of_study: string | null; start_year: number | null; end_year: number | null }
interface Exp { id: string; employer: string; title: string; city: string | null; state: string | null; start_date: string; end_date: string | null; is_current: boolean }

function Education() {
  const client = useClient();
  const list = useApi<{ education: Edu[] }>('/professionals/me/education');
  const [f, setF] = useState({ institution: '', degree: '', fieldOfStudy: '', startYear: '', endYear: '' });
  const add = useAction(async () => {
    await client.post('/professionals/me/education', {
      institution: f.institution, degree: f.degree, fieldOfStudy: f.fieldOfStudy || undefined,
      startYear: f.startYear ? Number(f.startYear) : undefined, endYear: f.endYear ? Number(f.endYear) : undefined,
    });
    setF({ institution: '', degree: '', fieldOfStudy: '', startYear: '', endYear: '' }); await list.reload();
  });
  const remove = useAction(async (id: string) => { await client.delete(`/professionals/me/education/${id}`); await list.reload(); });
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  return (
    <Card title="Education">
      <QueryBoundary state={list}>
        {(d) => <DataTable caption="Education" rows={d.education} rowKey={(e) => e.id} empty={<p className="muted">No education added yet.</p>}
          columns={[
            { header: 'School', cell: (e) => e.institution }, { header: 'Degree', cell: (e) => `${e.degree}${e.field_of_study ? `, ${e.field_of_study}` : ''}` },
            { header: 'Years', cell: (e) => [e.start_year, e.end_year].filter(Boolean).join('–') || '—' },
            { header: 'Actions', cell: (e) => <ConfirmButton label="Remove" message={`Remove ${e.institution} from your profile?`} onConfirm={() => remove.run(e.id)} /> },
          ]} />}
      </QueryBoundary>
      <ErrorAlert error={remove.error} />
      <h3>Add education</h3>
      <form onSubmit={(e) => { e.preventDefault(); void add.run(); }} noValidate>
        <ErrorAlert error={add.error} />
        <div className="form-grid">
          <TextField label="School" name="institution" required value={f.institution} onChange={set('institution')} error={add.error} />
          <TextField label="Degree" name="degree" required value={f.degree} onChange={set('degree')} error={add.error} />
          <TextField label="Field of study" name="fieldOfStudy" value={f.fieldOfStudy} onChange={set('fieldOfStudy')} error={add.error} />
          <TextField label="Start year" name="startYear" type="number" value={f.startYear} onChange={set('startYear')} min={1940} max={2100} error={add.error} />
          <TextField label="End year" name="endYear" type="number" value={f.endYear} onChange={set('endYear')} min={1940} max={2100} error={add.error} />
        </div>
        <button type="submit" className="btn" disabled={add.pending || !f.institution || !f.degree}>{add.pending ? 'Adding…' : 'Add education'}</button>
      </form>
    </Card>
  );
}

function Experience() {
  const client = useClient();
  const list = useApi<{ experience: Exp[] }>('/professionals/me/experience');
  const empty = { employer: '', title: '', city: '', state: '', startDate: '', endDate: '', isCurrent: false, description: '' };
  const [f, setF] = useState(empty);
  const add = useAction(async () => {
    await client.post('/professionals/me/experience', {
      employer: f.employer, title: f.title, city: f.city || undefined, state: f.state || undefined, startDate: f.startDate,
      endDate: f.isCurrent ? undefined : (f.endDate || undefined), isCurrent: f.isCurrent, description: f.description || undefined,
    });
    setF(empty); await list.reload();
  });
  const remove = useAction(async (id: string) => { await client.delete(`/professionals/me/experience/${id}`); await list.reload(); });
  const set = (k: keyof typeof empty) => (v: string) => setF({ ...f, [k]: v });
  return (
    <Card title="Work experience">
      <p className="small muted">Your employers are not shown to facilities that find you in search. They are shown only to a facility whose job you apply to.</p>
      <QueryBoundary state={list}>
        {(d) => <DataTable caption="Work experience" rows={d.experience} rowKey={(e) => e.id} empty={<p className="muted">No experience added yet.</p>}
          columns={[
            { header: 'Employer', cell: (e) => e.employer }, { header: 'Title', cell: (e) => e.title },
            { header: 'Dates', cell: (e) => `${formatDate(e.start_date)} – ${e.is_current ? 'present' : formatDate(e.end_date)}` },
            { header: 'Actions', cell: (e) => <ConfirmButton label="Remove" message={`Remove the role at ${e.employer}?`} onConfirm={() => remove.run(e.id)} /> },
          ]} />}
      </QueryBoundary>
      <ErrorAlert error={remove.error} />
      <h3>Add experience</h3>
      <form onSubmit={(e) => { e.preventDefault(); void add.run(); }} noValidate>
        <ErrorAlert error={add.error} />
        <div className="form-grid">
          <TextField label="Employer" name="employer" required value={f.employer} onChange={set('employer')} error={add.error} />
          <TextField label="Job title" name="title" required value={f.title} onChange={set('title')} error={add.error} />
          <TextField label="City" name="city" value={f.city} onChange={set('city')} error={add.error} />
          <SelectField label="State" name="state" value={f.state} onChange={set('state')} placeholder="—" options={US_STATE_CODES.map((s) => ({ value: s, label: s }))} error={add.error} />
          <TextField label="Start date" name="startDate" type="date" required value={f.startDate} onChange={set('startDate')} error={add.error} />
          {!f.isCurrent && <TextField label="End date" name="endDate" type="date" value={f.endDate} onChange={set('endDate')} error={add.error} />}
        </div>
        <CheckField label="I currently work here" checked={f.isCurrent} onChange={(v) => setF({ ...f, isCurrent: v, endDate: v ? '' : f.endDate })} />
        <TextArea label="Description (optional)" name="description" value={f.description} onChange={set('description')} rows={3} maxLength={4000} error={add.error} />
        <button type="submit" className="btn" disabled={add.pending || !f.employer || !f.title || !f.startDate}>{add.pending ? 'Adding…' : 'Add experience'}</button>
      </form>
    </Card>
  );
}

export default function HistoryPage() {
  return (<><PageHeader title="Education & experience" /><Education /><Experience /></>);
}
