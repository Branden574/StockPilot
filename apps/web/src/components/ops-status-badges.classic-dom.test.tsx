import { render } from '@testing-library/react';
import type * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { classicDom, classicStructure, glassOnlyCount } from '@/test/classic-dom';

import { CycleCountStatusBadge } from './cycle-counts/cycle-count-status-badge';
import { MaintenanceStatusBadge } from './maintenance/maintenance-status-badge';
import { PoImportStatusBadge } from './po-imports/po-import-status-badge';
import { PoStatusBadge } from './po/po-status-badge';
import { RentalStatusBadge } from './rentals/rental-status-badge';
import { ReturnStatusBadge } from './returns/return-status-badge';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 4, operations lane). The status badges
 * of the operations pages (cycle counts, purchase orders and their imports,
 * returns, rentals, maintenance), every status each one knows plus one it does
 * not, pinned in __classic__/ from the code BEFORE the glass status hooks were
 * added. With the inert hooks stripped (src/test/classic-dom.ts), each badge
 * must render exactly the pinned DOM under the `off` rollout and under
 * `default`, with no glass-only part and no Classic element moved.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

/* The statuses are typed narrowly by each component; an unknown value is how
   a status this build does not know reaches it, so the cast is the point. */
const any = (v: string) => v as never;

const BADGES: Array<[string, React.ReactElement[]]> = [
  [
    'cycle-count',
    ['in_progress', 'completed', 'canceled', 'archived_later'].map((s) => (
      <CycleCountStatusBadge key={s} status={s} />
    )),
  ],
  [
    'purchase-order',
    [
      'draft',
      'expected_inbound',
      'ordered',
      'partially_received',
      'received',
      'cancelled',
      'unknown',
    ].map((s) => <PoStatusBadge key={s} status={s} />),
  ],
  [
    'po-import',
    [
      'uploaded',
      'parsing',
      'parsed',
      'needs_review',
      'approved',
      'failed',
      'duplicate',
      'canceled',
      'later_state',
    ].map((s) => <PoImportStatusBadge key={s} status={any(s)} />),
  ],
  [
    'return',
    ['requested', 'approved', 'received', 'closed', 'denied', 'cancelled', 'later_state'].map(
      (s) => <ReturnStatusBadge key={s} status={any(s)} />,
    ),
  ],
  [
    'rental',
    ['out', 'overdue', 'returned', 'cancelled'].map((s) => (
      <RentalStatusBadge key={s} status={any(s)} />
    )),
  ],
  [
    'maintenance',
    ['saved', 'draft_opened', 'resolved', 'archived', 'cancelled'].map((s) => (
      <MaintenanceStatusBadge key={s} status={any(s)} />
    )),
  ],
];

function classicOf(rollout: 'off' | 'default', badges: React.ReactElement[]) {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  const view = render(<div>{badges}</div>);
  const out = {
    dom: classicDom(view.container),
    structure: classicStructure(view.container),
    glassOnly: glassOnlyCount(view.container),
  };
  view.unmount();
  return out;
}

describe('Operations status badges: the Classic DOM is the pinned one', () => {
  for (const [name, badges] of BADGES) {
    it(`${name}: off and default normalise to the pinned DOM, with no glass-only part`, async () => {
      const off = classicOf('off', badges);
      const glassBuild = classicOf('default', badges);
      expect(off.glassOnly).toBe(0);
      expect(glassBuild.dom).toBe(off.dom);
      expect(glassBuild.structure).toBe(off.structure);
      await expect(off.dom).toMatchFileSnapshot(`./__classic__/ops-status-badges.${name}.txt`);
    });
  }
});
