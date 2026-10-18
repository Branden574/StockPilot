import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Badge, type BadgeProps } from './badge';

/**
 * Redesign P2.2 status labels (DESIGN-SPEC 6.10). The six variant names are
 * stored per-org order-status colours (packages/core ORDER_STATUS_COLORS), so
 * each must still exist; each now draws one of the six tone recipes.
 */

const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);

const TONES: Array<[NonNullable<BadgeProps['variant']>, string[]]> = [
  ['success', ['bg-success-wash', 'text-success']],
  ['warning', ['bg-warning-wash', 'text-warning']],
  ['destructive', ['bg-destructive-wash', 'text-destructive']],
  ['secondary', ['bg-sunk', 'text-[var(--ed-ink-2)]', 'border-[var(--ed-line-strong)]']],
  ['outline', ['bg-transparent', 'text-muted-foreground', 'border-[var(--ed-line-strong)]']],
  ['default', ['bg-primary', 'text-primary-foreground', 'border-transparent']],
];

describe('Badge', () => {
  it.each(TONES)('%s keeps its name and draws its tone', (variant, expected) => {
    render(<Badge variant={variant}>Label</Badge>);
    expect(classes(screen.getByText('Label'))).toEqual(expect.arrayContaining(expected));
  });

  it('never wraps (no more "In / stock"), 12 px pill', () => {
    render(<Badge variant="success">In stock</Badge>);
    expect(classes(screen.getByText('In stock'))).toEqual(
      expect.arrayContaining(['whitespace-nowrap', 'rounded-full', 'text-xs/[18px]']),
    );
  });

  it('an optional 5 px dot in the label colour, hidden from assistive technology; the words stay', () => {
    render(
      <Badge variant="warning" dot>
        Low stock
      </Badge>,
    );
    const badge = screen.getByText('Low stock');
    expect(badge).toHaveTextContent('Low stock');
    const dot = badge.firstElementChild as HTMLElement;
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(classes(dot)).toEqual(
      expect.arrayContaining(['size-[5px]', 'bg-current', 'rounded-full']),
    );
  });

  it('no dot unless asked, and the dot prop never reaches the DOM', () => {
    render(<Badge variant="outline">Archived</Badge>);
    const badge = screen.getByText('Archived');
    expect(badge.childElementCount).toBe(0);
    expect(badge).not.toHaveAttribute('dot');
  });

  it('the ink default draws no ink ring: a caller that recolours only the fill and text keeps a clean pill', () => {
    // MaintenanceStatusBadge recolours a default Badge per status. With an ink
    // border, tailwind-merge kept border-primary beside the caller's fill, so
    // every maintenance pill had a 1 px near-black (light) or near-white (dark)
    // ring. A transparent border looks the same under the ink fill.
    render(<Badge className="bg-blue-100 text-blue-800">Saved</Badge>);
    const c = classes(screen.getByText('Saved'));
    expect(c).toContain('border-transparent');
    expect(c).not.toContain('border-primary');
    expect(c).toEqual(expect.arrayContaining(['bg-blue-100', 'text-blue-800']));
    expect(c).not.toContain('bg-primary');
  });

  it("a caller's own classes still win", () => {
    render(
      <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
        Premium
      </Badge>,
    );
    const c = classes(screen.getByText('Premium'));
    expect(c).toEqual(expect.arrayContaining(['px-1.5', 'py-0', 'text-[10px]']));
    expect(c).not.toContain('text-xs/[18px]');
  });
});
