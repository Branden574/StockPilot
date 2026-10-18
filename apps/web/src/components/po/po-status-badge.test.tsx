import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { badgeVariants } from '@/components/ui/badge';

import { PoStatusBadge } from './po-status-badge';

// The redesign (P2.4, DESIGN-SPEC 6.10): the six real purchase order words on
// the status tones through the existing variant names; no Sent, no Overdue,
// no "Partially received". The tone is read from the live Badge recipe
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

describe('PoStatusBadge', () => {
  it.each([
    ['draft', 'Draft', 'outline'],
    ['expected_inbound', 'Expected', 'secondary'],
    ['ordered', 'Ordered', 'secondary'],
    ['partially_received', 'Partial', 'warning'],
    ['received', 'Received', 'success'],
    ['cancelled', 'Cancelled', 'destructive'],
  ])('%s reads "%s" on the %s tone', (status, word, tone) => {
    render(<PoStatusBadge status={status} />);
    const pill = screen.getByText(word);
    expect(pill.textContent).toBe(word);
    expect(toneOf(pill)).toBe(tone);
  });

  it('keeps its fallback: a value outside the six reads as Draft', () => {
    render(<PoStatusBadge status="something_else" />);
    expect(toneOf(screen.getByText('Draft'))).toBe('outline');
  });
});
