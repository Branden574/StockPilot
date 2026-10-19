import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ReportMfaCard } from './report-mfa-state';

// The card the locked report gate renders for the MFA step-up. The gate
// chooses the words and the URL (report-pages.gate.test.tsx pins those on
// all 12 report pages); this card must show them as an announced alert with
// the way out as a link.

describe('ReportMfaCard', () => {
  it('is an alert with the given words and its link', () => {
    render(
      <ReportMfaCard
        message="Verify with your authenticator app to open this report."
        href="/signin/mfa?redirect=%2Fdashboard%2Freports%2Fshrinkage"
        actionLabel="Verify now"
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Verify with your authenticator app to open this report.');
    expect(screen.getByRole('link', { name: 'Verify now' })).toHaveAttribute(
      'href',
      '/signin/mfa?redirect=%2Fdashboard%2Freports%2Fshrinkage',
    );
  });

  it('draws on the caution wash, not an error page', () => {
    render(<ReportMfaCard message="m" href="/x" actionLabel="Go" />);
    expect(screen.getByRole('alert').className).toContain('bg-warning-wash');
    expect(screen.queryByRole('heading')).toBeNull();
  });
});
