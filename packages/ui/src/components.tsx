'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { ApiError } from '@bsm/api-client';
import { fieldError, useSession, type ApiState } from './hooks';

/* ---------- feedback ---------- */

export function Alert({ tone = 'info', children, title }: { tone?: 'info' | 'success' | 'warning' | 'error'; children: ReactNode; title?: string }) {
  return (
    <div className={`alert ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {title && <strong>{title}. </strong>}{children}
    </div>
  );
}

/** Shows an API error: the message, plus the request id support can use to find the log line. */
export function ErrorAlert({ error }: { error: ApiError | null | undefined }) {
  if (!error) return null;
  const hasFieldErrors = Object.keys(error.fieldErrors ?? {}).length > 0;
  return (
    <Alert tone="error">
      {hasFieldErrors && error.code === 'VALIDATION_FAILED' ? 'Please correct the highlighted fields.' : error.message}
      {error.requestId && <span className="small muted"> (Reference: {error.requestId})</span>}
    </Alert>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <p role="status" aria-live="polite" className="muted">{label}</p>;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><p><strong>{title}</strong></p>{children && <p>{children}</p>}{action}</div>;
}

/** Renders loading / error / permission-denied / content for a useApi result. */
export function QueryBoundary<T>({ state, children }: { state: ApiState<T>; children: (data: T) => ReactNode }) {
  if (state.loading && !state.data) return <Loading />;
  if (state.error) {
    if (state.error.status === 403) return <Alert tone="warning" title="Not allowed">You do not have permission to view this. {state.error.message}</Alert>;
    if (state.error.status === 404) return <Alert tone="warning" title="Not found">This item does not exist or you cannot access it.</Alert>;
    return <div><ErrorAlert error={state.error} /><button className="btn secondary" onClick={() => void state.reload()}>Try again</button></div>;
  }
  return state.data ? <>{children(state.data)}</> : null;
}

/* ---------- layout ---------- */

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && <div className="row between"><h2>{title}</h2>{actions}</div>}
      {children}
    </section>
  );
}

export function DefinitionList({ items }: { items: [string, ReactNode][] }) {
  return <dl className="dl">{items.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v ?? '—'}</dd></div>)}</dl>;
}

export interface NavItem { href: string; label: string; exact?: boolean }

function useIsActive() {
  const pathname = usePathname() ?? '';
  return (href: string, exact?: boolean) => pathname === href || (!exact && href !== '/' && pathname.startsWith(`${href}/`));
}

export function SideNav({ items, label }: { items: NavItem[]; label: string }) {
  const active = useIsActive();
  return <nav aria-label={label} className="sidenav">{items.map((i) => <Link key={i.href} href={i.href} aria-current={active(i.href, i.exact) ? 'page' : undefined}>{i.label}</Link>)}</nav>;
}

/** Page chrome: skip link, header with navigation, and the main landmark. */
export function AppShell({ brand, nav, children, unreadCount }: { brand: string; nav: NavItem[]; children: ReactNode; unreadCount?: number }) {
  const { user, logout } = useSession();
  const active = useIsActive();
  return (
    <>
      <a href="#main" className="skip-link">Skip to main content</a>
      <header className="app-header">
        <div className="app-header-inner">
          <Link href="/" className="brand">{brand}</Link>
          <nav aria-label="Main" className="nav">
            {nav.map((i) => <Link key={i.href} href={i.href} aria-current={active(i.href) ? 'page' : undefined}>{i.label}{i.href === '/notifications' && unreadCount ? ` (${unreadCount})` : ''}</Link>)}
            {user
              ? <><span className="muted small">{user.email}</span><button className="link" onClick={async () => { await logout(); window.location.assign('/login'); }}>Sign out</button></>
              : <><Link href="/login">Sign in</Link><Link href="/register">Register</Link></>}
          </nav>
        </div>
      </header>
      <main id="main" className="container" tabIndex={-1}>{children}</main>
    </>
  );
}

/** Redirects anonymous visitors to sign-in; optionally requires a platform role + verified MFA. */
export function RequireAuth({ children, platform = false, loginPath = '/login' }: { children: ReactNode; platform?: boolean; loginPath?: string }) {
  const { user, loading } = useSession();
  useEffect(() => {
    if (!loading && !user) window.location.assign(`${loginPath}?next=${encodeURIComponent(window.location.pathname)}`);
  }, [loading, user, loginPath]);
  if (loading || !user) return <Loading label="Checking your session…" />;
  if (platform && !user.platformRole) return <Alert tone="warning" title="Not allowed">This area is for BSM staff.</Alert>;
  if (platform && !user.mfaVerified) {
    return <Alert tone="warning" title="Multi-factor authentication required">Set up or verify MFA to use the admin tools. <Link href="/mfa">Go to MFA setup</Link></Alert>;
  }
  return <>{children}</>;
}

/* ---------- buttons & links ---------- */

type Tone = 'primary' | 'secondary' | 'danger';
const btnClass = (tone: Tone) => `btn${tone === 'secondary' ? ' secondary' : ''}${tone === 'danger' ? ' danger' : ''}`;

export function Button({ tone = 'primary', pending, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; pending?: boolean }) {
  return <button type="button" {...rest} className={btnClass(tone)} disabled={rest.disabled || pending} aria-busy={pending || undefined}>{pending ? 'Working…' : children}</button>;
}

export function LinkButton({ href, tone = 'primary', children }: { href: string; tone?: Tone; children: ReactNode }) {
  return <Link href={href} className={btnClass(tone)}>{children}</Link>;
}

/** Two-step button for consequential actions: the first click asks for explicit confirmation. */
export function ConfirmButton({ label, message, onConfirm, tone = 'danger', pending }: {
  label: string; message: string; onConfirm: () => void | Promise<void>; tone?: Tone; pending?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <Button tone={tone === 'danger' ? 'danger' : tone} onClick={() => setAsking(true)}>{label}</Button>;
  return (
    <div className={`confirm${tone === 'danger' ? '' : ' neutral'}`} role="alertdialog" aria-label={`Confirm: ${label}`}>
      <p style={{ margin: '0 0 8px' }}>{message}</p>
      <div className="row">
        <Button tone={tone} pending={pending} onClick={async () => { await onConfirm(); setAsking(false); }}>Yes, {label.toLowerCase()}</Button>
        <Button tone="secondary" onClick={() => setAsking(false)}>Cancel</Button>
      </div>
    </div>
  );
}

/* ---------- form fields ---------- */

interface FieldBase { label: string; name: string; error?: ApiError | null; hint?: string; required?: boolean }

function FieldShell({ id, label, hint, message, required, children }: { id: string; label: string; hint?: string; message?: string; required?: boolean; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}{required && <span aria-hidden="true"> *</span>}</label>
      {children}
      {hint && <span id={`${id}-hint`} className="hint">{hint}</span>}
      {message && <span id={`${id}-err`} className="error" role="alert">{message}</span>}
    </div>
  );
}
const describedBy = (id: string, hint?: string, message?: string) => [hint && `${id}-hint`, message && `${id}-err`].filter(Boolean).join(' ') || undefined;

export function TextField({ label, name, error, hint, required, value, onChange, type = 'text', ...rest }: FieldBase & {
  value: string; onChange: (v: string) => void; type?: string; placeholder?: string; autoComplete?: string; maxLength?: number; min?: string | number; max?: string | number; step?: string | number; inputMode?: 'numeric' | 'decimal' | 'text';
}) {
  const id = useId(); const message = fieldError(error, name);
  return (
    <FieldShell id={id} label={label} hint={hint} message={message} required={required}>
      <input id={id} name={name} type={type} value={value} onChange={(e) => onChange(e.target.value)} required={required}
        aria-invalid={message ? true : undefined} aria-describedby={describedBy(id, hint, message)} {...rest} />
    </FieldShell>
  );
}

export function TextArea({ label, name, error, hint, required, value, onChange, rows = 4, maxLength }: FieldBase & { value: string; onChange: (v: string) => void; rows?: number; maxLength?: number }) {
  const id = useId(); const message = fieldError(error, name);
  return (
    <FieldShell id={id} label={label} hint={hint} message={message} required={required}>
      <textarea id={id} name={name} rows={rows} value={value} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} required={required}
        aria-invalid={message ? true : undefined} aria-describedby={describedBy(id, hint, message)} />
    </FieldShell>
  );
}

export function SelectField({ label, name, error, hint, required, value, onChange, options, placeholder }: FieldBase & {
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; placeholder?: string;
}) {
  const id = useId(); const message = fieldError(error, name);
  return (
    <FieldShell id={id} label={label} hint={hint} message={message} required={required}>
      <select id={id} name={name} value={value} onChange={(e) => onChange(e.target.value)} required={required}
        aria-invalid={message ? true : undefined} aria-describedby={describedBy(id, hint, message)}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </FieldShell>
  );
}

export function CheckField({ label, checked, onChange, hint, name }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string; name?: string }) {
  const id = useId();
  return (
    <div className="field">
      <div className="check"><input id={id} name={name} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-describedby={hint ? `${id}-hint` : undefined} /><label htmlFor={id}>{label}</label></div>
      {hint && <span id={`${id}-hint`} className="hint">{hint}</span>}
    </div>
  );
}

export function CheckGroup({ legend, options, value, onChange }: { legend: string; options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      <div className="row">
        {options.map((o) => (
          <label key={o.value} className="check">
            <input type="checkbox" checked={value.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((v) => v !== o.value))} />{o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/* ---------- data display ---------- */

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export interface Column<T> { header: string; cell: (row: T) => ReactNode }

export function DataTable<T>({ caption, columns, rows, rowKey, empty }: { caption: string; columns: Column<T>[]; rows: T[]; rowKey: (r: T) => string; empty?: ReactNode }) {
  if (!rows.length) return <>{empty ?? <EmptyState title="Nothing to show yet" />}</>;
  return (
    <div className="table-wrap">
      <table>
        <caption className="visually-hidden">{caption}</caption>
        <thead><tr>{columns.map((c) => <th key={c.header} scope="col">{c.header}</th>)}</tr></thead>
        <tbody>{rows.map((r) => <tr key={rowKey(r)}>{columns.map((c) => <td key={c.header}>{c.cell(r)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <nav className="pagination" aria-label="Pagination">
      <Button tone="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
      <span aria-live="polite">Page {page} of {pages} ({total} total)</span>
      <Button tone="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
    </nav>
  );
}

/* ---------- formatting ---------- */

export const formatDate = (v: string | Date | null | undefined) => (v ? new Date(v).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—');
export function formatDateTime(v: string | Date | null | undefined, timeZone?: string) {
  if (!v) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone, timeZoneName: timeZone ? 'short' : undefined }).format(new Date(v));
}
export function formatPay(unit: string | null, min: number | null, max: number | null) {
  if (min == null && max == null) return 'Not stated';
  const f = (c: number) => `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: unit === 'hour' ? 2 : 0, maximumFractionDigits: unit === 'hour' ? 2 : 0 })}`;
  const per = unit === 'year' ? '/yr' : '/hr';
  return min != null && max != null && min !== max ? `${f(min)}–${f(max)}${per}` : `${f((max ?? min)!)}${per}`;
}
export const centsToDollars = (c: number | null | undefined) => (c == null ? '' : String(c / 100));
export const dollarsToCents = (s: string) => (s.trim() === '' ? undefined : Math.round(Number(s) * 100));
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const US_STATE_CODES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];
