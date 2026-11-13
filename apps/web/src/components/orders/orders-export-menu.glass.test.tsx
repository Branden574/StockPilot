import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrdersExportMenu } from './orders-export-menu';

/**
 * The Export menu as Liquid Glass draws it (Orders.dc.html): an icon, the
 * format with the tab it exports and a quieter line under it. Those parts
 * are glass-only words and icons: each item keeps its link, its download and
 * its accessible name, and the menu gains no item.
 */
afterEach(() => vi.unstubAllEnvs());

async function open(tab: string) {
  const user = userEvent.setup();
  render(<OrdersExportMenu tab={tab} />);
  await user.click(screen.getByRole('button', { name: 'Export' }));
  return screen.findByRole('menu');
}

describe('OrdersExportMenu under Liquid Glass', () => {
  it('adds the board’s icon, tab name and sub-line to each item, all glass-only', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const menu = await open('needs_approval');
    const csv = screen.getByRole('menuitem', { name: 'Export orders to CSV' });
    const pdf = screen.getByRole('menuitem', { name: 'Export orders to PDF' });
    expect(csv).toHaveTextContent('CSV · Needs approval');
    expect(csv).toHaveTextContent('Matches the tab you are on');
    expect(pdf).toHaveTextContent('PDF (print) · Needs approval');
    expect(pdf).toHaveTextContent('Printable order history');
    for (const item of [csv, pdf]) {
      expect(item.querySelectorAll('[data-glass-only]')).toHaveLength(3);
      expect(item.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
      expect(item).toHaveAttribute('download');
    }
    // Two items, as in Classic: the glass parts are not actions.
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
  });

  it('the Waiting for signature filter is named too', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    await open('awaiting_signature');
    expect(screen.getByRole('menuitem', { name: 'Export orders to CSV' })).toHaveTextContent(
      'CSV · Waiting for signature',
    );
  });

  it('an unknown tab gets no name, only the sub-line', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    await open('not-a-tab');
    const csv = screen.getByRole('menuitem', { name: 'Export orders to CSV' });
    expect(csv).not.toHaveTextContent('·');
    expect(csv.querySelectorAll('[data-glass-only]')).toHaveLength(2);
  });

  it('under off the items are today’s words only', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'off');
    const menu = await open('needs_approval');
    expect(menu.querySelectorAll('[data-glass-only], svg')).toHaveLength(0);
    expect(screen.getByRole('menuitem', { name: 'Export orders to CSV' }).textContent).toBe('CSV');
    expect(screen.getByRole('menuitem', { name: 'Export orders to PDF' }).textContent).toBe(
      'PDF (print)',
    );
  });
});
