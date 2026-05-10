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

describe('EmptyState', () => {
  it('renders the title', () => {
    render(
      <EmptyState
        icon={Boxes}
        title="No items yet"
        description="Add your first item to start tracking stock."
      />,
    );
    expect(
      screen.getByRole('heading', { name: 'No items yet' }),
    ).toBeInTheDocument();
  });

  it('renders the description', () => {
    render(
      <EmptyState
        icon={Boxes}
        title="No items yet"
        description="Add your first item to start tracking stock."
      />,
    );
    expect(
      screen.getByText('Add your first item to start tracking stock.'),
    ).toBeInTheDocument();
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
    // be 200px, md (default) should be 360px.
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toMatch(/min-h-\[200px\]/);
  });

  it('defaults to size="md"', () => {
    const { container } = render(
      <EmptyState
        icon={Boxes}
        title="No items yet"
        description="Full-page empty state."
      />,
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toMatch(/min-h-\[360px\]/);
  });
});
