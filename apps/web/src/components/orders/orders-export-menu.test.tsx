import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { OrdersExportMenu } from './orders-export-menu';

describe('OrdersExportMenu', () => {
  it('opens to a CSV item and a PDF item, each downloading the active tab', async () => {
    const user = userEvent.setup();
    render(<OrdersExportMenu tab="picking" />);

    await user.click(screen.getByRole('button', { name: 'Export' }));

    const csv = await screen.findByRole('menuitem', { name: 'Export orders to CSV' });
    expect(csv).toHaveAttribute('href', '/api/orders/export.csv?status=picking');
    expect(csv).toHaveAttribute('download');
    expect(csv).toHaveTextContent('CSV');

    const pdf = screen.getByRole('menuitem', { name: 'Export orders to PDF' });
    expect(pdf).toHaveAttribute('href', '/api/orders/export.pdf?status=picking');
    expect(pdf).toHaveAttribute('download');
    expect(pdf).toHaveTextContent('PDF (print)');
  });

  it('carries whichever status tab is active', async () => {
    const user = userEvent.setup();
    render(<OrdersExportMenu tab="denied_cancelled" />);

    await user.click(screen.getByRole('button', { name: 'Export' }));

    expect(
      await screen.findByRole('menuitem', { name: 'Export orders to PDF' }),
    ).toHaveAttribute('href', '/api/orders/export.pdf?status=denied_cancelled');
  });
});
