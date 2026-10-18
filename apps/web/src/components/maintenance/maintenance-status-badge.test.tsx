import type { MaintenanceStatus } from '@stockpilot/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { badgeVariants } from '@/components/ui/badge';

import { MaintenanceStatusBadge } from './maintenance-status-badge';

describe('MaintenanceStatusBadge', () => {
  it('renders the five sanctioned labels and nothing else (brief section 20; resolved added by Maintenance Resolved spec §1.1)', () => {
    const { rerender } = render(<MaintenanceStatusBadge status="saved" />);
    expect(screen.getByText('Saved')).toBeInTheDocument();
    rerender(<MaintenanceStatusBadge status="draft_opened" />);
    expect(screen.getByText('Email draft opened')).toBeInTheDocument();
    rerender(<MaintenanceStatusBadge status="resolved" />);
    expect(screen.getByText('Resolved')).toBeInTheDocument();
    rerender(<MaintenanceStatusBadge status="archived" />);
    expect(screen.getByText('Archived')).toBeInTheDocument();
    rerender(<MaintenanceStatusBadge status="cancelled" />);
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });
  it('never renders forbidden phrases', () => {
    render(<MaintenanceStatusBadge status="draft_opened" />);
    for (const banned of ['Email sent', 'Ticket created', 'submitted to Zendesk']) {
      expect(screen.queryByText(banned)).toBeNull();
    }
  });
  it('resolved status never renders a forbidden ticket-outcome phrase (spec §11)', () => {
    render(<MaintenanceStatusBadge status="resolved" />);
    for (const banned of ['Ticket resolved', 'Ticket closed', 'Zendesk ticket resolved']) {
      expect(screen.queryByText(banned)).toBeNull();
    }
  });
});

// The redesign (P2.4, DESIGN-SPEC 6.10): the five words on the status tones
// through the existing variant names, in place of palette colours laid over
// the ink (default) badge. The tone is read from the live Badge recipe
// (classes all six tones share are ignored), so restyling the recipe cannot
// break the check.
const TONES = ['default', 'secondary', 'destructive', 'success', 'warning', 'outline'] as const;
function toneOf(el: Element): string {
  const own = new Set(el.className.split(/\s+/));
  const recipes = TONES.map((t) => badgeVariants({ variant: t }).split(/\s+/));
  const shared = recipes.reduce((a, r) => a.filter((c) => r.includes(c)));
  return TONES.filter((_, i) => recipes[i]!.every((c) => shared.includes(c) || own.has(c))).join(
    '|',
  );
}

describe('MaintenanceStatusBadge tones', () => {
  const cases: Array<[MaintenanceStatus, string, string]> = [
    ['saved', 'Saved', 'secondary'],
    ['draft_opened', 'Email draft opened', 'warning'],
    ['resolved', 'Resolved', 'success'],
    ['archived', 'Archived', 'outline'],
    ['cancelled', 'Cancelled', 'outline'],
  ];

  it.each(cases)('%s reads "%s" on the %s tone', (status, word, tone) => {
    render(<MaintenanceStatusBadge status={status} />);
    const pill = screen.getByText(word);
    expect(toneOf(pill)).toBe(tone);
    expect(pill.className).not.toMatch(/\b(?:bg|text)-(?:blue|emerald|amber)-/);
  });

  // Mutation caught: the palette classes sat on the ink (default) badge, whose
  // hover fill (primary/80) then turned the pill near-black under the cursor,
  // with the blue or amber text still on it.
  it('hovering a pill never changes its fill', () => {
    for (const [status] of cases) {
      const { unmount } = render(<MaintenanceStatusBadge status={status} />);
      const pill = screen.getByText(/./);
      expect(pill.className).not.toMatch(/(?:^|\s)hover:bg-/);
      unmount();
    }
  });

  it('Cancelled stays struck through, and only Cancelled', () => {
    const { rerender } = render(<MaintenanceStatusBadge status="cancelled" />);
    expect(screen.getByText('Cancelled')).toHaveClass('line-through');
    rerender(<MaintenanceStatusBadge status="archived" />);
    expect(screen.getByText('Archived')).not.toHaveClass('line-through');
  });
});
