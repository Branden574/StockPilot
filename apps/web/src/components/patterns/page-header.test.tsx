import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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

import { PageHeader, PageHeaderBackLink, SublineValue } from './page-header';

function everySlot() {
  return render(
    <PageHeader
      title="Inventory"
      titleId="page-title"
      eyebrow="Wednesday, October 14 · All warehouses"
      subline={
        <>
          472 SKUs · 487 rows · <SublineValue>$228,261.23</SublineValue> on hand
        </>
      }
      meta={<span>SP-WB20-KX9</span>}
      titleAside={<span>DC4</span>}
      media={<span data-testid="media" />}
      back={<PageHeaderBackLink href="/dashboard/settings">← Back to settings</PageHeaderBackLink>}
      tour={<button type="button">Tour</button>}
      actions={<button type="button">Import CSV</button>}
      commitAction={<button type="button">Receive stock</button>}
      primaryAction={<button type="button">+ New item</button>}
    >
      <p>Showing your warehouse only.</p>
    </PageHeader>,
  );
}

describe('PageHeader', () => {
  it('renders exactly one h1, the title, with every slot filled', () => {
    everySlot();
    const headings = screen.getAllByRole('heading');
    expect(headings).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Inventory' })).toHaveAttribute(
      'id',
      'page-title',
    );
  });

  it('keeps the shell its header: the root is not a <header> and adds no banner landmark', () => {
    const { container } = everySlot();
    expect(container.querySelector('header')).toBeNull();
    expect(screen.queryByRole('banner')).toBeNull();
  });

  it('orders the actions: tour, secondary, then the ink primary, then the accent primary last', () => {
    everySlot();
    const row = screen.getByRole('button', { name: '+ New item' }).parentElement!;
    expect(
      within(row)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Tour', 'Import CSV', 'Receive stock', '+ New item']);
  });

  it('renders no actions row when the page passes none', () => {
    const { container } = render(<PageHeader title="Movements" subline="Every stock change." />);
    expect(container.querySelector('[data-slot="page-header-actions"]')).toBeNull();
    expect(screen.getByText('Every stock change.')).toBeInTheDocument();
  });

  it('keeps the back link words and href exactly as the page passes them', () => {
    everySlot();
    expect(screen.getByRole('link', { name: '← Back to settings' })).toHaveAttribute(
      'href',
      '/dashboard/settings',
    );
  });

  it('prints the subline with its live figure in ink, and the eyebrow, meta and extra content', () => {
    everySlot();
    expect(screen.getByText('$228,261.23')).toHaveClass('text-foreground');
    expect(screen.getByText('Wednesday, October 14 · All warehouses')).toBeInTheDocument();
    expect(screen.getByText('SP-WB20-KX9')).toBeInTheDocument();
    expect(screen.getByText('Showing your warehouse only.')).toBeInTheDocument();
    expect(screen.getByTestId('media')).toBeInTheDocument();
  });

  it('sizes the title per variant: 28 for a page, 32 for the greeting, 26 for a record', () => {
    const { rerender } = render(<PageHeader title="Orders" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('text-[28px]');
    rerender(<PageHeader title="Good afternoon, Carsten." variant="greeting" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('text-[32px]');
    rerender(<PageHeader title="L4L Insulated Bottle 20 oz" variant="item" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('text-[26px]');
  });

  it('puts the title-line extras beside the h1, not inside it', () => {
    everySlot();
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent(/^Inventory$/);
    expect(h1.parentElement).toHaveTextContent('DC4');
  });

  it('bottom-aligns the actions with the title block, and centres them beside a record`s photo', () => {
    const actionsRow = (container: HTMLElement) =>
      container.querySelector('[data-slot="page-header-actions"]')!.parentElement!;
    const { container, rerender } = render(
      <PageHeader title="Orders" actions={<button type="button">Export</button>} />,
    );
    expect(actionsRow(container)).toHaveClass('items-end');
    rerender(
      <PageHeader
        title="Good afternoon, Carsten."
        variant="greeting"
        actions={<button type="button">Export</button>}
      />,
    );
    expect(actionsRow(container)).toHaveClass('items-end');
    // The reference's item header centres Adjust / Transfer / Create PO on the
    // 64 px photo and the title block (measured: both centred at 118 px).
    rerender(
      <PageHeader
        title="L4L Insulated Bottle 20 oz"
        variant="item"
        media={<span data-testid="media" />}
        actions={<button type="button">Adjust</button>}
      />,
    );
    expect(actionsRow(container)).toHaveClass('items-center');
    expect(actionsRow(container)).not.toHaveClass('items-end');
  });
});
