import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ReportProblemButton } from './report-problem-button';

describe('ReportProblemButton', () => {
  it('renders nothing when the module is disabled (no dead affordance in other orgs)', () => {
    const { container } = render(
      <ReportProblemButton moduleEnabled={false} canSubmit prefill={{ itemId: 'i1' }} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('MUTATION SELF-CHECK: renders nothing without maintenance_requests:submit, even with the module enabled', () => {
    const { container } = render(
      <ReportProblemButton moduleEnabled canSubmit={false} prefill={{ itemId: 'i1' }} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when BOTH gates are closed', () => {
    const { container } = render(
      <ReportProblemButton moduleEnabled={false} canSubmit={false} prefill={{}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('links to the new-request form with the related-item prefill', () => {
    render(<ReportProblemButton moduleEnabled canSubmit prefill={{ itemId: 'i1' }} />);
    const link = screen.getByRole('link', { name: 'Report a problem' });
    expect(link).toHaveAttribute('href', '/dashboard/maintenance/new?itemId=i1');
  });

  it('supports order and rental prefill params', () => {
    render(<ReportProblemButton moduleEnabled canSubmit prefill={{ orderRequestId: 'o1' }} />);
    expect(screen.getByRole('link', { name: 'Report a problem' })).toHaveAttribute(
      'href',
      '/dashboard/maintenance/new?orderRequestId=o1',
    );

    render(<ReportProblemButton moduleEnabled canSubmit prefill={{ rentalId: 'r1' }} />);
    expect(screen.getAllByRole('link', { name: 'Report a problem' })[1]).toHaveAttribute(
      'href',
      '/dashboard/maintenance/new?rentalId=r1',
    );
  });

  it('links to the bare new-request form (no query string) when nothing is prefilled', () => {
    render(<ReportProblemButton moduleEnabled canSubmit prefill={{}} />);
    expect(screen.getByRole('link', { name: 'Report a problem' })).toHaveAttribute(
      'href',
      '/dashboard/maintenance/new',
    );
  });

  it('only ever carries DEFINED prefill keys — never an empty/undefined param for a key not passed', () => {
    render(<ReportProblemButton moduleEnabled canSubmit prefill={{ itemId: 'i1', orderRequestId: undefined }} />);
    const href = screen.getByRole('link', { name: 'Report a problem' }).getAttribute('href');
    expect(href).toBe('/dashboard/maintenance/new?itemId=i1');
    expect(href).not.toContain('orderRequestId');
  });

  it('a11y: the accessible name is the visible text alone, so an icon-only future change would need its own label', () => {
    render(<ReportProblemButton moduleEnabled canSubmit prefill={{ itemId: 'i1' }} />);
    expect(screen.getByRole('link', { name: 'Report a problem' }).textContent?.trim()).toBe('Report a problem');
  });
});
