'use client';
import { AssistantChat } from '@/components/AssistantChat';
import { useOrg } from '@/lib/org';

export default function AgencyAssistantPage() {
  const { org } = useOrg();
  return (
    <AssistantChat orgId={org.id} kind="agency" title="Assistant"
      suggestions={['How have our submissions done over the last 90 days?', 'Which jobs are open to us right now?', 'How many people are on our roster?']} />
  );
}
