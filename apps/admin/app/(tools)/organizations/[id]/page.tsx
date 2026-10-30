'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Card, ConfirmButton, DataTable, DefinitionList, ErrorAlert, OrgStatusBadge, PageHeader, QueryBoundary, SelectField, TextArea, Timeline, formatDateTime, titleCase, useAction, useApi, useClient } from '@bsm/ui';

interface Detail {
  organization: { id: string; name: string; legal_name: string | null; contact_email: string | null; contact_phone: string | null; website: string | null; state: string | null; status: string; created_at: string };
  members: { id: string; role: string; email: string; full_name: string; email_verified_at: string | null }[];
  reviews: { id: string; actor_kind: string; from_status: string; to_status: string; reason: string | null; internal_note: string | null; created_at: string; actor_email: string }[];
}

const OPTIONS: Record<string, { to: string; label: string; reason: 'none' | 'required' }[]> = {
  submitted: [{ to: 'under_review', label: 'Start review', reason: 'none' }],
  under_review: [{ to: 'approved', label: 'Approve', reason: 'none' }, { to: 'needs_information', label: 'Request more information', reason: 'required' }, { to: 'rejected', label: 'Reject', reason: 'required' }],
  approved: [{ to: 'suspended', label: 'Suspend', reason: 'required' }],
  suspended: [{ to: 'approved', label: 'Reinstate', reason: 'required' }],
};

function Decision({ d, reload }: { d: Detail; reload: () => Promise<void> }) {
  const client = useClient();
  const options = OPTIONS[d.organization.status] ?? [];
  const [to, setTo] = useState(options[0]?.to ?? '');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const chosen = options.find((o) => o.to === to) ?? options[0];
  const decide = useAction(async () => { await client.post(`/admin/organizations/${d.organization.id}/status`, { to: chosen!.to, reason: reason || undefined, internalNote: note || undefined }); setReason(''); setNote(''); await reload(); });
  if (options.length === 0) return <p className="muted">No decision is available while the organization is {titleCase(d.organization.status).toLowerCase()}.</p>;
  const needsReason = chosen?.reason === 'required';
  return (
    <form onSubmit={(e) => e.preventDefault()} noValidate>
      <ErrorAlert error={decide.error} />
      <SelectField label="Decision" name="to" value={chosen!.to} onChange={setTo} options={options.map((o) => ({ value: o.to, label: o.label }))} />
      <TextArea label={needsReason ? 'Message to the organization (required)' : 'Message to the organization (optional)'} name="reason" value={reason} onChange={setReason} rows={3} maxLength={2000} hint="The organization sees this message." />
      <TextArea label="Internal note (staff only)" name="internalNote" value={note} onChange={setNote} rows={2} maxLength={4000} />
      {(chosen!.to === 'approved') && <Alert tone="info">Approval lets this organization post jobs and see applicants. It records that BSM accepted the submitted profile; it does not independently verify the organization’s licenses or accreditation.</Alert>}
      {needsReason && reason.trim().length < 3
        ? <Button tone="secondary" disabled>{chosen!.label}</Button>
        : <ConfirmButton tone={chosen!.to === 'approved' || chosen!.to === 'under_review' ? 'primary' : 'danger'} label={chosen!.label} message={`${chosen!.label} for ${d.organization.name}? The organization will be notified.`} pending={decide.pending} onConfirm={() => decide.run()} />}
    </form>
  );
}

export default function OrganizationReviewPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<Detail>(`/admin/organizations/${id}`);
  return (
    <>
      <p><Link href="/organizations">← Review queue</Link></p>
      <QueryBoundary state={state}>
        {(d) => (
          <>
            <PageHeader title={d.organization.name} subtitle={<OrgStatusBadge status={d.organization.status} />} />
            <Card title="Decision"><Decision d={d} reload={state.reload} /></Card>
            <Card title="Submitted details">
              <DefinitionList items={[
                ['Legal name', d.organization.legal_name], ['Contact email', d.organization.contact_email], ['Contact phone', d.organization.contact_phone],
                ['Website', d.organization.website], ['State', d.organization.state], ['Created', formatDateTime(d.organization.created_at)],
              ]} />
              <p className="small muted">Viewing this page is recorded in the audit log.</p>
            </Card>
            <Card title="Members">
              <DataTable caption="Organization members" rows={d.members} rowKey={(m) => m.id}
                columns={[{ header: 'Name', cell: (m) => m.full_name }, { header: 'Email', cell: (m) => m.email }, { header: 'Role', cell: (m) => titleCase(m.role) }, { header: 'Email verified', cell: (m) => (m.email_verified_at ? 'Yes' : 'No') }]} />
            </Card>
            <Card title="Review history">
              <Timeline items={d.reviews.map((r) => ({ key: r.id, at: r.created_at, title: `${r.actor_kind === 'platform' ? 'BSM' : 'Organization'} (${r.actor_email}): ${titleCase(r.from_status)} → ${titleCase(r.to_status)}`,
                detail: <>{r.reason && <div>Message: {r.reason}</div>}{r.internal_note && <div className="muted">Internal: {r.internal_note}</div>}</> }))} />
            </Card>
          </>
        )}
      </QueryBoundary>
    </>
  );
}
