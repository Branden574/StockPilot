import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { DetailSection, DetailSectionLink, DetailSectionMeta } from './detail-section';

describe('DetailSection', () => {
  it('titles the card with a real heading (h2 by default) and the header aside', () => {
    render(
      <DetailSection
        title="Low stock"
        aside={
          <DetailSectionLink href="/dashboard/inventory?stock=low&type=all">
            View all 18
          </DetailSectionLink>
        }
      >
        <p>rows</p>
      </DetailSection>,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Low stock' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View all 18' })).toHaveAttribute(
      'href',
      '/dashboard/inventory?stock=low&type=all',
    );
  });

  it('takes another heading level where the page outline needs it', () => {
    render(<DetailSection title="By location" headingLevel={3} />);
    expect(screen.getByRole('heading', { level: 3, name: 'By location' })).toBeInTheDocument();
  });

  it('pads the body 18 by default and not at all when flush', () => {
    const { container, rerender } = render(<DetailSection title="Notes">x</DetailSection>);
    const body = () => container.querySelector('[data-slot="detail-section-body"]')!;
    expect(body()).toHaveClass('p-[18px]');
    rerender(
      <DetailSection title="Notes" flush>
        x
      </DetailSection>,
    );
    expect(body()).not.toHaveClass('p-[18px]');
  });

  it('renders no header without a title or aside, and the footer only when given', () => {
    const { container, rerender } = render(<DetailSection>x</DetailSection>);
    expect(container.querySelector('[data-slot="detail-section-header"]')).toBeNull();
    expect(container.querySelector('[data-slot="detail-section-footer"]')).toBeNull();
    rerender(
      <DetailSection
        aside={<DetailSectionMeta>Most urgent first</DetailSectionMeta>}
        footer="Total"
      >
        x
      </DetailSection>,
    );
    expect(container.querySelector('[data-slot="detail-section-header"]')).toHaveTextContent(
      'Most urgent first',
    );
    expect(container.querySelector('[data-slot="detail-section-footer"]')).toHaveTextContent(
      'Total',
    );
  });

  it('passes an id through for an in-page anchor', () => {
    const { container } = render(<DetailSection id="physical-count" title="Last physical count" />);
    expect(container.querySelector('section#physical-count')).not.toBeNull();
  });
});
