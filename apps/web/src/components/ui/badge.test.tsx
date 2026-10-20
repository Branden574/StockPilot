import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Badge, type BadgeProps, badgeVariants } from './badge';

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

/**
 * Redesign P2.2c (DESIGN-SPEC 4 and 6.10, reference measurements
 * items.pillInStock 20 px with borderTopWidth 0, orders.chipPending 22 px with
 * a 1 px transparent border): the stock wash pills are 20 px with no border;
 * the PO and order chips keep their 1 px border (22 px).
 */
describe('Badge looks: wash pills and bordered chips', () => {
  it.each(['success', 'warning', 'destructive'] as const)(
    'a dotted %s pill (the stock look) draws no border, so it is 20 px',
    (variant) => {
      render(
        <Badge variant={variant} dot>
          Status
        </Badge>,
      );
      const c = classes(screen.getByText('Status'));
      expect(c).toContain('border-0');
      expect(c).not.toContain('border');
      expect(c).toEqual(expect.arrayContaining(['py-px', 'text-xs/[18px]']));
    },
  );

  it.each(['success', 'warning', 'destructive'] as const)(
    'a %s chip without a dot (PO and order status) keeps its 1 px border, so it is 22 px',
    (variant) => {
      render(<Badge variant={variant}>Status</Badge>);
      const c = classes(screen.getByText('Status'));
      expect(c).toContain('border');
      expect(c).toContain('border-transparent');
      expect(c).not.toContain('border-0');
    },
  );

  it.each(['secondary', 'outline'] as const)(
    'the %s tone keeps its hairline even with a dot (its only edge)',
    (variant) => {
      render(
        <Badge variant={variant} dot>
          Status
        </Badge>,
      );
      const c = classes(screen.getByText('Status'));
      expect(c).toEqual(expect.arrayContaining(['border', 'border-[var(--ed-line-strong)]']));
      expect(c).not.toContain('border-0');
    },
  );

  it('look picks either one explicitly, and never reaches the DOM', () => {
    render(
      <>
        <Badge variant="success" look="wash">
          Wash
        </Badge>
        <Badge variant="success" dot look="chip">
          Chip
        </Badge>
      </>,
    );
    expect(classes(screen.getByText('Wash'))).toContain('border-0');
    expect(classes(screen.getByText('Chip'))).not.toContain('border-0');
    expect(screen.getByText('Chip')).toHaveClass('border');
    expect(screen.getByText('Wash')).not.toHaveAttribute('look');
  });

  it('badgeVariants keeps its old output for a variant alone (tone tests read it)', () => {
    expect(badgeVariants({ variant: 'success' })).not.toContain('border-0');
  });
});

/**
 * Redesign P2.2c (from the P2.6 review): the dot was an empty first flex item,
 * so a dotted inline-flex Badge took its baseline from the dot's bottom edge
 * and sat about 1.5 px low in a baseline row (KeyValueRow measured 25.5 vs
 * 24 px). A dotted Badge aligns on its words' baseline and centres the dot.
 */
describe('Badge baseline', () => {
  it('a dotted badge aligns its items on the baseline and the dot centres itself', () => {
    render(
      <Badge variant="warning" dot>
        Low stock
      </Badge>,
    );
    const badge = screen.getByText('Low stock');
    expect(classes(badge)).toContain('items-baseline');
    expect(classes(badge)).not.toContain('items-center');
    expect(classes(badge.firstElementChild as HTMLElement)).toContain('self-center');
  });

  it('a badge without a dot keeps items-center (icons inside it stay centred)', () => {
    render(<Badge variant="outline">Archived</Badge>);
    const c = classes(screen.getByText('Archived'));
    expect(c).toContain('items-center');
    expect(c).not.toContain('items-baseline');
  });
});
