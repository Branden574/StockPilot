import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// screen-access.ts reaches drawer-nav, which maps icon names to lucide
// components; the native package does not load under node.
vi.mock('./nav-icons', () => ({ NAV_ICONS: new Proxy({}, { get: () => () => null }) }));
vi.mock('./supabase', () => ({ supabase: {} }));

/**
 * REASSIGN AND RELEASE ON THE COUNT SCREEN FOLLOW THE CREATE-CONTROL RULE.
 *
 * The count screen offered Reassign (and Release of another member's count,
 * and counting a count assigned to someone else) to whoever might hold
 * cycle_counts:assign, by showWriteCta: shown whenever no permission set was
 * saved. Before the first sync nothing is saved, so a staff member saw
 * Reassign, which went away once the sync saved the staff set (lab walk row
 * 7). Staff's default permissions do not hold cycle_counts:assign. The
 * count's entry boxes had the same rule for stock:adjust, which a viewer's
 * defaults do not hold.
 *
 * Both now follow createControlOffer (screen-access.ts), the one rule for a
 * control that only leads to a write the server checks: the saved set when
 * this account has one for this workspace; before the first sync, the role's
 * defaults once the role is known. Reassign is shown only when offered; the
 * entry boxes stay open while it is not settled, as before.
 */

const COUNT = 'app/cycle-count/[id].tsx';

const flat = (file: string) =>
  readFileSync(path.resolve(__dirname, '../..', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');

describe('the count screen before the first sync', () => {
  it('offers Reassign only to a role whose defaults hold cycle_counts:assign, and counting only to one that holds stock:adjust', async () => {
    const { createControlOffer } = await import('./screen-access');
    expect(createControlOffer('not-synced', 'cycle_counts:assign', 'staff', false)).toBe('hidden');
    expect(createControlOffer('not-synced', 'cycle_counts:assign', 'manager', false)).toBe(
      'offered',
    );
    expect(createControlOffer('not-synced', 'stock:adjust', 'staff', false)).toBe('offered');
    expect(createControlOffer('not-synced', 'stock:adjust', 'viewer', false)).toBe('hidden');

    const code = flat(COUNT);
    expect(code).toContain("const assignOffer = useCreateControlOffer('cycle_counts:assign');");
    expect(code).toContain("const canManage = assignOffer === 'offered';");
    expect(code).toContain("const writeOffer = useCreateControlOffer('stock:adjust');");
    expect(code).toContain("const canWrite = writeOffer !== 'hidden';");
    expect(code).not.toContain('showWriteCta(');
    // Reassign is drawn from canManage alone.
    expect(code).toMatch(/\{isOpen && canManage \? \(/);
  });
});
