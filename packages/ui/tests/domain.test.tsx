import { render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { describe, expect, it } from 'vitest';
import { ApplicationStatusBadge, CredentialStatusBadge, EligibilityPanel, JobStatusBadge, OrgStatusBadge, RankingBreakdown, credentialLabel, formatPay } from '../src';

describe('credential status is never overstated', () => {
  it('says how a verified credential was checked', () => {
    render(<><CredentialStatusBadge status="verified" method="primary_source" /><CredentialStatusBadge status="verified" method="document_review" /></>);
    expect(screen.getByText('Verified with the primary source')).toBeInTheDocument();
    expect(screen.getByText('Documents reviewed (not verified with the primary source)')).toBeInTheDocument();
  });

  it('shows pending, submitted and expired as exactly that, never as verified', () => {
    for (const [status, text] of [['submitted', 'Submitted, awaiting review'], ['pending_review', 'Pending review'], ['expired', 'Expired'], ['needs_more_information', 'More information needed'], ['revoked', 'Revoked'], ['not_submitted', 'Not submitted']] as const) {
      const { unmount } = render(<CredentialStatusBadge status={status} />);
      expect(screen.getByText(text)).toBeInTheDocument();
      expect(screen.queryByText(/^Verified/)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('never invents a stronger label than the server sent', () => {
    expect(credentialLabel('verified', 'document_review', null)).toMatch(/not verified with the primary source/);
    expect(credentialLabel('verified', null, null)).toMatch(/not verified with the primary source/); // unknown method is treated as the weaker claim
    expect(credentialLabel('pending_review', 'primary_source', null)).toBe('Pending review');
  });

  it('other status badges render readable text', () => {
    render(<><OrgStatusBadge status="needs_information" /><JobStatusBadge status="paused" /><ApplicationStatusBadge status="offer_sent" /></>);
    expect(screen.getByText('Needs information')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.getByText('Offer sent')).toBeInTheDocument();
  });
});

describe('eligibility panel', () => {
  const ineligible = {
    outcome: 'ineligible',
    reasons: [
      { code: 'credential_missing', outcome: 'ineligible', message: 'Required: RN license (GA). No matching credential is on file.' },
      { code: 'specialty_not_listed', outcome: 'needs_review', message: 'The job requires a specialty that is not listed on the profile; a person must review.' },
    ],
    requirements: [
      { requirement: { kind: 'license', credentialType: 'RN', jurisdiction: 'GA', description: null }, result: 'missing', detail: 'No matching credential on file.' },
      { requirement: { kind: 'certification', credentialType: 'BLS', jurisdiction: null, description: null }, result: 'met', detail: 'Documents reviewed; not verified with the primary source.' },
    ],
  };

  it('shows the outcome and every reason: nothing is hidden', () => {
    render(<EligibilityPanel eligibility={ineligible} />);
    expect(screen.getByText('Ineligible')).toBeInTheDocument();
    expect(screen.getByText(/No matching credential is on file/)).toBeInTheDocument();
    expect(screen.getByText(/a person must review/)).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('RN license (GA)')).toBeInTheDocument();
    expect(within(table).getByText('BLS certification')).toBeInTheDocument();
    expect(within(table).getByText('Missing')).toBeInTheDocument();
  });

  it('does not describe a pending person as eligible', () => {
    render(<EligibilityPanel eligibility={{ outcome: 'pending_verification', reasons: [{ code: 'credential_pending', outcome: 'pending_verification', message: 'Required: RN license (GA). It is submitted but not yet verified.' }] }} />);
    expect(screen.getByText('Pending verification')).toBeInTheDocument();
    expect(screen.getByText(/not eligible until credentials are verified/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Eligible$/)).not.toBeInTheDocument();
  });

  it('has no detectable accessibility violations', async () => {
    const { container } = render(<main><EligibilityPanel eligibility={ineligible} /></main>);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('ranking breakdown', () => {
  const ranking = { score: 82.5, factors: [
    { key: 'specialty', label: 'Specialty relevance', weight: 25, value: 1, contribution: 25, note: "The job's specialty is listed on the profile." },
    { key: 'experience', label: 'Experience relevance', weight: 20, value: 0.5, contribution: 10, note: '1 self-reported relevant years against a 2-year reference.' },
  ] };

  it('explains each factor and states that ranking never overrides eligibility', () => {
    render(<RankingBreakdown ranking={ranking} />);
    expect(screen.getByText('Score 82.5 / 100')).toBeInTheDocument();
    expect(screen.getByText(/never overrides eligibility/)).toBeInTheDocument();
    expect(screen.getByText('Specialty relevance')).toBeInTheDocument();
    expect(screen.getByText(/self-reported relevant years/)).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
  });

  it('has no detectable accessibility violations', async () => {
    const { container } = render(<main><RankingBreakdown ranking={ranking} /></main>);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('formatting', () => {
  it('formats pay ranges and missing pay honestly', () => {
    expect(formatPay('hour', 5000, 6500)).toBe('$50.00–$65.00/hr');
    expect(formatPay('year', 8_000_000, 9_500_000)).toBe('$80,000–$95,000/yr');
    expect(formatPay('hour', null, null)).toBe('Not stated');
    expect(formatPay('hour', 4500, 4500)).toBe('$45.00/hr');
  });
});
