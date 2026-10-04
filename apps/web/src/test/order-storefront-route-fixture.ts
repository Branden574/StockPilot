/**
 * Shared fixture for the phone storefront's route tests (phone ordering PO-3):
 * a caller context over a stubbed client that answers the caller's own reads
 * (warehouses, profile, organization row, recent requesters), and catalog
 * rows. Loaders are mocked by each test file.
 */
import { DEFAULT_MODULE_IDS, type ModuleId, type Role } from '@stockpilot/core';

import type { CatalogItem } from '@/components/orders/v2/types';
import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

export const SF_ORG = '00000000-0000-4000-8000-00000000000a';
export const SF_USER = '00000000-0000-4000-8000-0000000000aa';
export const SF_WH = '00000000-0000-4000-8000-0000000000b1';
export const SF_WH_FOREIGN = '00000000-0000-4000-8000-0000000000b9';

export function sfItem(id: string, over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id,
    sku: `SKU-${id}`,
    name: `Item ${id}`,
    warehouseId: SF_WH,
    quantityOnHand: 10,
    reservedQuantity: 0,
    itemType: 'product',
    categoryId: null,
    categoryName: null,
    charterId: null,
    charterName: null,
    charterCode: null,
    rackLabel: null,
    imageUrl: null,
    lqip: null,
    price: 42,
    reorderPoint: 0,
    ...over,
  };
}

export function sfContext(
  over: {
    role?: Role;
    permissions?: string[];
    modules?: ModuleId[];
    mfaRequired?: boolean;
    mfaSatisfied?: boolean;
    mfaEnrolled?: boolean;
    results?: Record<string, unknown>;
  } = {},
) {
  const stub = makeSupabaseStub({
    'warehouses.select': servedLikePostgrest([
      { id: SF_WH, name: 'DC4', organization_id: SF_ORG, status: 'active' },
    ]),
    'user_profiles.select': { data: { full_name: 'Pat', email: 'pat@example.org' }, error: null },
    'organizations.select': { data: { timezone: 'UTC', email_routing: null }, error: null },
    'rpc:order_recent_requesters': { data: [], error: null },
    ...(over.results as Record<string, never>),
  });
  const ctx = {
    ...makeServiceContext(stub.client, {
      organizationId: SF_ORG,
      userId: SF_USER,
      role: over.role ?? 'staff',
      ...(over.permissions ? { permissions: new Set(over.permissions) } : {}),
      enabledModules: new Set(over.modules ?? DEFAULT_MODULE_IDS),
      mfaRequired: over.mfaRequired ?? false,
      mfaSatisfied: over.mfaSatisfied ?? true,
    }),
    mfaEnrolled: over.mfaEnrolled ?? false,
  };
  return { stub, ctx };
}
