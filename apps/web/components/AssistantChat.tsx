'use client';
import { useRef, useState } from 'react';
import { useOrg } from '@/lib/org';
import { Alert, Badge, Button, Card, DefinitionList, ErrorAlert, LinkButton, Loading, PageHeader, QueryBoundary, TextArea, centsToDollars, titleCase, useAction, useApi, useClient } from '@bsm/ui';

interface Draft {
  title: string; description: string; locationId: string; professionId: string; specialtyId: string | null; employmentType: string; payUnit: 'hour' | 'year';
  payMinCents: number | null; payMaxCents: number | null; positionsCount: number; minYearsExperience: number | null;
}
interface Turn { role: 'user' | 'assistant'; content: string; tools?: string[]; draft?: Draft | null; note?: string }
interface Response { reply: string; toolsUsed: string[]; draft: Draft | null; refused: boolean; incomplete: boolean }

const TOOL_LABELS: Record<string, string> = {
  get_staffing_summary: 'staffing figures', get_pending_work: 'what needs attention', list_jobs: 'your jobs', get_job_setup_options: 'locations and professions', propose_job_draft: 'a job draft',
  get_agency_summary: 'agency figures', list_open_jobs: 'open jobs', get_roster_summary: 'roster counts',
};
const MAX_SENT = 18; // the server accepts 20; leave room for the new question

/** The conversation as the server accepts it: text only, starting with a user message. */
const toApi = (turns: Turn[]) => {
  let t = turns.slice(-MAX_SENT);
  while (t.length && t[0]!.role !== 'user') t = t.slice(1);
  return t.map(({ role, content }) => ({ role, content }));
};

function DraftCard({ orgId, draft }: { orgId: string; draft: Draft }) {
  const client = useClient();
  const { can } = useOrg();
  const create = useAction(async () => {
    const r = await client.post<{ job: { id: string } }>(`/organizations/${orgId}/jobs`, draft);
    window.location.assign(`/facility/${orgId}/jobs/${r.job.id}`);
  });
  const pay = draft.payMinCents != null || draft.payMaxCents != null
    ? `$${centsToDollars(draft.payMinCents ?? draft.payMaxCents)}–$${centsToDollars(draft.payMaxCents ?? draft.payMinCents)} per ${draft.payUnit}` : 'Not stated';
  return (
    <Card title="Draft job posting (not saved)">
      <p className="muted small">The assistant wrote this from what you told it. Read it carefully: nothing exists until you save it, and credential requirements and shifts are added on the job page.</p>
      <DefinitionList items={[['Title', draft.title], ['Type', titleCase(draft.employmentType)], ['Positions', draft.positionsCount], ['Pay', pay], ['Minimum experience', draft.minYearsExperience != null ? `${draft.minYearsExperience} years` : 'Not stated']]} />
      <p style={{ whiteSpace: 'pre-wrap' }}>{draft.description}</p>
      <ErrorAlert error={create.error} />
      {can('jobs.manage') ? <Button pending={create.pending} onClick={() => void create.run()}>Save as a draft job</Button> : <Alert tone="info">Your role can’t create jobs. Ask a hiring manager or admin to use this draft.</Alert>}
    </Card>
  );
}

export function AssistantChat({ orgId, kind, title, suggestions }: { orgId: string; kind: 'facility' | 'agency'; title: string; suggestions: string[] }) {
  const client = useClient();
  const base = kind === 'facility' ? `/organizations/${orgId}/assistant` : `/organizations/${orgId}/agency/assistant`;
  const status = useApi<{ configured: boolean }>(`${base}/status`);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const send = useAction(async (text: string) => {
    const next: Turn[] = [...turns, { role: 'user', content: text }];
    setTurns(next); setInput('');
    const r = await client.post<Response>(base, { messages: toApi(next) });
    setTurns([...next, { role: 'assistant', content: r.reply, tools: r.toolsUsed, draft: r.draft, note: r.refused ? 'The assistant declined this request.' : r.incomplete ? 'The answer may be incomplete.' : undefined }]);
    setTimeout(() => end.current?.scrollIntoView({ block: 'nearest' }), 0);
  });
  const ask = (text: string) => { if (text.trim() && !send.pending) void send.run(text.trim()); };

  return (
    <>
      <PageHeader title={title} subtitle="Ask about your own staffing data in plain language. It reads; it never changes anything." />
      <Alert tone="info" title="Before you rely on it">
        Answers are written by an AI and can be wrong: check anything important against the pages themselves. It looks up figures for your organization only, never sees individual professionals’ names, credentials or documents, and cannot approve, send, publish or decide anything, including whether someone is eligible.
        Your question and the figures it looks up are sent to Anthropic’s Claude service to write the answer.
      </Alert>
      <QueryBoundary state={status}>
        {(s) => !s.configured ? <Alert tone="warning" title="The assistant is not switched on">An administrator needs to add an Anthropic API key to this server before it can answer. Everything else on the site works without it.</Alert> : (
          <>
            {turns.length === 0 && (
              <Card title="Try asking">
                <div className="row">{suggestions.map((q) => <Button key={q} tone="secondary" onClick={() => ask(q)}>{q}</Button>)}</div>
              </Card>
            )}
            <ul style={{ listStyle: 'none', padding: 0 }} aria-live="polite" aria-label="Conversation">
              {turns.map((t, i) => (
                <li key={i}>
                  <Card title={t.role === 'user' ? 'You' : 'Assistant'} actions={t.role === 'assistant' ? <Badge tone="neutral">AI-generated</Badge> : undefined}>
                    <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{t.content}</p>
                    {t.note && <p className="small" style={{ color: 'var(--warning)' }}>{t.note}</p>}
                    {t.tools && t.tools.length > 0 && <p className="small muted">Looked at: {t.tools.map((n) => TOOL_LABELS[n] ?? n).join(', ')}</p>}
                  </Card>
                  {t.draft && kind === 'facility' && <DraftCard orgId={orgId} draft={t.draft} />}
                </li>
              ))}
            </ul>
            {send.pending && <Loading label="Thinking…" />}
            <ErrorAlert error={send.error} />
            <form onSubmit={(e) => { e.preventDefault(); ask(input); }} noValidate>
              <TextArea label="Your question" name="question" value={input} onChange={setInput} rows={3} maxLength={4000} hint="Up to 4,000 characters. Don’t paste personal information about individual people." />
              <div className="row">
                <Button type="submit" pending={send.pending} disabled={!input.trim()}>Ask</Button>
                {turns.length > 0 && <Button tone="secondary" onClick={() => { setTurns([]); send.clearError(); }}>Start over</Button>}
                {kind === 'facility' && <LinkButton tone="secondary" href={`/facility/${orgId}/jobs`}>Go to jobs</LinkButton>}
              </div>
            </form>
            <div ref={end} />
          </>
        )}
      </QueryBoundary>
    </>
  );
}
