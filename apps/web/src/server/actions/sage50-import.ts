'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { assertPermission, ServiceError, withContext } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { fetchAllRows } from '@/server/services/lib/paginate';
import { SuppliersService } from '@/server/services/suppliers';

import { can, err, ok, type ActionResult } from '@stockpilot/core';

/**
 * "Migrate from Sage 50" import. The wizard parses + maps the Sage 50 CSV
 * exports client-side (lib/sage50.ts) and submits the already-normalized
 * payload here IN CHUNKS (the wizard slices large catalogs so no single call
 * outgrows the server-action body limit or the function timeout). Items go
 * through InventoryService.create (ledger-correct initial quantities, RLS,
 * items:import, warehouse write-access check); vendors become suppliers via
 * SuppliersService when the caller can manage them — otherwise the supplier
 * step is SKIPPED with a disclosed reason rather than failing the migration.
 *
 * Validation is PER ROW: one malformed row fails that row (counted + listed),
 * never the whole batch — mirroring the behavior of the standard CSV importer.
 */

const itemSchema = z.object({
  name: z.string().min(1).max(200),
  sku: z.string().min(1).max(64),
  barcode: z.string().max(128).nullable(),
  description: z.string().max(5000).nullable(),
  unit_cost: z.number().nonnegative().finite(),
  retail_price: z.number().nonnegative().finite(),
  quantity_on_hand: z.number().nonnegative().finite(),
  reorder_point: z.number().nonnegative().finite(),
  reorder_quantity: z.number().nonnegative().finite(),
  unit_of_measure: z.string().max(32),
  inactive: z.boolean(),
  vendorId: z.string().max(64).nullable(),
});

// Bounds match createSupplierSchema (the canonical supplier floor) so this
// path can't persist values every other supplier-creation path rejects.
const vendorSchema = z.object({
  vendorId: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  contactName: z.string().max(120).nullable(),
  email: z.string().email().max(254).nullable(),
  phone: z.string().max(40).nullable(),
});

const importSchema = z.object({
  /** Warehouse the imported items belong to (items must open in one). */
  warehouseId: z.string().uuid(),
  /** Index of this chunk's first item in the original CSV — keeps reported
   *  row numbers true across chunked submissions. */
  rowOffset: z.number().int().nonnegative().default(0),
  items: z.array(z.unknown()).min(1).max(1000),
  vendors: z.array(z.unknown()).max(2000).default([]),
});

export interface Sage50ImportSummary {
  items: {
    total: number;
    created: number;
    failed: number;
    errors: { row: number; sku: string; message: string }[];
  };
  suppliers: {
    total: number;
    created: number;
    reused: number;
    /** Vendor rows that individually failed (bad data / insert error). */
    failed: number;
    /** True when the whole supplier step was skipped — items import unlinked. */
    skipped: boolean;
    skippedReason: string | null;
  };
}

