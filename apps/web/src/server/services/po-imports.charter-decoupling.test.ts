import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * BILL-TO IS NOT PLACEMENT (owner defect, 2026-07-22).
 *
 * approve() used to read ONE field — `input.charterId`, documented in
 * approvePoImportSchema as bill-to only — and use it for two jobs: it decided
 * which inventory_items row every line receives against (ownership, operational)
 * AND it was written to purchase_orders.charter_id (bill-to, financial). The
 * last line of that path was literally `const billToCharterId = selectedCharterId`
 * — an alias, not a second value. Choosing who to bill silently re-chartered
 * the stock, contradicting both the schema's own doc comment and the web form's
 * own help text.
 *
 * These tests pin the separation at the only layer that actually writes
 * placement: the service.
 *
 *   charterId      → purchase_orders.charter_id, and nothing else, ever.
 *   itemCharterId  → inventory_items.charter_id, and nothing else, ever.
 *   itemCharterId absent → NO item's ownership is touched at all.
 *
 * Nothing here may be satisfied by making one value flow into both.
 */

const { mockAudit: _mockAudit, mockInvCreate: _mockInvCreate } = vi.hoisted(() => ({
  mockAudit: vi.fn(async () => {}),
  // Typed params so `.mock.calls[0]` is a 2-tuple, not `[]` — the test asserts
  // WHICH charter the sibling is born under, which is the whole point.
  mockInvCreate: vi.fn(
    async (_input: Record<string, unknown>, _opts?: Record<string, unknown>) => ({
      id: 'itm-new-sibling',
    }),
  ),
}));
vi.mock('./audit', () => ({ audit: _mockAudit }));
vi.mock('./inventory', () => ({
  InventoryService: class {
    create = _mockInvCreate;
  },
}));
vi.mock('@/lib/po-parser', () => ({ parsePoFile: vi.fn() }));
vi.mock('@/lib/po-scan/extract', () => ({ extractPoFromMedia: vi.fn(), SCAN_MODEL_NAME: 'mock' }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

const mockAudit = _mockAudit;
const mockInvCreate = _mockInvCreate;

import { ServiceError } from './context';
import { PoImportsService } from './po-imports';

const IMPORT_ID = 'imp-1';
const WH = 'aaaaaaaa-0000-0000-0000-000000000001';

/** Operational: where it receives, and who owns the stock. */
const LOC_A = 'loc-operational-A';
const CHARTER_A = 'chr-operational-A';
/** Billing: who gets the invoice. Deliberately a DIFFERENT value from A. */
const CHARTER_B = 'chr-billto-B';

beforeEach(() => {
  vi.clearAllMocks();
  mockInvCreate.mockResolvedValue({ id: 'itm-new-sibling' });
});

/**
 * approve() stub with ONE inventory line already linked to a pre-existing item
 * that is owned by neither A nor B — so any re-resolution the service performs
 * is forced to name the charter it believes owns the stock, and the test can
 * read which one it named.
 *
 * `charters.select.maybeSingle` backs resolveOrgCharterId, which is called
 * twice in a fixed order (bill-to first, then ownership). The stub is keyed per
 * (table, op) rather than per argument, so the two answers are sequenced by a
 * counter — and every test that relies on it ALSO asserts the ids that were
 * actually queried, so a reordering can never quietly pass.
 */
function makeStub(opts: { sibling?: { id: string } | null; locationRow?: { id: string } | null } = {}) {
  const charterAnswers = [{ id: CHARTER_B }, { id: CHARTER_A }];
  let charterCall = 0;
  let lineSelectCall = 0;
  const locationRow = 'locationRow' in opts ? opts.locationRow : { id: LOC_A };
  return makeSupabaseStub({
    'po_imports.select': {
      data: { id: IMPORT_ID, organization_id: 'org-test', status: 'parsed', warehouse_id: WH },
      error: null,
    },
    'po_import_lines.select': () => {
      lineSelectCall += 1;
      return lineSelectCall === 1
        ? {
            data: [
              {
                id: 'line-1',
                line_number: 1,
                line_type: 'inventory',
                item_id: 'itm-preexisting',
                qty_ordered_original: 3,
                unit_cost: 4,
                line_total: 12,
              },
            ],
            error: null,
          }
        : { data: [], error: null };
    },
    'charters.select.maybeSingle': () => {
      const answer = charterAnswers[charterCall] ?? null;
      charterCall += 1;
      return { data: answer, error: null };
    },
    // The linked-items read (awaited array).
    'inventory_items.select': {
      data: [
        {
          id: 'itm-preexisting',
          sku: 'SKU-1',
          name: 'Pre-existing widget',
          barcode: null,
          charter_id: 'chr-something-else',
          unit_cost: 4,
          retail_price: 9,
          category_id: null,
          supplier_id: null,
          warehouse_id: WH,
          unit_of_measure: 'unit',
          item_type: 'product',
          tracking_type: 'none',
        },
      ],
      error: null,
    },
    // The same-SKU sibling lookup (.maybeSingle) — separate key.
    'inventory_items.select.maybeSingle': {
      data: 'sibling' in opts ? opts.sibling : null,
      error: null,
    },
    'rpc:next_po_number': { data: 'PO-500', error: null },
    'locations.select': { data: locationRow ?? null, error: null },
    'purchase_orders.insert': { data: { id: 'po-new' }, error: null },
    'purchase_order_items.insert': { data: null, error: null },
    'purchase_order_charges.insert': { data: null, error: null },
    'inventory_items.update': { data: null, error: null },
    'po_import_lines.update': { data: { id: 'line-1' }, error: null },
    // approve() CLAIMS the import (conditional update) before it inserts
    // the PO, and stamps approved_po_id afterwards. Both are checked
    // writes, so the stub has to answer with a ROW or every approval
    // reads as a lost race.
    'po_imports.update': { data: { id: IMPORT_ID }, error: null },
  });
}

function svc(stub: ReturnType<typeof makeSupabaseStub>) {
  return new PoImportsService(makeServiceContext(stub.client) as never);
}

/** Every argument ever passed to any chain method for a (table, op). */
function allArgs(stub: ReturnType<typeof makeSupabaseStub>, key: string): unknown[] {
  return (stub.chainArgsAll.get(key) ?? []).flat(Infinity);
}

// ─── TEST 1 (owner-required) ──────────────────────────────────────────────────

describe('OWNER TEST 1 — operational charter/location A, bill-to B, one import', () => {
  it('places the PO under A and bills it to B, with neither value leaking into the other', async () => {
    // A sibling already exists under the OPERATIONAL charter, so the line is
    // remapped onto it rather than a new item being spawned.
    const stub = makeStub({ sibling: { id: 'itm-sibling-under-A' } });

    const res = await svc(stub).approve({
      poImportId: IMPORT_ID,
      vendorId: 'vendor-1',
      warehouseId: WH,
      // OPERATIONAL
      locationId: LOC_A,
      itemCharterId: CHARTER_A,
      // BILLING
      charterId: CHARTER_B,
      lineOverrides: [],
    } as never);

    expect(res.poId).toBe('po-new');

    const poInsert = stub.chainArgs.get('purchase_orders.insert')?.[0]?.[0] as Record<
      string,
      unknown
    >;

    // OPERATIONAL PLACEMENT is A — the receiving location the user picked.
    expect(poInsert.destination_location_id).toBe(LOC_A);
    // …and it is NOT any billing value.
    expect(poInsert.destination_location_id).not.toBe(CHARTER_B);

    // BILL-TO on the PO document is B, preserved exactly (B1).
    expect(poInsert.charter_id).toBe(CHARTER_B);
    // …and specifically NOT the operational charter. Before the fix these two
    // assertions could not both hold: one value served both fields.
    expect(poInsert.charter_id).not.toBe(CHARTER_A);

    // OWNERSHIP resolution named the OPERATIONAL charter. The sibling lookup is
    // the query that decides which item instance receives the stock.
    const invSelectArgs = allArgs(stub, 'inventory_items.select');
    expect(invSelectArgs).toContain(CHARTER_A);
    expect(invSelectArgs).not.toContain(CHARTER_B);

    // The line was remapped onto the instance owned by A.
    expect(allArgs(stub, 'po_import_lines.update')).toContain('line-1');
    const remapPayload = stub.chainArgs.get('po_import_lines.update')?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(remapPayload.item_id).toBe('itm-sibling-under-A');

    // Both charter ids were resolved against the org independently — proof the
    // two lookups are two lookups, not one value reused.
    const charterArgs = allArgs(stub, 'charters.select');
    expect(charterArgs).toContain(CHARTER_A);
    expect(charterArgs).toContain(CHARTER_B);

    // The audit trail can tell the two apart from here on.
    const approved = mockAudit.mock.calls
      .map((c) => (c as unknown as [Record<string, unknown>])[0])
      .find((a) => a.event === 'po_import.approved');
    const after = approved?.after as Record<string, unknown>;
    expect(after.billToCharterId).toBe(CHARTER_B);
    expect(after.itemCharterId).toBe(CHARTER_A);
    expect(after.destinationLocationId).toBe(LOC_A);
  });
});

// ─── The reported defect, as a regression ─────────────────────────────────────

describe('approve — a bill-to charter alone never touches ownership', () => {
  it('sets bill-to and re-charters NOTHING when no ownership charter is stated', async () => {
    const stub = makeStub({ sibling: { id: 'itm-sibling-under-B' } });

    // The exact real-world shape of the bug: the user picks who to bill and
    // leaves the ownership control alone (its default). Doing nothing must be
    // the harmless path.
    await svc(stub).approve({
      poImportId: IMPORT_ID,
      vendorId: 'vendor-1',
      warehouseId: WH,
      locationId: LOC_A,
      charterId: CHARTER_B,
      // itemCharterId deliberately ABSENT.
      lineOverrides: [],
    } as never);

    // Bill-to still lands (B1 — billing metadata is preserved, not suppressed).
    const poInsert = stub.chainArgs.get('purchase_orders.insert')?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(poInsert.charter_id).toBe(CHARTER_B);
    expect(poInsert.destination_location_id).toBe(LOC_A);

    // …and the entire ownership block was SKIPPED: no linked-item read, no
    // sibling lookup, no sibling creation, no line remap.
    expect(stub.chainsAll.get('inventory_items.select')).toBeUndefined();
    expect(mockInvCreate).not.toHaveBeenCalled();
    expect(stub.chainsAll.get('po_import_lines.update')).toBeUndefined();

    // The only inventory_items writes are the created_from stamp — no payload
    // anywhere carries a charter_id. This is the assertion the old code fails.
    const updatePayloads = (stub.chainArgsAll.get('inventory_items.update') ?? []).map(
      (chain) => chain[0]?.[0] as Record<string, unknown> | undefined,
    );
    for (const payload of updatePayloads) {
      expect(payload ?? {}).not.toHaveProperty('charter_id');
    }

    // Only ONE charter lookup happened (bill-to), and it asked for B.
    expect(allArgs(stub, 'charters.select')).toContain(CHARTER_B);
    expect(allArgs(stub, 'charters.select')).not.toContain(CHARTER_A);

    const approved = mockAudit.mock.calls
      .map((c) => (c as unknown as [Record<string, unknown>])[0])
      .find((a) => a.event === 'po_import.approved');
    expect((approved?.after as Record<string, unknown>).ownershipApplied).toBe(false);
  });

  it('treats an explicit null ownership charter as a real choice, not as "absent"', async () => {
    // null means "move ownership to Generic" and MUST still run the block —
    // collapsing null and undefined back together is how a blank form field
    // became a destructive re-charter in the first place.
    const stub = makeStub({ sibling: null });

    await svc(stub).approve({
      poImportId: IMPORT_ID,
      vendorId: 'vendor-1',
      warehouseId: WH,
      locationId: LOC_A,
      charterId: CHARTER_B,
      itemCharterId: null,
      lineOverrides: [],
    } as never);

    // The block ran (the item was under a charter, target is Generic).
    expect(stub.chainsAll.get('inventory_items.select')).toBeDefined();
    // No sibling under Generic existed and the item was NOT created by this
    // import, so a qty-0 Generic sibling was born (B7 capability, target null).
    expect(mockInvCreate).toHaveBeenCalledTimes(1);
    expect(mockInvCreate.mock.calls[0]![0]).toMatchObject({ charterId: null });

    // Bill-to is untouched by any of it.
    const poInsert = stub.chainArgs.get('purchase_orders.insert')?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(poInsert.charter_id).toBe(CHARTER_B);
  });
});

// ─── B7: the charter-sibling capability survives, on the right field ──────────

describe('approve — charter-sibling capability (B7) sources from itemCharterId', () => {
  it('births the qty-0 sibling under the OWNERSHIP charter, never the bill-to charter', async () => {
    // Pre-existing item under some other charter, no sibling under A yet — the
    // real case this capability exists for: receiving must post the units under
    // the charter that owns them, so it needs a row to post to.
    const stub = makeStub({ sibling: null });

    await svc(stub).approve({
      poImportId: IMPORT_ID,
      vendorId: 'vendor-1',
      warehouseId: WH,
      locationId: LOC_A,
      itemCharterId: CHARTER_A,
      charterId: CHARTER_B,
      lineOverrides: [],
    } as never);

    expect(mockInvCreate).toHaveBeenCalledTimes(1);
    const [createInput, createOpts] = mockInvCreate.mock.calls[0]!;
    // Born under the OWNERSHIP charter…
    expect(createInput.charterId).toBe(CHARTER_A);
    expect(createInput.charterId).not.toBe(CHARTER_B);
    // …at qty 0, same SKU, and still Expected (awaiting first receipt) so it
    // hides under the Expected chip instead of showing as "Out of stock"
    // (commit 8baf8343 — do not regress).
    expect(createInput.quantityOnHand).toBe(0);
    expect(createInput.sku).toBe('SKU-1');
    expect(createOpts).toMatchObject({ awaitingFirstReceipt: true });

    // …and the import line now points at that sibling.
    const remapPayload = stub.chainArgs.get('po_import_lines.update')?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(remapPayload.item_id).toBe('itm-new-sibling');
  });
});

// ─── B3/B6: billing-only documents leave placement unresolved ─────────────────

describe('approve — a document that yields only billing info blocks on placement', () => {
  it('refuses to approve without a destination location, even with a bill-to charter set', async () => {
    const stub = makeStub();

    const thrown = await svc(stub)
      .approve({
        poImportId: IMPORT_ID,
        vendorId: 'vendor-1',
        warehouseId: WH,
        // No locationId — the AI extraction schema carries no warehouse,
        // location or charter, so a billing-only document leaves this unset.
        charterId: CHARTER_B,
        lineOverrides: [],
      } as never)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('validation_error');
    // A specific, actionable message — the user resolves it, the import does
    // not guess (B3).
    expect((thrown as ServiceError).message).toBe(
      'Pick a destination location for this warehouse.',
    );

    // Nothing was placed, nothing was created, and crucially the bill-to
    // charter was NOT substituted for the missing location.
    expect(stub.chainsAll.get('purchase_orders.insert')).toBeUndefined();
    expect(stub.chainsAll.get('locations.insert')).toBeUndefined();
    expect(stub.chainsAll.get('locations.select')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B3 on the OPERATIONAL field, not just the billing one.
//
// resolveOrgCharterId used to return null for anything it could not resolve.
// For a billing value that is harmless (no Bill-to block on the PDF). For the
// ownership value null is not "unknown" — it is the explicit Generic choice —
// so an unresolvable id silently became "re-charter every line to Generic".
// It also swallowed the query error, so a transient failure destroyed the same
// way. Both are the silent substitution of an operational value B3 forbids.
// ---------------------------------------------------------------------------

describe('a stated charter that does not resolve is refused, never coerced', () => {
  it('refuses an ownership charter that is not in this organization', async () => {
    // The charter lookup finds nothing: another org's id, or a stale one.
    const stub = makeStub();
    stub.client.from = ((table: string) => {
      const real = makeStub().client.from(table);
      if (table !== 'charters') return real;
      return {
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        }),
      };
    }) as never;

    await expect(
      svc(stub).approve({
        poImportId: IMPORT_ID,
        vendorId: 'vendor-1',
        warehouseId: WH,
        locationId: LOC_A,
        itemCharterId: CHARTER_A,
        charterId: CHARTER_B,
        lineOverrides: [],
      } as never),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('does not treat a charter LOOKUP FAILURE as the Generic choice', async () => {
    const stub = makeStub();
    stub.client.from = ((table: string) => {
      const real = makeStub().client.from(table);
      if (table !== 'charters') return real;
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: { message: 'connection reset' } }),
            }),
          }),
        }),
      };
    }) as never;

    await expect(
      svc(stub).approve({
        poImportId: IMPORT_ID,
        vendorId: 'vendor-1',
        warehouseId: WH,
        locationId: LOC_A,
        itemCharterId: CHARTER_A,
        charterId: CHARTER_B,
        lineOverrides: [],
      } as never),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });
});
