import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The Vendor item mappings page header (docket S17): every organization sees
 * its example, so it names no real retailer or item number.
 */

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ organizationId: 'org-1' })),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    from: () => ({
      select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }),
    }),
  })),
}));
vi.mock('@/server/services/suppliers', () => ({
  SuppliersService: { forCurrentUser: async () => ({ listForLookups: async () => [] }) },
}));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: { forCurrentUser: async () => ({ list: async () => ({ items: [] }) }) },
}));
vi.mock('@/lib/nav-labels', () => ({
  effectiveNavLabel: vi.fn(async (_href: string, fallback: string) => fallback),
}));
vi.mock('@/components/admin/vendor-mappings-manager', () => ({
  VendorMappingsManager: () => null,
}));

import VendorMappingsPage from './page';

describe('VendorMappingsPage', () => {
  it('explains a mapping with a generic example', async () => {
    render(await VendorMappingsPage());
    expect(
      screen.getByRole('heading', { level: 1, name: 'Vendor item mappings' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Map vendor product numbers (for example, the item number on a supplier's invoice) to your internal items so future PO uploads auto-resolve.",
      ),
    ).toBeInTheDocument();
  });
});
