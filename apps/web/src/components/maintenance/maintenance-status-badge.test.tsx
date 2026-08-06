import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MaintenanceStatusBadge } from './maintenance-status-badge';

describe('MaintenanceStatusBadge', () => {
  it('renders the four sanctioned labels and nothing else (brief section 20)', () => {
    const { rerender } = render(<MaintenanceStatusBadge status="saved" />);
    expect(screen.getByText('Saved')).toBeInTheDocument();
    rerender(<MaintenanceStatusBadge status="draft_opened" />);
    expect(screen.getByText('Email draft opened')).toBeInTheDocument();
    rerender(<MaintenanceStatusBadge status="archived" />);
    expect(screen.getByText('Archived')).toBeInTheDocument();
    rerender(<MaintenanceStatusBadge status="cancelled" />);
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });
  it('never renders forbidden phrases', () => {
    render(<MaintenanceStatusBadge status="draft_opened" />);
    for (const banned of ['Email sent', 'Ticket created', 'submitted to Zendesk']) {
      expect(screen.queryByText(banned)).toBeNull();
    }
  });
});
