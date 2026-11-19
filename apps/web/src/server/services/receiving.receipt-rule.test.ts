// Security invariant (listed in scripts/security-test.sh): ReceivingService
// posts a receipt only for a caller the database accepts (core
// canPostReceipt), and refuses everyone else before anything is read.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
const adminHolder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHolder.client }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

import {
  effectivePermissions,
  RECEIVE_MANAGER_ONLY_COPY,
  type Permission,
  type PermissionOverride,
  type PostReceiptInput,
  type Role,
} from '@stockpilot/core';

import { audit } from './audit';
import { ReceivingService } from './receiving';

const PO_ID = 'po-1';

const input: PostReceiptInput = {
  purchaseOrderId: PO_ID,
  warehouseId: 'wh-1',
  idempotencyKey: 'idem-1',
  lines: [{ poLineId: 'pol-1', qtyReceived: 2, qtyAccepted: 2, qtyRejected: 0, unitCost: 1 }],
};

function stub() {
  return makeSupabaseStub({
    'purchase_orders.select': servedLikePostgrest([{ id: PO_ID, organization_id: 'org-test' }]),
    'purchase_order_items.select': { data: [], error: null },
    'inventory_items.select': { data: [], error: null },
    'rpc:post_receipt_v2': {
      data: {
        id: 'rcpt-1',
        organization_id: 'org-test',
        warehouse_id: 'wh-1',
        purchase_order_id: PO_ID,
        receipt_number: 'RCV-000001',
        idempotency_key: 'idem-1',
        received_by: 'user-test',
      },
      error: null,
    },
  });
}

function svcFor(s: ReturnType<typeof stub>, role: Role, userOverrides: PermissionOverride[] = []) {
  const permissions: ReadonlySet<Permission> = effectivePermissions(role, [], userOverrides);
  return new ReceivingService(makeServiceContext(s.client, { role, permissions }));
}

beforeEach(() => {
  vi.clearAllMocks();
  adminHolder.client = makeSupabaseStub({
    'rpc:publish_outbox': { data: 'evt-1', error: null },
  }).client;
});

const POSTS: Array<[string, Role, PermissionOverride[]]> = [
  ['owner', 'owner', []],
  ['admin', 'admin', []],
  ['manager', 'manager', []],
  [
    'manager without purchase_orders:manage',
    'manager',
    [{ permission: 'purchase_orders:manage', granted: false }],
  ],
  [
    'manager without purchase_orders:read',
    'manager',
    [{ permission: 'purchase_orders:read', granted: false }],
  ],
];

const REFUSED: Array<[string, Role, PermissionOverride[], string]> = [
  ['staff', 'staff', [], RECEIVE_MANAGER_ONLY_COPY],
  [
    'staff granted purchase_orders:manage',
    'staff',
    [{ permission: 'purchase_orders:manage', granted: true }],
    RECEIVE_MANAGER_ONLY_COPY,
  ],
  [
    'staff granted purchase_orders:manage without stock:adjust',
    'staff',
    [
      { permission: 'purchase_orders:manage', granted: true },
      { permission: 'stock:adjust', granted: false },
    ],
    'Missing permission: stock:adjust',
  ],
  ['viewer', 'viewer', [], 'Missing permission: stock:adjust'],
  [
    'viewer granted stock:adjust',
    'viewer',
    [{ permission: 'stock:adjust', granted: true }],
    RECEIVE_MANAGER_ONLY_COPY,
  ],
  [
    'manager without stock:adjust',
    'manager',
    [{ permission: 'stock:adjust', granted: false }],
    'Missing permission: stock:adjust',
  ],
];

describe('postReceipt asks the rule the database applies, before anything is read', () => {
  for (const [name, role, overrides] of POSTS) {
    it(`${name}: the receipt posts`, async () => {
      const s = stub();
      const receipt = await svcFor(s, role, overrides).postReceipt(input);
      expect(receipt.id).toBe('rcpt-1');
      expect(s.rpcCalls.map((c) => c.name)).toEqual(['post_receipt_v2']);
    });
  }

  for (const [name, role, overrides, message] of REFUSED) {
    it(`${name}: refused as forbidden with "${message}", with nothing read, called or recorded`, async () => {
      const s = stub();
      const err = await svcFor(s, role, overrides)
        .postReceipt(input)
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'forbidden', message });
      // The sentence alone: installed phones show details.reason in place of it.
      expect((err as { details?: unknown }).details).toBeUndefined();
      expect(s.fromCalls).toEqual([]);
      expect(s.rpcCalls).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });
  }
});
