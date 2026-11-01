'use client';
import { useState } from 'react';
import { Alert, Badge, Button, Card, ErrorAlert, SelectField, TextArea, TextField, formatDateTime, useAction, useClient } from '@bsm/ui';

export interface RatingSummary { count: number; average: number | null; shown: boolean }

export function RatingText({ rating, who }: { rating: RatingSummary; who: string }) {
  if (rating.average !== null) return <>{rating.average.toFixed(1)} / 5 from {rating.count} review{rating.count === 1 ? '' : 's'}</>;
  return <span className="muted">{rating.count === 0 ? `${who} has no reviews yet.` : `Not enough reviews yet to show an average (${rating.count} so far).`}</span>;
}

const STARS = [5, 4, 3, 2, 1].map((n) => ({ value: String(n), label: `${n} — ${['', 'Poor', 'Fair', 'Good', 'Very good', 'Excellent'][n]}` }));

/** Posts a rating for one completed shift. `path` is the API path that accepts `{ rating, comment }`. */
export function RatingForm({ path, label, onDone }: { path: string; label: string; onDone: () => Promise<void> }) {
  const client = useClient();
  const [rating, setRating] = useState('');
  const [comment, setComment] = useState('');
  const save = useAction(async () => { await client.post(path, { rating: Number(rating), comment: comment.trim() || undefined }); await onDone(); });
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save.run(); }} noValidate>
      <ErrorAlert error={save.error} />
      <SelectField label={label} name="rating" required value={rating} onChange={setRating} options={STARS} placeholder="Choose a rating" error={save.error} />
      <TextArea label="Comment (optional)" name="comment" value={comment} onChange={setComment} rows={3} maxLength={1500} error={save.error}
        hint="Stick to what happened on this shift. Reviews cannot be edited, and the other side can dispute them." />
      <Button type="submit" pending={save.pending} disabled={!rating}>Submit review</Button>
    </form>
  );
}

/** Lets the reviewed party ask BSM staff to look at a review. */
export function DisputeForm({ path, onDone }: { path: string; onDone: () => Promise<void> }) {
  const client = useClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const save = useAction(async () => { await client.post(path, { reason }); setOpen(false); await onDone(); });
  if (!open) return <Button tone="secondary" onClick={() => setOpen(true)}>Dispute this review</Button>;
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save.run(); }} noValidate>
      <ErrorAlert error={save.error} />
      <TextField label="Why should BSM look at this review?" name="reason" required value={reason} onChange={setReason} maxLength={1500} error={save.error} hint="At least 10 characters. The review stays visible until staff decide." />
      <div className="row"><Button type="submit" pending={save.pending} disabled={reason.trim().length < 10}>Send dispute</Button><Button tone="secondary" onClick={() => setOpen(false)}>Cancel</Button></div>
    </form>
  );
}

export interface ReceivedReview { id: string; rating: number; comment: string | null; created_at: string; organization_name?: string; dispute_status: string | null }

export function ReceivedList({ reviews, disputePath, canDispute, reload }: { reviews: ReceivedReview[]; disputePath: (id: string) => string; canDispute: boolean; reload: () => Promise<void> }) {
  if (reviews.length === 0) return <p className="muted">No reviews to show yet. A review appears once the other side has also reviewed, or after the review window closes.</p>;
  return (
    <ul style={{ listStyle: 'none', padding: 0 }}>
      {reviews.map((r) => (
        <li key={r.id}>
          <Card title={`${r.rating} / 5${r.organization_name ? ` · ${r.organization_name}` : ''}`} actions={r.dispute_status ? <Badge tone={r.dispute_status === 'open' ? 'warning' : 'neutral'}>{r.dispute_status === 'open' ? 'Under review by BSM' : `Dispute ${r.dispute_status}`}</Badge> : undefined}>
            <p className="small muted">{formatDateTime(r.created_at)}</p>
            {r.comment ? <p style={{ whiteSpace: 'pre-wrap' }}>{r.comment}</p> : <p className="muted">No comment.</p>}
            {canDispute && !r.dispute_status && <DisputeForm path={disputePath(r.id)} onDone={reload} />}
          </Card>
        </li>
      ))}
    </ul>
  );
}

export const WindowNote = ({ days }: { days: number }) => (
  <Alert tone="info">Reviews are tied to completed shifts with approved hours. You have {days} days after approval to review. Each side’s review stays hidden from the other until both have been submitted or the window closes, so neither is written in reaction to the other.</Alert>
);
