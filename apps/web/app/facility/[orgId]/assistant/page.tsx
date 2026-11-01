'use client';
import { AssistantChat } from '@/components/AssistantChat';
import { useOrg } from '@/lib/org';

export default function FacilityAssistantPage() {
  const { org } = useOrg();
  return (
    <AssistantChat orgId={org.id} kind="facility" title="Assistant"
      suggestions={['What needs my attention today?', 'How is our fill rate over the last 90 days?', 'Which shifts in the next two weeks still have open positions?', 'Draft a per diem night ICU nurse posting']} />
  );
}
