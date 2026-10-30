'use client';
import Link from 'next/link';
import { Alert, CredentialStatusBadge, DataTable, EmptyState, LinkButton, PageHeader, QueryBoundary, formatDate, titleCase, useApi } from '@bsm/ui';

export interface Credential {
  id: string; kind: string; credential_type: string; jurisdiction: string | null; issuing_authority: string | null; number_last4: string | null;
  issue_date: string | null; expiration_date: string | null; status: string; effective_status: string; status_label: string;
  verification_method: string | null; verified_at: string | null; latest_review_reason: string | null;
}

export default function CredentialsPage() {
  const list = useApi<{ credentials: Credential[] }>('/professionals/me/credentials');
  return (
    <>
      <PageHeader title="Licenses & certifications" subtitle="Add each credential, upload supporting documents, and submit it for review."
        actions={<LinkButton href="/professional/credentials/new">Add a credential</LinkButton>} />
      <Alert tone="info">Submitting a credential does not verify it. A BSM reviewer records the outcome, and you will see exactly how it was checked.</Alert>
      <QueryBoundary state={list}>
        {(d) => d.credentials.length === 0 ? <EmptyState title="No credentials yet" action={<LinkButton href="/professional/credentials/new">Add your first credential</LinkButton>}>Most jobs require at least one license.</EmptyState> : (
          <DataTable caption="Your credentials" rows={d.credentials} rowKey={(c) => c.id}
            columns={[
              { header: 'Credential', cell: (c) => <Link href={`/professional/credentials/${c.id}`}>{c.credential_type}{c.jurisdiction ? ` (${c.jurisdiction})` : ''}</Link> },
              { header: 'Type', cell: (c) => titleCase(c.kind) },
              { header: 'Number', cell: (c) => (c.number_last4 ? `••••${c.number_last4}` : '—') },
              { header: 'Expires', cell: (c) => formatDate(c.expiration_date) },
              { header: 'Status', cell: (c) => <CredentialStatusBadge status={c.effective_status} method={c.verification_method} label={c.status_label} /> },
            ]} />
        )}
      </QueryBoundary>
    </>
  );
}
