import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  EXCEPTION_FIRST_CHECK_PENDING_COPY,
  EXCEPTION_LIST_UNAVAILABLE_COPY,
  type OccurrenceState,
} from '@stockpilot/core';

import { badgeVariants } from '@/components/ui/badge';
import type { OccurrenceEscalation } from '@/server/services/exception-occurrences';

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});

import {
  EscalationChip,
  ExceptionsUnavailable,
  FirstCheckPending,
  RecurrenceChip,
  SeverityChip,
  StateChip,
  UncheckedRulesBanner,
  UnrecognizedNotice,
} from './occurrence-display';

// The redesign (P2.4, DESIGN-SPEC 6.10): the exception chips keep core's words
// on the status tones through the existing variant names, and the notices move
// onto the warning wash and the inset (sunk) surface. The tone is read from the
// live Badge recipe (classes all six tones share are ignored), so restyling the
// recipe cannot break the check.
const TONES = ['default', 'secondary', 'destructive', 'success', 'warning', 'outline'] as const;
function toneOf(el: Element): string {
  const own = new Set(el.className.split(/\s+/));
  const recipes = TONES.map((t) => badgeVariants({ variant: t }).split(/\s+/));
  const shared = recipes.reduce((a, r) => a.filter((c) => r.includes(c)));
  return TONES.filter((_, i) => recipes[i]!.every((c) => shared.includes(c) || own.has(c))).join(
    '|',
  );
}

const ESCALATION: OccurrenceEscalation = {
  requestId: 'mr-1',
  requestNumber: 14,
  reference: 'MR-2026-000014',
  escalatedAt: '2026-09-24T18:00:00Z',
  escalatedBy: null,
  requestCancelled: false,
  visibleToReader: null,
  request: null,
};

describe('StateChip', () => {
  const cases: Array<[OccurrenceState, string, string]> = [
    [{ kind: 'open' }, 'Open', 'warning'],
    [{ kind: 'acknowledged', at: '2026-09-24T18:00:00Z', by: null }, 'Acknowledged', 'secondary'],
    [{ kind: 'rechecking', cycleCountId: 'cc', countNumber: null }, 'Re-checking', 'secondary'],
    [
      { kind: 'recount_in_progress', cycleCountId: 'cc', countNumber: 42 },
      'Recount in progress (CC-000042)',
      'secondary',
    ],
    [{ kind: 'resolved', reason: null, at: '2026-09-24T18:00:00Z' }, 'Resolved', 'success'],
  ];

  it.each(cases)('%j reads "%s" on the %s tone', (state, word, tone) => {
    render(<StateChip state={state} />);
    const chip = screen.getByTestId('occurrence-state');
    expect(chip).toHaveTextContent(word);
    expect(toneOf(chip)).toBe(tone);
  });
});

describe('the other chips', () => {
  it('severity: Critical on the destructive tone with its icon, Warning on the neutral one', () => {
    const { rerender } = render(<SeverityChip rule="orphaned_stock" />);
    const critical = screen.getByText('Critical');
    expect(toneOf(critical)).toBe('destructive');
    expect(critical.querySelector('svg')).not.toBeNull();
    rerender(<SeverityChip rule="stale_staging" />);
    expect(toneOf(screen.getByText('Warning'))).toBe('secondary');
  });

  it('recurrence and escalation chips are outline; the escalation links only when given an href', () => {
    render(<RecurrenceChip recurrenceIndex={1} />);
    expect(toneOf(screen.getByText('Recurred (2nd time)'))).toBe('outline');
    const { rerender } = render(<EscalationChip escalation={ESCALATION} />);
    expect(toneOf(screen.getByTestId('escalation-badge'))).toBe('outline');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    rerender(<EscalationChip escalation={ESCALATION} href="/dashboard/maintenance/mr-1" />);
    expect(screen.getByRole('link', { name: 'Escalated: MR-2026-000014' })).toHaveAttribute(
      'href',
      '/dashboard/maintenance/mr-1',
    );
  });
});

describe('the notices', () => {
  it('a failed read is an alert on the warning wash, never an empty list', () => {
    render(<ExceptionsUnavailable />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      `${EXCEPTION_LIST_UNAVAILABLE_COPY} Reload the page to try again.`,
    );
    expect(alert).toHaveClass('bg-warning-wash');
  });

  it('before the first check: a status on the inset surface', () => {
    render(<FirstCheckPending />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(EXCEPTION_FIRST_CHECK_PENDING_COPY);
    expect(status).toHaveClass('bg-sunk');
  });

  it('the unchecked-rules banner and the unrecognized notice keep their roles and words', () => {
    const { container } = render(<UncheckedRulesBanner message={null} />);
    expect(container).toBeEmptyDOMElement();
    render(<UncheckedRulesBanner message="Stale staging could not be checked." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Stale staging could not be checked.');
    render(<UnrecognizedNotice count={2} />);
    expect(screen.getByTestId('exceptions-unrecognized')).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('exceptions-unrecognized')).toHaveTextContent(
      '2 more open exceptions cannot be shown in this version.',
    );
  });
});
