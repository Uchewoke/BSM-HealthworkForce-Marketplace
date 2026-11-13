import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@bsm/api-client';
import { Alert, CheckGroup, ConfirmButton, DataTable, EmptyState, ErrorAlert, LoginForm, MfaSetup, Pagination, QueryBoundary, RequireAuth, SelectField, TextField, safeNextPath } from '../src';
import { fakeClient, renderWithApp, signedOut } from './helpers';

const assign = vi.fn();
beforeEach(() => {
  assign.mockClear();
  Object.defineProperty(window, 'location', { value: { assign, search: '', pathname: '/dashboard' }, writable: true, configurable: true });
});

describe('form fields are accessible', () => {
  function Demo({ error }: { error?: ApiError }) {
    const [v, setV] = useState('');
    const [s, setS] = useState('');
    return (
      <main>
        <TextField label="Legal name" name="legalName" value={v} onChange={setV} required hint="As registered" error={error} />
        <SelectField label="State" name="state" value={s} onChange={setS} placeholder="—" options={[{ value: 'GA', label: 'GA' }]} />
        <CheckGroup legend="Shifts" options={[{ value: 'day', label: 'Day' }]} value={[]} onChange={() => {}} />
      </main>
    );
  }

  it('labels inputs, links hints and server errors, and marks invalid fields', () => {
    const err = new ApiError(422, 'VALIDATION_FAILED', 'Request validation failed.', 'rid', { fieldErrors: { legalName: ['Too short'] } });
    render(<Demo error={err} />);
    const input = screen.getByLabelText(/Legal name/);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(/As registered.*Too short|Too short/s);
    expect(screen.getByRole('alert')).toHaveTextContent('Too short');
    expect(screen.getByRole('group', { name: 'Shifts' })).toBeInTheDocument();
  });

  it('has no detectable accessibility violations, with or without errors', async () => {
    const { container, rerender } = render(<Demo />);
    expect(await axe(container)).toHaveNoViolations();
    rerender(<Demo error={new ApiError(422, 'VALIDATION_FAILED', 'x', 'r', { fieldErrors: { legalName: ['Required'] } })} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('feedback components', () => {
  it('summarizes validation errors and always shows the support reference', () => {
    render(<ErrorAlert error={new ApiError(422, 'VALIDATION_FAILED', 'Request validation failed.', 'req-123', { fieldErrors: { a: ['x'] } })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Please correct the highlighted fields.');
    expect(screen.getByRole('alert')).toHaveTextContent('req-123');
  });

  it('shows loading, permission-denied, not-found and retryable error states', async () => {
    const reload = vi.fn();
    const state = (over: object) => ({ loading: false, reload, ...over }) as any;
    const { rerender } = render(<QueryBoundary state={state({ loading: true })}>{() => <p>content</p>}</QueryBoundary>);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    rerender(<QueryBoundary state={state({ error: new ApiError(403, 'FORBIDDEN', 'Nope.') })}>{() => <p>content</p>}</QueryBoundary>);
    expect(screen.getByText(/do not have permission/i)).toBeInTheDocument();
    rerender(<QueryBoundary state={state({ error: new ApiError(404, 'NOT_FOUND', 'Gone') })}>{() => <p>content</p>}</QueryBoundary>);
    expect(screen.getByText(/does not exist or you cannot access it/i)).toBeInTheDocument();
    rerender(<QueryBoundary state={state({ error: new ApiError(500, 'INTERNAL', 'Boom', 'rid-9') })}>{() => <p>content</p>}</QueryBoundary>);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reload).toHaveBeenCalled();
    rerender(<QueryBoundary state={state({ data: { ok: 1 } })}>{(d: any) => <p>content {d.ok}</p>}</QueryBoundary>);
    expect(screen.getByText('content 1')).toBeInTheDocument();
  });

  it('renders empty states and tables with captions', async () => {
    const { container } = render(<main><EmptyState title="No jobs yet">Create one.</EmptyState><DataTable caption="Jobs" rows={[{ id: '1', t: 'ICU' }]} rowKey={(r) => r.id} columns={[{ header: 'Title', cell: (r) => r.t }]} /><Alert tone="success">Saved.</Alert></main>);
    expect(screen.getByRole('table', { name: 'Jobs' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('paginates with disabled ends', async () => {
    const onPage = vi.fn();
    render(<Pagination page={1} pageSize={10} total={25} onPage={onPage} />);
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPage).toHaveBeenCalledWith(2);
    expect(screen.getByText(/Page 1 of 3/)).toBeInTheDocument();
  });
});

describe('consequential actions need confirmation', () => {
  it('does nothing until confirmed, and cancel backs out', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmButton label="Remove" message="Remove this member?" onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Remove this member?');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await userEvent.click(screen.getByRole('button', { name: /Yes, remove/ }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('sign-in', () => {
  it('only follows safe in-app "next" paths', () => {
    expect(safeNextPath('/facility/abc', '/dashboard')).toBe('/facility/abc');
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil', 'javascript:alert(1)', null, '']) expect(safeNextPath(bad as string, '/dashboard')).toBe('/dashboard');
  });

  it('asks for the authentication code only when the server requires it, then signs in', async () => {
    let attempts = 0;
    const client = fakeClient(({ method, path, body }) => {
      if (path === '/auth/me') return attempts > 0 && body === undefined && assign.mock.calls.length ? { body: { user: { id: 'u', email: 'a@b.co', platformRole: null, mfaVerified: false } } } : { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'x' } } };
      if (path === '/auth/login' && method === 'POST') {
        attempts++;
        if (!body.totpCode) return { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'A verification code is required.', requestId: 'r', details: { mfaRequired: true } } } };
        return { body: { user: { id: 'u', email: 'a@b.co', fullName: 'A' } } };
      }
      return undefined;
    });
    renderWithApp(<LoginForm />, client);
    expect(screen.queryByLabelText(/Authentication code/)).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Email/), 'a@b.co');
    await userEvent.type(screen.getByLabelText(/^Password/), 'a long passphrase here');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const code = await screen.findByLabelText(/Authentication code/);
    expect(screen.getByText(/6-digit code/)).toBeInTheDocument();
    await userEvent.type(code, '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/dashboard'));
    expect(client.calls.filter((c) => c.path === '/auth/login').at(-1)?.body).toMatchObject({ email: 'a@b.co', totpCode: '123456' });
  });

  it('shows a clear error for a wrong password and does not redirect', async () => {
    const client = fakeClient((r) => (r.path === '/auth/me' ? signedOut(r) : r.path === '/auth/login' ? { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'Invalid email or password.', requestId: 'req-77' } } } : undefined));
    renderWithApp(<LoginForm />, client);
    await userEvent.type(screen.getByLabelText(/Email/), 'a@b.co');
    await userEvent.type(screen.getByLabelText(/^Password/), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.');
    expect(assign).not.toHaveBeenCalled();
  });

  it('login form has no detectable accessibility violations', async () => {
    const { container } = renderWithApp(<main><LoginForm registerHref="/register" /></main>, fakeClient(signedOut));
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('route protection in the browser', () => {
  it('sends anonymous visitors to sign in, remembering where they were going', async () => {
    renderWithApp(<RequireAuth><p>secret</p></RequireAuth>, fakeClient(signedOut));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login?next=%2Fprofessional%2Fcredentials') /* the router's path (mocked in setup.ts), not window.location: it excludes any base path */);
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });

  it('keeps staff tools closed to people without a staff role or without MFA', async () => {
    const me = (platformRole: string | null, mfaVerified: boolean) => fakeClient(({ path }) => (path === '/auth/me' ? { body: { user: { id: 'u', email: 'a@b.co', platformRole, mfaVerified } } } : undefined));
    const a = renderWithApp(<RequireAuth platform><p>admin tool</p></RequireAuth>, me(null, false));
    expect(await screen.findByText(/for BSM staff/)).toBeInTheDocument();
    a.unmount();
    const b = renderWithApp(<RequireAuth platform><p>admin tool</p></RequireAuth>, me('platform_admin', false));
    expect(await screen.findByText(/Multi-factor authentication required/)).toBeInTheDocument();
    expect(screen.queryByText('admin tool')).not.toBeInTheDocument();
    b.unmount();
    renderWithApp(<RequireAuth platform><p>admin tool</p></RequireAuth>, me('platform_admin', true));
    expect(await screen.findByText('admin tool')).toBeInTheDocument();
  });
});

describe('MFA enrollment', () => {
  it('shows the key once, then confirms with a code', async () => {
    const client = fakeClient(({ path, method }) => {
      if (path === '/auth/me') return { body: { user: { id: 'u', email: 'a@b.co', platformRole: 'platform_admin', mfaVerified: false } } };
      if (path === '/auth/mfa/setup' && method === 'POST') return { body: { secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://x' } };
      if (path === '/auth/mfa/confirm') return { body: { message: 'ok' } };
      return undefined;
    });
    renderWithApp(<MfaSetup />, client);
    await userEvent.click(screen.getByRole('button', { name: 'Set up authenticator' }));
    expect(await screen.findByLabelText('Setup key')).toHaveTextContent('JBSWY3DPEHPK3PXP');
    await userEvent.type(screen.getByLabelText(/6-digit code/), '654321');
    await userEvent.click(screen.getByRole('button', { name: /Confirm and turn on/ }));
    expect(await screen.findByText(/Multi-factor authentication is on/)).toBeInTheDocument();
    expect(client.calls.find((c) => c.path === '/auth/mfa/confirm')?.body).toEqual({ code: '654321' });
  });
});
