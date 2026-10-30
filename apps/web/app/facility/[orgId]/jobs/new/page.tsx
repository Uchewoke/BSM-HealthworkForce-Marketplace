'use client';
import Link from 'next/link';
import { Alert, Card, PageHeader } from '@bsm/ui';
import { JobForm } from '@/components/JobForm';
import { useOrg } from '@/lib/org';

export default function NewJobPage() {
  const { org, approved, can } = useOrg();
  if (!approved) return <Alert tone="warning">Your organization must be approved before you can create jobs.</Alert>;
  if (!can('jobs.manage')) return <Alert tone="warning">Your role cannot create jobs.</Alert>;
  return (
    <>
      <p><Link href={`/facility/${org.id}/jobs`}>← All jobs</Link></p>
      <PageHeader title="New job" subtitle="Start with the basics. You add requirements and shifts next, then publish." />
      <Card><JobForm orgId={org.id} onSaved={(id) => window.location.assign(`/facility/${org.id}/jobs/${id}`)} /></Card>
    </>
  );
}
