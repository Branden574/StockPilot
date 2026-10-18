import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { badgeVariants } from '@/components/ui/badge';
import type { ReturnStatus } from '@/server/services/returns';

import { ReturnStatusBadge } from './return-status-badge';

// The redesign (P2.4, DESIGN-SPEC 6.10): the return words on the status tones
// through the existing variant names. The tone is read from the live Badge
// recipe (classes all six tones share are ignored), so restyling the recipe
// cannot break the check.
const TONES = ['default', 'secondary', 'destructive', 'success', 'warning', 'outline'] as const;
function toneOf(el: Element): string {
  const own = new Set(el.className.split(/\s+/));
  const recipes = TONES.map((t) => badgeVariants({ variant: t }).split(/\s+/));
  const shared = recipes.reduce((a, r) => a.filter((c) => r.includes(c)));
  return TONES.filter((_, i) => recipes[i]!.every((c) => shared.includes(c) || own.has(c))).join(
    '|',
  );
}

describe('ReturnStatusBadge', () => {
  const cases: Array<[ReturnStatus, string, string]> = [
    ['requested', 'Requested', 'warning'],
    ['approved', 'Approved', 'default'],
    ['received', 'Received', 'secondary'],
    ['closed', 'Closed', 'success'],
    ['denied', 'Denied', 'destructive'],
    ['cancelled', 'Cancelled', 'outline'],
  ];

  it.each(cases)('%s reads "%s" on the %s tone', (status, word, tone) => {
    render(<ReturnStatusBadge status={status} />);
    const pill = screen.getByText(word);
    expect(pill.textContent).toBe(word);
    expect(toneOf(pill)).toBe(tone);
  });

  it('a status this build does not know shows its raw value on the outline tone', () => {
    render(<ReturnStatusBadge status={'in_limbo' as ReturnStatus} />);
    expect(toneOf(screen.getByText('in_limbo'))).toBe('outline');
  });
});
