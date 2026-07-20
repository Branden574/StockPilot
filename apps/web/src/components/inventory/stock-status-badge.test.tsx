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

// Mig 0277: items auto-created from an inbound PO that have never
// received stock render "Expected" instead of the misleading
// "Out of stock" pill.
describe('StockStatusBadge — awaitingFirstReceipt ("Expected") pill', () => {
  it('replaces "Out of stock" with "Expected" for an active zero-qty flagged item', () => {
    render(
      <StockStatusBadge quantity={0} reorderPoint={0} itemStatus="active" awaitingFirstReceipt />,
    );
    expect(screen.getByText('Expected')).toBeInTheDocument();
    expect(screen.queryByText('Out of stock')).not.toBeInTheDocument();
  });

  it('renders the verbose detail-page label when expectedVerbose is set', () => {
    render(
      <StockStatusBadge
        quantity={0}
        reorderPoint={0}
        itemStatus="active"
        awaitingFirstReceipt
        expectedVerbose
      />,
    );
    expect(screen.getByText('Expected — awaiting first receipt')).toBeInTheDocument();
  });

  it('an UNFLAGGED zero-qty item still reads "Out of stock" (established items keep today\'s pill)', () => {
    render(<StockStatusBadge quantity={0} reorderPoint={0} itemStatus="active" />);
    expect(screen.getByText('Out of stock')).toBeInTheDocument();
    expect(screen.queryByText('Expected')).not.toBeInTheDocument();
  });

  it('archived status wins over a stale flag — the Archived pill renders, never Expected', () => {
    render(
      <StockStatusBadge quantity={0} reorderPoint={0} itemStatus="archived" awaitingFirstReceipt />,
    );
    expect(screen.getByText('Archived')).toBeInTheDocument();
    expect(screen.queryByText('Expected')).not.toBeInTheDocument();
  });
});
