import { render, screen } from '@testing-library/react';
import { Boxes } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';

import { EmptyState } from './empty-state';

// Next's Link does navigation gymnastics that we don't care about
// in a unit test — stub it down to a plain anchor.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

const panelOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-slot="state-panel"]')!;

describe('EmptyState', () => {
  it('renders the title', () => {
    render(
      <EmptyState
        icon={Boxes}
        title="No items yet"
        description="Add your first item to start tracking stock."
      />,
    );
    expect(screen.getByRole('heading', { name: 'No items yet' })).toBeInTheDocument();
  });

  it('renders the description', () => {
    render(
      <EmptyState
        icon={Boxes}
        title="No items yet"
        description="Add your first item to start tracking stock."
      />,
    );
    expect(screen.getByText('Add your first item to start tracking stock.')).toBeInTheDocument();
  });

  it('renders the CTA as a link to the provided href when cta is provided', () => {
    render(
      <EmptyState
        icon={Boxes}
        title="No items yet"
        description="Add your first item to start tracking stock."
        cta={{ label: 'New item', href: '/dashboard/inventory/new' }}
      />,
    );
    const link = screen.getByRole('link', { name: 'New item' });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/dashboard/inventory/new');
  });

  it('omits the CTA when cta is undefined', () => {
    render(
      <EmptyState
        icon={Boxes}
        title="No items match these filters"
        description="Try clearing them."
      />,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('uses smaller padding when size="sm"', () => {
    const { container } = render(
      <EmptyState
        icon={Boxes}
        title="No items yet"
        description="Card-scoped empty state."
        size="sm"
      />,
    );
    // The outer wrapper sets a min-height we can assert on; sm should
    // be 200px, md (default) should be StatePanel's 320px.
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toMatch(/min-h-\[200px\]/);
  });

  it('defaults to size="md"', () => {
    const { container } = render(
      <EmptyState icon={Boxes} title="No items yet" description="Full-page empty state." />,
    );
    const wrapper = container.firstChild as HTMLElement;
    // Look-only expectation updated by P2.6c (redesign): the md box is now
    // P2.6's StatePanel md card, 320 px tall at least (it was 360).
    expect(wrapper.className).toMatch(/min-h-\[320px\]/);
    expect(wrapper.className).not.toMatch(/min-h-\[200px\]/);
  });
});

/**
 * Redesign P2.6c (PLAN P2.2 "One look per pattern"): EmptyState draws P2.6's
 * StatePanel and keeps its props, words, the h3 title (the Items first-paint
 * test reads every h3 as "an empty state's title"), the description
 * paragraph, the CTA link and the action slot.
 */
describe('EmptyState through the StatePanel pattern', () => {
  it('is the StatePanel quiet card, with the caller`s classes merged last', () => {
    const { container } = render(
      <EmptyState
        icon={Boxes}
        title="No items yet"
        description="Add your first item."
        className="mt-6"
      />,
    );
    const panel = panelOf(container);
    expect(panel).toBe(container.firstChild);
    expect(panel).toHaveClass('border', 'rounded-lg', 'bg-card', 'mt-6');
    // As before: no live region of its own.
    expect(panel).not.toHaveAttribute('role');
  });

  it('keeps the title an h3 and the description a paragraph', () => {
    const { container } = render(
      <EmptyState icon={Boxes} title="No items yet" description="Add your first item." />,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'No items yet' })).toBeInTheDocument();
    expect(container.querySelectorAll('h1, h2, h4')).toHaveLength(0);
    expect(screen.getByText('Add your first item.').tagName).toBe('P');
    expect(panelOf(container).textContent).toBe('No items yetAdd your first item.');
  });

  it('shows the call site`s own icon, hidden from assistive technology', () => {
    const { container } = render(
      <EmptyState icon={Boxes} title="No items yet" description="Add your first item." />,
    );
    const chip = container.querySelector('[data-slot="state-panel-icon"]');
    expect(chip).toHaveAttribute('aria-hidden', 'true');
    expect(chip?.querySelector('svg')).toHaveClass('lucide-boxes');
  });

  it('draws the CTA as the flat accent primary, small inside a small box', () => {
    const { rerender } = render(
      <EmptyState
        icon={Boxes}
        title="No items yet"
        description="Add your first item."
        cta={{ label: 'Add your first item', href: '/dashboard/inventory/new' }}
      />,
    );
    expect(screen.getByRole('link', { name: 'Add your first item' })).toHaveClass(
      'bg-accent',
      'h-8',
    );
    rerender(
      <EmptyState
        icon={Boxes}
        title="No inventory yet"
        description="Add your first item."
        size="sm"
        cta={{ label: 'Add your first item', href: '/dashboard/inventory/new' }}
      />,
    );
    expect(screen.getByRole('link', { name: 'Add your first item' })).toHaveClass(
      'bg-accent',
      'h-7',
    );
  });

  it('renders the action instead of the CTA, and the CTA when the action is empty', () => {
    const { rerender } = render(
      <EmptyState
        icon={Boxes}
        title="Nothing here in North"
        description="3 items match in your other warehouses. This view is filtered to North."
        action={<button type="button">Search all warehouses</button>}
        cta={{ label: 'Show all items', href: '/dashboard/inventory' }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Search all warehouses' })).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    rerender(
      <EmptyState
        icon={Boxes}
        title="No low-stock items"
        description="Nothing is at or below its reorder point right now. Nice."
        action={null}
        cta={{ label: 'Show all items', href: '/dashboard/inventory' }}
      />,
    );
    expect(screen.getByRole('link', { name: 'Show all items' })).toHaveAttribute(
      'href',
      '/dashboard/inventory',
    );
  });

  // Each row is a call site's own words (title, then description). The kind
  // is 'no-match' only where those words say the list is filtered.
  it.each([
    [
      'No items match your search',
      'Nothing matched "tee". Try a different SKU, name, or barcode.',
      'no-match',
    ],
    ['No matches', 'Try a broader search or clear the filters.', 'no-match'],
    [
      'No events match these filters',
      'Try widening the date range or clearing filters to see more activity.',
      'no-match',
    ],
    [
      'No POs match “acme”',
      'Try a different PO number or supplier, or clear the search.',
      'no-match',
    ],
    ['No returns match this view.', 'Open a handed-over order and create a return.', 'no-match'],
    [
      'Nothing here in North',
      '3 items match in your other warehouses. This view is filtered to North.',
      'no-match',
    ],
    [
      'No low-stock books',
      'No books are at or below their reorder point right now. Clear the filter to see all books.',
      'no-match',
    ],
    [
      'No movements match',
      'Nothing found for the current filters. Try a different search, type, or date range.',
      'no-match',
    ],
    [
      'No items yet',
      'Add your first item to start tracking stock, locations, and movements.',
      'empty',
    ],
    [
      'No archived items',
      'Nothing here yet. Items you archive will show up in this view.',
      'empty',
    ],
    ['No low-stock items', 'Nothing is at or below its reorder point right now. Nice.', 'empty'],
    [
      'No categories yet',
      'Group items by type so reports, filters, and dashboards stay readable.',
      'empty',
    ],
    ['Nothing on this page', "You've paged past the end of the list.", 'empty'],
    [
      'Nothing in picking',
      'No requests are sitting in this stage. Switch tabs above to see other stages of the queue.',
      'empty',
    ],
    [
      'All caught up',
      'Low-stock alerts, team activity, and PO updates show up here as they happen.',
      'empty',
    ],
  ])('"%s" / "%s" is the %s state', (title, description, kind) => {
    const { container } = render(
      <EmptyState icon={Boxes} title={title} description={description} />,
    );
    expect(panelOf(container)).toHaveAttribute('data-state-kind', kind);
    // The kind never adds words: only the call site's own title and sentence.
    expect(panelOf(container).textContent).toBe(`${title}${description}`);
  });
});
