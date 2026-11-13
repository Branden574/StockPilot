import { render } from '@testing-library/react';
import type * as React from 'react';
import { describe, expect, it } from 'vitest';

import { CycleCountStatusBadge } from './cycle-counts/cycle-count-status-badge';
import { MaintenanceStatusBadge } from './maintenance/maintenance-status-badge';
import { PoImportStatusBadge } from './po-imports/po-import-status-badge';
import { PoStatusBadge } from './po/po-status-badge';
import { RentalStatusBadge } from './rentals/rental-status-badge';
import { ReturnStatusBadge } from './returns/return-status-badge';

/**
 * The operations status badges name themselves to Liquid Glass (stage 4,
 * operations lane): each carries the inert hooks data-glass-role="status"
 * and data-glass-state="<the status it was given>", so pages/ops.css can draw
 * the board's dot and, where a board names another tone for a status (a
 * count in progress, a received return), that tone, without reading the
 * words. The hooks are stripped by the Classic proof
 * (ops-status-badges.classic-dom.test.tsx pins the Classic DOM).
 */

/* An unknown value is how a status this build does not know reaches a badge. */
const any = (v: string) => v as never;

type Make = (status: string) => React.ReactElement;
const cases = (what: string, statuses: string[], make: Make): Array<[string, string, Make]> =>
  statuses.map((s) => [what, s, make]);

const CASES: Array<[string, string, Make]> = [
  ...cases('cycle count', ['in_progress', 'completed', 'canceled', 'later_state'], (v) => (
    <CycleCountStatusBadge status={v} />
  )),
  ...cases(
    'purchase order',
    ['draft', 'ordered', 'partially_received', 'received', 'cancelled', 'unknown'],
    (v) => <PoStatusBadge status={v} />,
  ),
  ...cases('PO import', ['uploaded', 'needs_review', 'approved', 'failed', 'later_state'], (v) => (
    <PoImportStatusBadge status={any(v)} />
  )),
  ...cases(
    'return',
    ['requested', 'approved', 'received', 'closed', 'denied', 'cancelled', 'later_state'],
    (v) => <ReturnStatusBadge status={any(v)} />,
  ),
  ...cases('rental', ['out', 'overdue', 'returned', 'cancelled'], (v) => (
    <RentalStatusBadge status={any(v)} />
  )),
  ...cases('maintenance', ['saved', 'draft_opened', 'resolved', 'archived', 'cancelled'], (v) => (
    <MaintenanceStatusBadge status={any(v)} />
  )),
];

describe('Operations status badges: the glass status hooks', () => {
  for (const [what, status, make] of CASES) {
    it(`${what} "${status}": the badge carries data-glass-role="status" and its status`, () => {
      const { container } = render(make(status));
      const badge = container.querySelector('[data-glass="badge"]');
      expect(badge).not.toBeNull();
      expect(badge!.getAttribute('data-glass-role')).toBe('status');
      expect(badge!.getAttribute('data-glass-state')).toBe(status);
    });
  }
});
