import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { dbPermissionRefusedCopy, type Permission } from '@stockpilot/core';

import { showWriteCtaForRole } from './cta-gating';

/**
 * Small fixes slice 2 review: two stock actions the phone offered to people
 * the app refuses (and, since 0395, the database refuses too).
 *
 *   1. The item screen's "Transfer / put away" was `isManager || can(...,
 *      'stock:transfer')`, so a manager whose stock:transfer an admin revoked
 *      was still offered it and refused with "Missing permission". It follows
 *      the permission alone now, through showWriteCtaForRole, the gate the
 *      same screen already uses for stock:adjust.
 *   2. The PO screen offered Scan, the quantities and "Post receipt" to
 *      everyone who can read purchase orders: in production 9 viewers and the
 *      one staff member with stock:adjust revoked, all refused on Post
 *      receipt. Receiving follows stock:adjust now; without it the PO reads
 *      like a draft (no Scan, no quantities, no Post receipt) and says why in
 *      the words the server's own refusal maps to.
 *
 * The screens cannot be rendered here (vitest excludes app/: they import
 * native modules), so these pin the wiring in the source, plus the rule itself.
 */

function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const item = codeOnly(readFileSync(path.resolve(__dirname, '../../app/item/[id].tsx'), 'utf8'));
const po = codeOnly(readFileSync(path.resolve(__dirname, '../../app/po/[id].tsx'), 'utf8'));

describe('the rule: the effective permission, whatever the role', () => {
  it('a manager whose stock:transfer was revoked is not offered Transfer; one who has it is', () => {
    const revoked = new Set<Permission>(['items:read', 'stock:adjust']);
    expect(showWriteCtaForRole('manager', revoked, 'stock:transfer')).toBe(false);
    expect(showWriteCtaForRole('manager', new Set<Permission>(['stock:transfer']), 'stock:transfer')).toBe(true);
  });

  it('a viewer, and staff with stock:adjust revoked, are not offered receiving', () => {
    expect(showWriteCtaForRole('viewer', undefined, 'stock:adjust')).toBe(false);
    expect(showWriteCtaForRole('staff', new Set<Permission>(['purchase_orders:read']), 'stock:adjust')).toBe(false);
    expect(showWriteCtaForRole('staff', undefined, 'stock:adjust')).toBe(true);
  });
});

describe('item screen: Transfer / put away', () => {
  it('follows stock:transfer through showWriteCtaForRole, with no manager-by-role short-circuit', () => {
    expect(item).toMatch(/const canTransfer = showWriteCtaForRole\(role, permissions, 'stock:transfer'\);/);
    expect(item).not.toMatch(/isManager \|\|[^;]*'stock:transfer'/);
  });
});

describe('PO screen: receiving follows stock:adjust', () => {
  it('reads the role and the effective permissions and gates receiving on stock:adjust', () => {
    expect(po).toMatch(/const \{ role \} = useRole\(\);/);
    expect(po).toMatch(/const permissions = useEffectivePermissions\(\);/);
    expect(po).toMatch(/const canReceive = showWriteCtaForRole\(role, permissions, 'stock:adjust'\);/);
    expect(po).toMatch(/const readOnly = reviewOnly \|\| !canReceive;/);
  });

  it('without it: no Scan, no quantities, no Post receipt, size runs shown line by line', () => {
    // Every receive affordance follows readOnly (a draft, or no permission).
    expect(po).toMatch(/\{readOnly \? null : \(\s*<Pressable\s+onPress=\{openScanner\}/);
    expect(po).toMatch(/\{readOnly \? null : \(\s*<View style=\{styles\.footer\}>/);
    expect(po).toMatch(/buildPoBlocks\(lines, readOnly \? \{\} : groups\)/);
    expect(po).toMatch(/const receivable =\s*!readOnly && lines\.some/);
  });

  it("says why, in the server's words for the same refusal, only when there is something left to receive", () => {
    expect(po).toMatch(/dbPermissionRefusedCopy\('receipt_post'\)/);
    expect(dbPermissionRefusedCopy('receipt_post')).toBe(
      'Receiving stock needs the Adjust on-hand permission. Ask an admin if you need it.',
    );
    expect(po).toMatch(/!reviewOnly && !canReceive && hasOutstanding/);
  });
});
