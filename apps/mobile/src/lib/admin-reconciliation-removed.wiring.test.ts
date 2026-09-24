import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * S5-C (owner default D9): the Admin > Reconciliation screen is gone. It
 * queried cycle_counts.status = 'posted' and a posted_at column, neither of
 * which exists, swallowed the error and always showed "No posted counts yet".
 * Posted counts live in Cycle counts (filter Completed), and the admin menu
 * points there instead.
 */
const app = path.join(__dirname, '../../app/(drawer)');
const adminIndex = readFileSync(path.join(app, 'admin/index.tsx'), 'utf8');
const drawer = readFileSync(path.join(app, '_layout.tsx'), 'utf8');

describe('the dead Reconciliation screen is removed', () => {
  it('the screen file no longer exists', () => {
    expect(existsSync(path.join(app, 'admin/reconciliation.tsx'))).toBe(false);
  });

  it('neither the admin menu nor the drawer routes to it', () => {
    expect(adminIndex).not.toContain('/admin/reconciliation');
    expect(drawer).not.toContain('admin/reconciliation');
  });

  it('the admin menu points to the cycle-count history instead', () => {
    expect(adminIndex).toMatch(/href: '\/cycle-counts', label: 'Count history'/);
  });

  it('nothing in the app still reads the columns that never existed', () => {
    for (const file of [adminIndex, drawer]) {
      expect(file).not.toMatch(/posted_at|status', 'posted'/);
    }
  });
});
