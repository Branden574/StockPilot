import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render, within } from '@testing-library/react';
import postcss, { type AtRule, type Rule } from 'postcss';
import type * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OrderRequestSummary } from '@/server/services/order-requests';

import { OrderPhoneCards } from './order-phone-cards';

/**
 * The Orders list's phone cards (Liquid Glass, Orders.dc.html at 760 px and
 * under). Glass-only and stateless: one link per row to the row's own order
 * page, every column's words, and nothing at all under the `off` rollout.
 */
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _prefetch,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(() => vi.unstubAllEnvs());

const NOW = Date.now();
function row(over: Partial<OrderRequestSummary> = {}): OrderRequestSummary {
  return {
    id: 'o1',
    orderNumber: 231,
    status: 'pending_approval',
    warehouseId: 'w1',
    warehouseName: 'North DC',
    requesterUserId: 'u-9',
    requesterEmail: 'pat@example.test',
    requesterName: 'Pat Lee',
    requesterOrgLabel: 'Ridge Academy',
    requesterDeleted: false,
    source: 'internal',
    lineCount: 3,
    totalQuantity: 8,
    notes: null,
    createdAt: new Date(NOW - 3 * 3600_000).toISOString(),
    updatedAt: new Date(NOW - 5 * 60_000).toISOString(),
    approvedAt: null,
    deliveredAt: null,
    fulfillmentType: 'delivery',
    inTransitAt: null,
    assignedPickerId: 'p1',
    assignedPickerName: 'Luis Ortega',
    assignedDeliveryUserId: 'd1',
    assignedDeliveryUserName: 'Sam Reyes',
    replacementForReturnId: null,
    exchange: null,
    ...over,
  } as OrderRequestSummary;
}

describe('OrderPhoneCards', () => {
  it('renders nothing under the off rollout (Classic is today’s markup)', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'off');
    const view = render(<OrderPhoneCards rows={[row()]} />);
    expect(view.container.innerHTML).toBe('');
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '1');
    view.rerender(<OrderPhoneCards rows={[row()]} />);
    expect(view.container.innerHTML).toBe('');
  });

  it('renders nothing for no rows (the page shows its empty state)', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    expect(render(<OrderPhoneCards rows={[]} />).container.innerHTML).toBe('');
  });

  it.each(['opt-in', 'default'] as const)(
    '%s: one glass-only list, named by the page title, with one link per row to its own order',
    (rollout) => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
      const view = render(<OrderPhoneCards rows={[row(), row({ id: 'o2', orderNumber: 232 })]} />);
      const list = view.container.querySelector('ul')!;
      expect(list).toHaveAttribute('data-glass-only');
      expect(list).toHaveAttribute('aria-labelledby', 'orders-title');
      const links = within(list).getAllByRole('link');
      expect(links.map((a) => a.getAttribute('href'))).toEqual([
        '/dashboard/orders/o1',
        '/dashboard/orders/o2',
      ]);
      // Only links: no button, field or other control.
      expect(list.querySelectorAll('button, input, select, textarea')).toHaveLength(0);
    },
  );

  it('prints every column the table prints, so none is lost on a phone', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const view = render(
      <OrderPhoneCards
        rows={[
          row({
            source: 'public_link',
            replacementForReturnId: 'r1',
            exchange: { state: 'Waiting for return' } as OrderRequestSummary['exchange'],
          }),
        ]}
      />,
    );
    const card = view.getByRole('link');
    for (const words of [
      'SO-000231', // Order #
      'Pending', // Status
      'Exchange',
      'Waiting for return',
      'Pat Lee', // Requester
      'Ridge Academy',
      'Public',
      'North DC', // Warehouse
      'Delivery', // Type
      '3 lines', // Lines
      '8 units', // Total qty
      'Picker Luis Ortega', // Picker
      'Driver Sam Reyes', // Driver
      'Requested 3 hours ago', // Requested
      '5 minutes ago', // Last update
    ]) {
      expect(card).toHaveTextContent(words);
    }
  });

  it('says one line and one unit in the singular, and a dash for an unset picker', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const view = render(
      <OrderPhoneCards
        rows={[
          row({
            lineCount: 1,
            totalQuantity: 1,
            fulfillmentType: 'pickup',
            assignedPickerName: null,
          }),
        ]}
      />,
    );
    const card = view.getByRole('link');
    expect(card).toHaveTextContent('1 line · 1 unit');
    expect(card).toHaveTextContent('Pickup');
    expect(card).toHaveTextContent('Picker —');
  });

  // Plan 8.5: glass hides the Orders table (both links on every row) at
  // phone width, so the allowlist declares the cards as replacing those two
  // links there, to the same target, at the width orders.css switches at.
  it('is declared as replacing the table’s two row links at the width where glass swaps them', () => {
    const web = join(__dirname, '..', '..', '..');
    const allowlist = JSON.parse(
      readFileSync(join(web, 'tests', 'e2e', 'appearance', 'glass-only-allowlist.json'), 'utf8'),
    ) as {
      kinds: Record<string, string>;
      entries: {
        id: string;
        kind: string;
        role?: string;
        href?: string;
        maxWidth?: number;
        replaces?: { role: string; selector: string; href: string }[];
      }[];
    };
    const entry = allowlist.entries.find((e) => e.id === 'orders-phone-cards')!;
    expect(entry.kind).toBe('replaced below a width');
    expect(Object.keys(allowlist.kinds)).toContain(entry.kind);
    expect(entry.role).toBe('link');
    expect(entry.href).toBe('/dashboard/orders/<id>');
    expect(entry.replaces?.map((r) => [r.role, r.selector, r.href])).toEqual([
      ['link', "[data-glass='table-scroll'] tbody td:first-child a", '/dashboard/orders/<id>'],
      ['link', "[data-glass='table-scroll'] tbody td:nth-child(2) a", '/dashboard/orders/<id>'],
    ]);

    // The card goes where the row's own links go.
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const card = render(<OrderPhoneCards rows={[row({ id: 'o7' })]} />).getByRole('link');
    expect(card).toHaveAttribute('href', entry.href!.replace('<id>', 'o7'));

    // orders.css swaps them at exactly entry.maxWidth: in that media block
    // the table's scroll box is hidden and the card list is shown.
    const css = postcss.parse(
      readFileSync(join(web, 'src', 'styles', 'liquid-glass', 'pages', 'orders.css'), 'utf8'),
    );
    const swaps: { media: string; selector: string; display: string }[] = [];
    css.walkDecls('display', (decl) => {
      const rule = decl.parent as Rule;
      const media = (rule.parent as AtRule).params ?? '';
      const selector = rule.selector.replace(/\s+/g, ' ');
      if (/> \[data-glass='(table-scroll|orders-phone-cards)'\]$/.test(selector)) {
        swaps.push({ media, selector: selector.split(' > ').at(-1)!, display: decl.value });
      }
    });
    expect(swaps).toEqual([
      {
        media: `(max-width: ${entry.maxWidth}px)`,
        selector: "[data-glass='table-scroll']",
        display: 'none',
      },
      {
        media: `(max-width: ${entry.maxWidth}px)`,
        selector: "[data-glass='orders-phone-cards']",
        display: 'flex',
      },
    ]);
  });
});
