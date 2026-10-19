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

  it('prints an unknown status as stored, in the outline tone', () => {
    render(<CycleCountStatusBadge status="archived_by_migration" />);
    expect(screen.getByText('archived_by_migration')).toBeInTheDocument();
    expect(cycleCountStatusTone('archived_by_migration')).toBe('outline');
  });
});
