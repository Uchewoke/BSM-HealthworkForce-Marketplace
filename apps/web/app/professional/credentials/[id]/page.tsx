'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useRef, useState } from 'react';
import {
  Alert, Button, Card, ConfirmButton, CredentialStatusBadge, DataTable, DefinitionList, ErrorAlert, PageHeader, QueryBoundary, Timeline, formatDate, formatDateTime, titleCase, useAction, useApi, useClient,
} from '@bsm/ui';
import type { Credential } from '../page';

interface Doc { id: string; original_name: string; content_type: string; size_bytes: number; scan_status: string; uploaded_at: string }
interface Detail { credential: Credential; documents: Doc[]; history: { actor_kind: string; from_status: string; to_status: string; method: string | null; reason: string | null; created_at: string }[] }

const EDITABLE = ['not_submitted', 'needs_more_information', 'unable_to_verify'];
const MAX_BYTES = 10 * 1024 * 1024;

function Documents({ id, docs, editable, reload }: { id: string; docs: Doc[]; editable: boolean; reload: () => Promise<void> }) {
  const client = useClient();
  const input = useRef<HTMLInputElement>(null);
  const [clientError, setClientError] = useState('');
  const upload = useAction(async (file: File) => { await client.upload(`/professionals/me/credentials/${id}/documents`, file, file.name); await reload(); });
  const remove = useAction(async (docId: string) => { await client.delete(`/professionals/me/credentials/${id}/documents/${docId}`); await reload(); });
  const open = useAction(async (docId: string) => {
    const r = await client.post<{ url: string }>(`/professionals/me/credentials/${id}/documents/${docId}/access`);
    window.open(new URL(r.url, client.baseUrl).toString(), '_blank', 'noopener');
  });
  const pick = async (file: File | undefined) => {
    setClientError('');
    if (!file) return;
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.type)) { setClientError('Choose a PDF, JPEG or PNG file.'); return; }
    if (file.size > MAX_BYTES) { setClientError('That file is larger than 10 MB.'); return; }
    await upload.run(file);
    if (input.current) input.current.value = '';
  };
  return (
    <Card title="Supporting documents">
      <p className="small muted">Documents are stored privately. Only you and BSM credential reviewers can open them; facilities cannot. Links to open a document expire after one minute.</p>
      <ErrorAlert error={upload.error ?? remove.error ?? open.error} />
      {clientError && <Alert tone="error">{clientError}</Alert>}
      <DataTable caption="Uploaded documents" rows={docs} rowKey={(d) => d.id} empty={<p className="muted">No documents uploaded yet.</p>}
        columns={[
          { header: 'File', cell: (d) => d.original_name }, { header: 'Size', cell: (d) => `${Math.max(1, Math.round(d.size_bytes / 1024))} KB` },
          { header: 'Security scan', cell: (d) => (d.scan_status === 'clean' ? 'Scanned' : 'Not scanned') },
          { header: 'Uploaded', cell: (d) => formatDateTime(d.uploaded_at) },
          { header: 'Actions', cell: (d) => (
            <div className="row">
              <Button tone="secondary" pending={open.pending} onClick={() => void open.run(d.id)}>Open</Button>
              {editable && <ConfirmButton label="Delete" message={`Delete ${d.original_name}?`} onConfirm={() => remove.run(d.id)} />}
            </div>) },
        ]} />
      {editable && (
        <div className="field">
          <label htmlFor="doc-upload">Add a document (PDF, JPEG or PNG, up to 10 MB, at most 5)</label>
          <input id="doc-upload" ref={input} type="file" accept="application/pdf,image/jpeg,image/png" disabled={upload.pending || docs.length >= 5} onChange={(e) => void pick(e.target.files?.[0])} />
          {upload.pending && <span role="status">Uploading…</span>}
        </div>
      )}
    </Card>
  );
}

function Body({ d, reload, id }: { d: Detail; reload: () => Promise<void>; id: string }) {
  const client = useClient();
  const c = d.credential;
  const editable = EDITABLE.includes(c.status);
  const submit = useAction(async () => { await client.post(`/professionals/me/credentials/${id}/submit`); await reload(); });
  const del = useAction(async () => { await client.delete(`/professionals/me/credentials/${id}`); window.location.assign('/professional/credentials'); });
  return (
    <>
      <PageHeader title={`${c.credential_type}${c.jurisdiction ? ` (${c.jurisdiction})` : ''}`} subtitle={<CredentialStatusBadge status={c.effective_status} method={c.verification_method} label={c.status_label} />} />
      {c.effective_status === 'needs_more_information' && c.latest_review_reason && <Alert tone="warning" title="The reviewer asked for more information">{c.latest_review_reason}</Alert>}
      {['rejected', 'unable_to_verify', 'revoked'].includes(c.effective_status) && c.latest_review_reason && <Alert tone="error" title={titleCase(c.effective_status)}>{c.latest_review_reason}</Alert>}
      {c.effective_status === 'expired' && <Alert tone="error" title="Expired">This credential no longer satisfies job requirements. Add the renewed credential as a new entry.</Alert>}
      {c.effective_status === 'verified' && c.verification_method === 'document_review' && <Alert tone="info">A reviewer examined your documents. This is not a check against the issuing authority’s own records, and facilities will see it described that way.</Alert>}
      <Card title="Details">
        <DefinitionList items={[
          ['Kind', titleCase(c.kind)], ['Issuing authority', c.issuing_authority], ['Number', c.number_last4 ? `••••${c.number_last4}` : null],
          ['Issued', formatDate(c.issue_date)], ['Expires', formatDate(c.expiration_date)], ['Verified on', c.effective_status === 'verified' ? formatDate(c.verified_at) : '—'],
        ]} />
        {!editable && <p className="small muted">This credential is under review or complete and can no longer be edited.</p>}
      </Card>
      <Documents id={id} docs={d.documents} editable={editable} reload={reload} />
      {editable && (
        <Card title="Submit for review">
          <ErrorAlert error={submit.error ?? del.error} />
          <p>Upload at least one document, then submit. A reviewer will check it and you will be notified of the outcome.</p>
          <div className="row between">
            <Button pending={submit.pending} disabled={d.documents.length === 0} onClick={() => void submit.run()}>Submit for review</Button>
            {c.status === 'not_submitted' && <ConfirmButton label="Delete credential" message="Delete this credential and its documents? This cannot be undone." pending={del.pending} onConfirm={() => del.run()} />}
          </div>
          {d.documents.length === 0 && <p className="small muted">Add a document to enable submission.</p>}
        </Card>
      )}
      <Card title="History">
        {d.history.length === 0 ? <p className="muted">No review activity yet.</p> : (
          <Timeline items={d.history.map((h, i) => ({ key: String(i), at: h.created_at,
            title: `${h.actor_kind === 'platform' ? 'BSM review' : 'You'}: ${titleCase(h.from_status)} → ${titleCase(h.to_status)}`,
            detail: [h.method && `Method: ${titleCase(h.method)}`, h.reason].filter(Boolean).join(' — ') || undefined }))} />
        )}
      </Card>
    </>
  );
}

export default function CredentialDetailPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<Detail>(`/professionals/me/credentials/${id}`);
  return (<><p><Link href="/professional/credentials">← All credentials</Link></p><QueryBoundary state={state}>{(d) => <Body d={d} reload={state.reload} id={id} />}</QueryBoundary></>);
}
