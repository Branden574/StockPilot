import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CycleCountStatusBadge, cycleCountStatusTone } from './cycle-count-status-badge';

/**
 * The one status label the history list and the count page share. Its words
 * are the core labels the two old private StatusBadge copies printed, its
 * tones are the ones they used (In progress warning, Completed success,
 * Canceled destructive), and a status this build does not know is printed as
 * stored, never hidden.
 */
describe('CycleCountStatusBadge', () => {
  it.each([
    ['in_progress', 'In progress', 'warning'],
    ['completed', 'Completed', 'success'],
    ['canceled', 'Canceled', 'destructive'],
  ] as const)('%s reads "%s" in the %s tone', (status, words, tone) => {
    render(<CycleCountStatusBadge status={status} />);
    expect(screen.getByText(words)).toBeInTheDocument();
    expect(cycleCountStatusTone(status)).toBe(tone);
  });

  // FX10 (DESIGN-SPEC 6.10: "The cycle-count chip has padding 0 8 and no
  // border"): In progress, Completed and Canceled drew the default chip look,
  // a transparent 1 px border and 1 px of vertical padding (22 px). The three
  // wash tones now draw no border and no vertical padding (18 px).
  it.each([
    ['in_progress', 'In progress'],
    ['completed', 'Completed'],
    ['canceled', 'Canceled'],
  ] as const)('%s is the 18 px chip: padding 0 8 and no border', (status, words) => {
    render(<CycleCountStatusBadge status={status} />);
    const chip = screen.getByText(words);
    expect(chip).toHaveClass('border-0', 'py-0', 'px-2', 'rounded-full');
    expect(chip).not.toHaveClass('py-px');
  });

  it('keeps the outline tone`s hairline, its only edge, on an unknown status', () => {
    render(<CycleCountStatusBadge status="archived_by_migration" />);
    const chip = screen.getByText('archived_by_migration');
    expect(chip).toHaveClass('border', 'border-[var(--ed-line-strong)]', 'py-0');
    expect(chip).not.toHaveClass('border-0');
  });

  it('prints an unknown status as stored, in the outline tone', () => {
    render(<CycleCountStatusBadge status="archived_by_migration" />);
    expect(screen.getByText('archived_by_migration')).toBeInTheDocument();
    expect(cycleCountStatusTone('archived_by_migration')).toBe('outline');
  });
});
