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

  it('is a menu button named Export whose icons (the download glyph and the chevron) are decorative', () => {
    render(<OrdersExportMenu tab="picking" />);
    const trigger = screen.getByRole('button', { name: 'Export' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveTextContent(/^Export$/);
    const icons = trigger.querySelectorAll('svg');
    expect(icons).toHaveLength(2);
    for (const icon of icons) expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('carries whichever status tab is active', async () => {
    const user = userEvent.setup();
    render(<OrdersExportMenu tab="denied_cancelled" />);

    await user.click(screen.getByRole('button', { name: 'Export' }));

    expect(await screen.findByRole('menuitem', { name: 'Export orders to PDF' })).toHaveAttribute(
      'href',
      '/api/orders/export.pdf?status=denied_cancelled',
    );
  });
});
