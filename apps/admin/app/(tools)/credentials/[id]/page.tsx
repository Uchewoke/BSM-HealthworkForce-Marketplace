'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Card, ConfirmButton, CredentialStatusBadge, DataTable, DefinitionList, ErrorAlert, PageHeader, QueryBoundary, SelectField, TextArea, TextField, Timeline, formatDate, formatDateTime, titleCase, useAction, useApi, useClient } from '@bsm/ui';

interface Detail {
  credential: {
    id: string; kind: string; credential_type: string; jurisdiction: string | null; issuing_authority: string | null; number: string | null; issue_date: string | null; expiration_date: string | null;
    status: string; effective_status: string; status_label: string; verification_method: string | null; verification_reference: string | null; verified_at: string | null; professional_name: string; profession: string;
  };
  documents: { id: string; original_name: string; content_type: string; size_bytes: number; scan_status: string; uploaded_at: string }[];
  history: { actor_kind: string; from_status: string; to_status: string; method: string | null; source_reference: string | null; reason: string | null; internal_note: string | null; created_at: string; actor_email: string }[];
}

const OPTIONS: Record<string, { to: string; label: string; reason: boolean }[]> = {
  submitted: [{ to: 'pending_review', label: 'Pick up for review', reason: false }],
  pending_review: [
    { to: 'verified', label: 'Mark as verified', reason: false }, { to: 'needs_more_information', label: 'Ask for more information', reason: true },
    { to: 'unable_to_verify', label: 'Unable to verify', reason: true }, { to: 'rejected', label: 'Reject', reason: true },
  ],
  verified: [{ to: 'revoked', label: 'Revoke verification', reason: true }],
};

function Decision({ d, reload }: { d: Detail; reload: () => Promise<void> }) {
  const client = useClient();
  const c = d.credential;
  const options = OPTIONS[c.status] ?? [];
  const [to, setTo] = useState(options[0]?.to ?? '');
  const [method, setMethod] = useState('document_review');
  const [source, setSource] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const chosen = options.find((o) => o.to === to) ?? options[0];
  const decide = useAction(async () => {
    await client.post(`/admin/credentials/${c.id}/status`, {
      to: chosen!.to, method: chosen!.to === 'verified' ? method : undefined, sourceReference: chosen!.to === 'verified' && method === 'primary_source' ? source : undefined,
      reason: reason || undefined, internalNote: note || undefined,
    });
    setReason(''); setNote(''); setSource(''); await reload();
  });
  if (options.length === 0) return <p className="muted">No decision is available for a credential that is {titleCase(c.status).toLowerCase()}.</p>;
  const verifying = chosen!.to === 'verified';
  const incomplete = (chosen!.reason && reason.trim().length < 3) || (verifying && method === 'primary_source' && source.trim().length < 5);
  return (
    <form onSubmit={(e) => e.preventDefault()} noValidate>
      <ErrorAlert error={decide.error} />
      {c.effective_status === 'expired' && <Alert tone="warning">This credential is past its expiration date. It cannot be verified.</Alert>}
      <SelectField label="Decision" name="to" value={chosen!.to} onChange={setTo} options={options.map((o) => ({ value: o.to, label: o.label }))} />
      {verifying && (
        <>
          <SelectField label="How was it verified?" name="method" value={method} onChange={setMethod}
            options={[{ value: 'document_review', label: 'Document review: I examined the uploaded documents' }, { value: 'primary_source', label: 'Primary source: I checked it with the issuing authority or an authorized source' }]} />
          {method === 'primary_source'
            ? <TextField label="Source checked (required)" name="sourceReference" value={source} onChange={setSource} maxLength={500} hint="For example the lookup service, date and reference. Choose primary source only if you actually checked it." />
            : <Alert tone="info">The professional and facilities will see this as “Documents reviewed (not verified with the primary source)”.</Alert>}
        </>
      )}
      {chosen!.reason && <TextArea label="Message to the professional (required)" name="reason" value={reason} onChange={setReason} rows={3} maxLength={2000} hint="The professional sees this message." />}
      <TextArea label="Internal note (staff only)" name="internalNote" value={note} onChange={setNote} rows={2} maxLength={4000} />
      {incomplete ? <Button tone="secondary" disabled>{chosen!.label}</Button>
        : <ConfirmButton tone={chosen!.to === 'verified' || chosen!.to === 'pending_review' ? 'primary' : 'danger'} label={chosen!.label} message={`${chosen!.label}? The professional will be notified.`} pending={decide.pending} onConfirm={() => decide.run()} />}
    </form>
  );
}