export async function importSage50Action(
  input: z.input<typeof importSchema>,
): Promise<ActionResult<Sage50ImportSummary>> {
  const parsed = importSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  try {
    const ctx = await withContext();
    assertPermission(ctx, 'items:import');

    const summary: Sage50ImportSummary = {
      items: { total: parsed.data.items.length, created: 0, failed: 0, errors: [] },
      suppliers: {
        total: parsed.data.vendors.length,
        created: 0,
        reused: 0,
        failed: 0,
        skipped: false,
        skippedReason: null,
      },
    };

    // ── Suppliers first (so items can link). Sage vendorId → supplier uuid. ──
    const vendorToSupplier = new Map<string, string>();
    if (parsed.data.vendors.length > 0) {
      // Pre-check instead of catch-and-classify: the suppliers module is tier
      // 'optional' (genuinely off for some orgs) and staff lack the manage
      // permission — both must degrade to "items import unlinked", never to a
      // failed migration.
      if (!ctx.enabledModules.has('suppliers')) {
        summary.suppliers.skipped = true;
        summary.suppliers.skippedReason = 'the Suppliers module is not enabled';
      } else if (!can(ctx, 'suppliers:manage')) {
        summary.suppliers.skipped = true;
        summary.suppliers.skippedReason = 'your role can’t manage suppliers';
      } else {
        try {
          const suppliers = new SuppliersService(ctx);
          // Existing suppliers reuse by case-insensitive name (never duplicate).
          // PAGINATED read — a single select is silently capped at 1000 rows,
          // and this wizard alone can push an org past that.
          const existing = await fetchAllRows<{ id: string; name: string }>((from, to) =>
            ctx.supabase
              .from('suppliers')
              .select('id, name')
              .eq('organization_id', ctx.organizationId)
              .is('deleted_at', null)
              .order('id')
              .range(from, to),
          );
          const byName = new Map(existing.map((s) => [s.name.trim().toLowerCase(), s.id]));

          for (const raw of parsed.data.vendors) {
            const pv = vendorSchema.safeParse(raw);
            if (!pv.success) {
              summary.suppliers.failed++;
              continue;
            }
            const v = pv.data;
            const key = v.name.trim().toLowerCase();
            const existingId = byName.get(key);
            if (existingId) {
              vendorToSupplier.set(v.vendorId, existingId);
              summary.suppliers.reused++;
              continue;
            }
            // PER-VENDOR fault isolation: one bad row (or a transient insert
            // failure) costs that vendor only — suppliers already created this
            // run keep their mappings and the loop continues.
            try {
              const created = (await suppliers.create({
                name: v.name,
                contactName: v.contactName ?? undefined,
                email: v.email || undefined,
                phone: v.phone ?? undefined,
              })) as { id: string };
              vendorToSupplier.set(v.vendorId, created.id);
              byName.set(key, created.id);
              summary.suppliers.created++;
            } catch {
              summary.suppliers.failed++;
            }
          }
        } catch (e) {
          // The dedupe read (or the MFA step-up inside the service) failed:
          // skip supplier LINKING for the rest but never the item import.
          // Mappings made before the failure are kept.
          if (e instanceof ServiceError) {
            summary.suppliers.skipped = true;
            summary.suppliers.skippedReason = 'a supplier lookup failed mid-import';
          } else {
            throw e;
          }
        }
      }
    }

    // ── Items through the service layer (movement-ledger-correct). ──
    const svc = new InventoryService(ctx);
    for (let i = 0; i < parsed.data.items.length; i++) {
      const rowNum = parsed.data.rowOffset + i + 2; // 1-based + header row
      const pi = itemSchema.safeParse(parsed.data.items[i]);
      if (!pi.success) {
        summary.items.failed++;
        if (summary.items.errors.length < 50) {
          const rawSku = (parsed.data.items[i] as { sku?: unknown } | null)?.sku;
          summary.items.errors.push({
            row: rowNum,
            sku: typeof rawSku === 'string' ? rawSku : '(invalid row)',
            message: pi.error.issues[0]?.message ?? 'Invalid row',
          });
        }
        continue;
      }
      const item = pi.data;
      try {
        await svc.create({
          name: item.name,
          sku: item.sku,
          barcode: item.barcode,
          description: item.description,
          unitCost: item.unit_cost,
          retailPrice: item.retail_price,
          quantityOnHand: item.quantity_on_hand,
          reorderPoint: item.reorder_point,
          reorderQuantity: item.reorder_quantity,
          unitOfMeasure: item.unit_of_measure || 'unit',
          warehouseId: parsed.data.warehouseId,
          categoryId: null,
          supplierId: item.vendorId ? (vendorToSupplier.get(item.vendorId) ?? null) : null,
          primaryLocationId: null,
          trackingType: 'none',
          itemType: 'product',
          customFields: {},
          // Sage "Inactive" → archived (kept but out of active use).
          status: item.inactive ? 'archived' : 'active',
        });
        summary.items.created++;
      } catch (e) {
        summary.items.failed++;
        if (summary.items.errors.length < 50) {
          summary.items.errors.push({
            row: rowNum,
            sku: item.sku,
            message: e instanceof Error ? e.message : 'Unknown error',
          });
        }
      }
    }

    revalidatePath('/dashboard');
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
    return ok(summary);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
