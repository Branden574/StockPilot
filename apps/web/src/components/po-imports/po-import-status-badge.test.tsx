import type { PoImportStatus } from '@stockpilot/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { badgeVariants } from '@/components/ui/badge';

import { PoImportStatusBadge } from './po-import-status-badge';

// The redesign (P2.4, DESIGN-SPEC 6.10): the import statuses move off
// hand-picked palette colours (blue, emerald, amber) onto the status tones;
// the words stay the status itself, underscores read as spaces. The tone is
// read from the live Badge recipe (classes all six tones share are ignored).
const TONES = ['default', 'secondary', 'destructive', 'success', 'warning', 'outline'] as const;
function toneOf(el: Element): string {
  const own = new Set(el.className.split(/\s+/));
  const recipes = TONES.map((t) => badgeVariants({ variant: t }).split(/\s+/));
  const shared = recipes.reduce((a, r) => a.filter((c) => r.includes(c)));
  return TONES.filter((_, i) => recipes[i]!.every((c) => shared.includes(c) || own.has(c))).join(
    '|',
  );
}

describe('PoImportStatusBadge', () => {
  const cases: Array<[PoImportStatus, string, string]> = [
    ['uploaded', 'uploaded', 'outline'],
    ['parsing', 'parsing', 'secondary'],
    ['parsed', 'parsed', 'success'],
    ['needs_review', 'needs review', 'warning'],
    ['approved', 'approved', 'success'],
    ['failed', 'failed', 'destructive'],
    ['duplicate', 'duplicate', 'outline'],
    ['canceled', 'canceled', 'outline'],
  ];

  it.each(cases)('%s reads "%s" on the %s tone', (status, word, tone) => {
    render(<PoImportStatusBadge status={status} />);
    const pill = screen.getByText(word);
    expect(pill.textContent).toBe(word);
    expect(toneOf(pill)).toBe(tone);
    // No palette colour survives the move to the tokens.
    expect(pill.className).not.toMatch(/\b(?:bg|text)-(?:blue|emerald|amber)-/);
  });

  it('a status this build does not know reads as its words on the outline tone', () => {
    render(<PoImportStatusBadge status={'queued_again' as PoImportStatus} />);
    expect(toneOf(screen.getByText('queued again'))).toBe('outline');
  });
});
