import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StockStatusBadge } from './stock-status-badge';

// Task 8: the "Auto-archived" sub-badge distinguishes a SYSTEM archive
// (the zero-stock cron, migration 0266) from a manual one.
describe('StockStatusBadge — autoArchived sub-badge', () => {
  it('shows only "Archived" when the item was archived manually', () => {
    render(<StockStatusBadge quantity={0} reorderPoint={0} itemStatus="archived" />);
    expect(screen.getByText('Archived')).toBeInTheDocument();
    expect(screen.queryByText('Auto-archived')).not.toBeInTheDocument();
  });

  it('shows both "Archived" and "Auto-archived" when the system archived it', () => {
    render(
      <StockStatusBadge quantity={0} reorderPoint={0} itemStatus="archived" autoArchived />,
    );
    expect(screen.getByText('Archived')).toBeInTheDocument();
    expect(screen.getByText('Auto-archived')).toBeInTheDocument();
  });

  it('never shows the sub-badge for a non-archived status, even if autoArchived is stale-true', () => {
    render(
      <StockStatusBadge quantity={5} reorderPoint={0} itemStatus="active" autoArchived />,
    );
    expect(screen.queryByText('Auto-archived')).not.toBeInTheDocument();
    expect(screen.getByText('In stock')).toBeInTheDocument();
  });
});
