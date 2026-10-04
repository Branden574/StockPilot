import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Who sees "Requesting for: someone else" on the New order page (security
 * slice D, migration 0390). The storefront is a client component with no
 * request context, so it cannot call can(ctx, ...): it used to derive the
 * answer from the role (isManagerOrAbove(viewerRole)), which showed the
 * option to a manager whose orders:approve was revoked (the database then
 * refuses the order) and hid it from a staff member granted it (the database
 * allows it). The server page now computes the effective permission and
 * passes it down; this pins that wiring.
 */
const STOREFRONT = readFileSync(path.resolve(__dirname, 'orders-storefront.tsx'), 'utf8');
const PAGE = readFileSync(
  path.resolve(__dirname, '../../../app/(dashboard)/dashboard/orders/new/page.tsx'),
  'utf8',
);

describe('on-behalf ordering follows orders:approve', () => {
  it('the server page passes the effective permission', () => {
    expect(PAGE).toContain("canActOnBehalf={can(ctx, 'orders:approve')}");
    expect(PAGE).not.toMatch(/viewerRole=/);
  });

  it('the storefront takes it as a prop and never derives it from the role', () => {
    expect(STOREFRONT).toMatch(/^\s*canActOnBehalf: boolean;$/m);
    expect(STOREFRONT).not.toMatch(/isManagerOrAbove/);
    expect(STOREFRONT).not.toMatch(/viewerRole/);
    expect(STOREFRONT).toContain('{canActOnBehalf && (');
  });
});