function Documents({ d }: { d: Detail }) {
  const client = useClient();
  const open = useAction(async (id: string) => {
    const r = await client.post<{ url: string }>(`/admin/credential-documents/${id}/access`);
    window.open(new URL(r.url, client.baseUrl).toString(), '_blank', 'noopener');
  });
  return (
    <Card title="Documents">
      <ErrorAlert error={open.error} />
      <p className="small muted">Opening a document creates a one-minute link and is recorded in the audit log. Documents have not been malware-scanned unless marked scanned.</p>
      <DataTable caption="Documents" rows={d.documents} rowKey={(x) => x.id} empty={<p className="muted">No documents.</p>}
        columns={[
          { header: 'File', cell: (x) => x.original_name }, { header: 'Type', cell: (x) => x.content_type }, { header: 'Size', cell: (x) => `${Math.max(1, Math.round(x.size_bytes / 1024))} KB` },
          { header: 'Scan', cell: (x) => (x.scan_status === 'clean' ? 'Scanned' : 'Not scanned') }, { header: 'Uploaded', cell: (x) => formatDateTime(x.uploaded_at) },
          { header: 'Actions', cell: (x) => <Button tone="secondary" pending={open.pending} onClick={() => void open.run(x.id)}>Open</Button> },
        ]} />
    </Card>
  );
}

export default function CredentialReviewPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<Detail>(`/admin/credentials/${id}`);
  const [reveal, setReveal] = useState(false);
  return (
    <>
      <p><Link href="/credentials">← Review queue</Link></p>
      <QueryBoundary state={state}>
        {(d) => (
          <>
            <PageHeader title={`${d.credential.credential_type}${d.credential.jurisdiction ? ` (${d.credential.jurisdiction})` : ''}`}
              subtitle={<>{d.credential.professional_name} · {d.credential.profession} · <CredentialStatusBadge status={d.credential.effective_status} method={d.credential.verification_method} label={d.credential.status_label} /></>} />
            <Card title="Decision"><Decision d={d} reload={state.reload} /></Card>
            <Card title="Credential">
              <DefinitionList items={[
                ['Kind', titleCase(d.credential.kind)], ['Issuing authority', d.credential.issuing_authority],
                ['Number', d.credential.number ? (reveal ? <code>{d.credential.number}</code> : <Button tone="secondary" onClick={() => setReveal(true)}>Show number</Button>) : '—'],
                ['Issued', formatDate(d.credential.issue_date)], ['Expires', formatDate(d.credential.expiration_date)],
                ['Verification', d.credential.verification_method ? `${titleCase(d.credential.verification_method)}${d.credential.verification_reference ? ` — ${d.credential.verification_reference}` : ''}` : '—'],
              ]} />
              <p className="small muted">Opening this page was recorded in the audit log. The number is shown to staff so it can be checked against the issuing source, and is never shown to facilities.</p>
            </Card>
            <Documents d={d} />
            <Card title="History">
              <Timeline items={d.history.map((h, i) => ({ key: String(i), at: h.created_at, title: `${h.actor_kind === 'platform' ? 'Reviewer' : 'Professional'} (${h.actor_email}): ${titleCase(h.from_status)} → ${titleCase(h.to_status)}`,
                detail: <>{h.method && <div>Method: {titleCase(h.method)}{h.source_reference ? ` — ${h.source_reference}` : ''}</div>}{h.reason && <div>Message: {h.reason}</div>}{h.internal_note && <div className="muted">Internal: {h.internal_note}</div>}</> }))} />
            </Card>
          </>
        )}
      </QueryBoundary>
    </>
  );
}
