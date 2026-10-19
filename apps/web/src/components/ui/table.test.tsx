import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';

/**
 * Redesign P2.2c (from the P3.5 review): a wide table scrolls inside its own
 * wrapper, and at 1280 the Orders 'Last update' column sat outside the card
 * with no keyboard way to reach it. While the table overflows sideways the
 * wrapper joins the Tab order (the arrow keys then scroll it), and a caller
 * can name it as a region.
 */

let observers: Array<{ cb: ResizeObserverCallback; targets: Element[] }> = [];
let widths = { scroll: 0, client: 0 };

beforeEach(() => {
  observers = [];
  widths = { scroll: 0, client: 0 };
  vi.stubGlobal(
    'ResizeObserver',
    class {
      entry: { cb: ResizeObserverCallback; targets: Element[] };
      constructor(cb: ResizeObserverCallback) {
        this.entry = { cb, targets: [] };
        observers.push(this.entry);
      }
      observe(el: Element) {
        this.entry.targets.push(el);
      }
      unobserve() {}
      disconnect() {
        this.entry.targets = [];
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => widths.scroll);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => widths.client);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Orders(props: React.ComponentProps<typeof Table>) {
  return (
    <>
      <button type="button">Before</button>
      <Table aria-label="Orders table" {...props}>
        <TableHeader>
          <TableRow>
            <TableHead>Order</TableHead>
            <TableHead>Last update</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>ORD-1</TableCell>
            <TableCell>5h ago</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </>
  );
}

const wrapperOf = () => screen.getByRole('table').parentElement as HTMLElement;

describe('Table scroll wrapper', () => {
  it('a table that fits, with no name, renders exactly as before', () => {
    widths = { scroll: 800, client: 800 };
    render(<Orders />);
    const wrapper = wrapperOf();
    expect(wrapper.tagName).toBe('DIV');
    expect(wrapper).toHaveClass('relative', 'w-full', 'overflow-auto');
    for (const attr of ['role', 'tabindex', 'aria-label', 'aria-labelledby', 'data-overflow']) {
      expect(wrapper).not.toHaveAttribute(attr);
    }
    // The table's own attributes still land on the <table>.
    expect(screen.getByRole('table')).toHaveAttribute('aria-label', 'Orders table');
  });

  it('while the table is wider than its wrapper, Tab reaches the wrapper', async () => {
    widths = { scroll: 1100, client: 900 };
    const user = userEvent.setup();
    render(<Orders />);
    const wrapper = wrapperOf();
    expect(wrapper).toHaveAttribute('tabindex', '0');
    expect(wrapper).toHaveAttribute('data-overflow', 'true');
    await user.tab();
    expect(screen.getByRole('button', { name: 'Before' })).toHaveFocus();
    await user.tab();
    expect(wrapper).toHaveFocus();
    // The global ring is drawn inside as an outline, so neither a card's
    // clipped edge nor a row's background or separator can hide it.
    expect(wrapper).toHaveClass(
      'focus-visible:outline-solid',
      'focus-visible:outline-2',
      'focus-visible:-outline-offset-2',
      'focus-visible:outline-ring',
    );
    // The global :focus-visible box-shadow ring is switched off on the
    // wrapper (rows paint above an inset shadow), and outline-solid is
    // present because that rule's outline-none sets the outline style to
    // none, so a width and colour alone would draw nothing.
    const focusClasses = wrapper.className
      .split(/\s+/)
      .filter((c) => c.startsWith('focus-visible:'));
    expect(focusClasses).toEqual(
      expect.arrayContaining(['focus-visible:ring-0', 'focus-visible:ring-offset-0']),
    );
    expect(focusClasses).not.toContain('focus-visible:ring-inset');
  });

  it('starts and stops being a tab stop when a resize changes the overflow', () => {
    widths = { scroll: 800, client: 800 };
    render(<Orders />);
    const wrapper = wrapperOf();
    expect(wrapper).not.toHaveAttribute('tabindex');
    // Both the wrapper and the table are watched.
    expect(observers[0]!.targets).toEqual([wrapper, screen.getByRole('table')]);

    widths = { scroll: 1100, client: 390 };
    act(() => observers[0]!.cb([], {} as ResizeObserver));
    expect(wrapper).toHaveAttribute('tabindex', '0');

    widths = { scroll: 1280, client: 1280 };
    act(() => observers[0]!.cb([], {} as ResizeObserver));
    expect(wrapper).not.toHaveAttribute('tabindex');
    expect(wrapper).not.toHaveAttribute('data-overflow');
  });

  it('scrollLabel names the wrapper as a region, overflowing or not', () => {
    widths = { scroll: 800, client: 800 };
    render(<Orders scrollLabel="Orders" />);
    const region = screen.getByRole('region', { name: 'Orders' });
    expect(region).toBe(wrapperOf());
    expect(region).not.toHaveAttribute('tabindex');
    // The prop never reaches the <table>.
    expect(screen.getByRole('table')).not.toHaveAttribute('scrollLabel');
    expect(screen.getByRole('table')).not.toHaveAttribute('scrolllabel');
  });

  it('scrollLabelledBy names it from a visible heading', () => {
    render(
      <>
        <h2 id="orders-heading">Needs approval</h2>
        <Orders scrollLabelledBy="orders-heading" />
      </>,
    );
    const region = screen.getByRole('region', { name: 'Needs approval' });
    expect(region).toHaveAttribute('aria-labelledby', 'orders-heading');
    expect(region).not.toHaveAttribute('aria-label');
  });

  it('the server HTML carries no measured attribute, so hydration matches', () => {
    widths = { scroll: 1100, client: 900 };
    const html = renderToString(<Orders scrollLabel="Orders" />);
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Orders"');
    expect(html).not.toContain('tabindex');
    expect(html).not.toContain('data-overflow');
  });

  it('without ResizeObserver it still measures on mount and on window resize', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    widths = { scroll: 800, client: 800 };
    render(<Orders />);
    const wrapper = wrapperOf();
    expect(wrapper).not.toHaveAttribute('tabindex');
    widths = { scroll: 1100, client: 390 };
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(wrapper).toHaveAttribute('tabindex', '0');
  });
});
