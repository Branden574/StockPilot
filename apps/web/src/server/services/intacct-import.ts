import 'server-only';

import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { createAdminClient } from '@/lib/supabase/admin';
import { IntacctClient } from '@/server/connectors/sage-intacct/client';
import { refreshTokens } from '@/server/connectors/sage-intacct/oauth';
import { getConnectionSecret, putConnectionSecret } from '@/server/connectors/secret-store';
import {
  assertModuleEnabled,
  assertPermission,
  ServiceError,
  type ServiceContext,
} from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';

/**
 * "Migrate from Sage Intacct" — pull items (+ on-hand where readable) from the
 * org's connected Intacct company into StockPilot.
 *
 * Runs in the USER's service context on purpose (not the drainer/connector):
 * items are created through InventoryService.create so initial quantities post
 * ledger-correct movements, RLS applies, and permissions are enforced. Only
 * the Vault secret read uses the service-role admin client (connector_secret_*
 * RPCs are revoked from `authenticated`).
 *
 * Permission gate is `integrations:manage` + `items:import`: the pull
 * exercises the ORG's Intacct OAuth credentials (token refresh + Vault
 * rotation), so it requires the same manage capability as every other
 * connection-touching action — items:import alone (which staff hold) is not
 * enough.
 *
 * Idempotent by SKU: the Intacct item `id` becomes the StockPilot SKU; items
 * whose SKU already exists in the org are skipped (never clobbered), so re-runs
 * resume cleanly. The skip check ignores soft-deleted rows (deleted_at set) so
 * a deleted item's SKU can be re-imported.
 *
 * DISCLOSED CAP: at most MAX_PER_RUN items are CREATED-or-FAILED per call
 * (bounds the server action's runtime + Intacct Tier-1 quota draw). Skipped
 * already-existing SKUs do NOT count against the cap, so re-running genuinely
 * continues past previously-imported pages. The summary reports `remaining`
 * so the UI can say "run again to continue".
 *
 * ⚠ PENDING SANDBOX VERIFICATION: object/field names follow the published REST
 * v1 reference; the on-hand query degrades gracefully (qty 0 + note) when the
 * tenant's object shape differs.
 */

const MAX_PER_RUN = 2000;
/** Refresh the access token when within 10 minutes of expiry (12h JWTs). */
const REFRESH_SKEW_MS = 10 * 60 * 1000;

export interface IntacctImportSummary {
  scanned: number;
  created: number;
  skippedExisting: number;
  failed: number;
  /** Items left unscanned when the per-run cap hit (0 = complete). */
  remaining: number;
  /** Non-fatal notes (e.g. on-hand quantities unavailable). */
  notes: string[];
  errors: { sku: string; message: string }[];
}

interface IntacctConnRow {
  id: string;
  status: string;
  secret_id: string | null;
}

export async function importItemsFromIntacct(
  ctx: ServiceContext,
  input: { warehouseId?: string } = {},
): Promise<IntacctImportSummary> {
  assertModuleEnabled(ctx, 'integrations');
  assertPermission(ctx, 'integrations:manage');
  assertPermission(ctx, 'items:import');

  // Imported items must land in a warehouse (InventoryService.create requires
  // one for non-warehouse-scoped roles — and integrations:manage holders are
  // never warehouse-scoped). Use the caller's pick, or the org's sole writable
  // warehouse when there's no ambiguity; otherwise ask them to choose.
  // svc.create re-validates write access to whatever we resolve.
  let warehouseId = input.warehouseId ?? null;
  if (!warehouseId) {
    const access = await getWarehouseAccess(ctx);
    if (access.writableIds.length === 1) warehouseId = access.writableIds[0] ?? null;
  }
  if (!warehouseId) {
    throw new ServiceError(
      'validation_error',
      'Select the warehouse the imported items should belong to.',
    );
  }

  // RLS-scoped read proves org membership; only the secret read needs admin.
  const { data: conn, error: connErr } = await ctx.supabase
    .from('org_connections')
    .select('id, status, secret_id')
    .eq('organization_id', ctx.organizationId)
    .eq('provider_id', 'sage_intacct')
    .maybeSingle();
  if (connErr) throw new ServiceError('internal_error', connErr.message);
  const row = conn as IntacctConnRow | null;
  if (!row || row.status !== 'active' || !row.secret_id) {
    throw new ServiceError('validation_error', 'Sage Intacct is not connected for this organization.');
  }

  const admin = createAdminClient();
  // secret-store types `admin` to the minimal rpc shape — same cast the QBO
  // callback + drainer use at this boundary.
  let secrets = await getConnectionSecret(admin as never, row.secret_id);

  // Refresh near-expiry tokens up front (the pull may run for a while) and
  // persist the rotated pair — reusing a stale rotated refresh token bricks
  // the connection. Mirrors the drainer's persistence EXACTLY: Vault upserts
  // by NAME (`connector:<connId>`) and may return a fresh id, which must be
  // written back to org_connections or the next read uses the stale secret.
  const expiresAt = Date.parse(String(secrets.expiresAt ?? '')) || 0;
  if (expiresAt - Date.now() < REFRESH_SKEW_MS) {
    const t = await refreshTokens(secrets.refreshToken);
    secrets = { ...secrets, ...t };
    const newSecretId = await putConnectionSecret(admin as never, `connector:${row.id}`, secrets);
    if (newSecretId && newSecretId !== row.secret_id) {
      const { error: rotateErr } = await admin
        .from('org_connections')
        .update({ secret_id: newSecretId, updated_at: new Date().toISOString() })
        .eq('id', row.id);
      if (rotateErr) {
        throw new ServiceError('internal_error', `secret rotate: ${rotateErr.message}`);
      }
    }
  }

  const client = new IntacctClient(secrets);
  const summary: IntacctImportSummary = {
    scanned: 0,
    created: 0,
    skippedExisting: 0,
    failed: 0,
    remaining: 0,
    notes: [],
    errors: [],
  };

  // Best-effort on-hand map (Σ across warehouses). Tolerated failure: some
  // tenants gate or rename the object — degrade to qty 0 with a note rather
  // than failing the whole import. (queryPage terminates on any empty page,
  // so an envelope-shape mismatch can't loop.)
  const onHand = new Map<string, number>();
  let onHandFailed = false;
  try {
    let start: number | null = 1;
    while (start !== null) {
      const page = await client.queryPage({
        object: 'inventory-control/item-warehouse-inventory',
        fields: ['item.id', 'onHand'],
        start,
        size: 2000,
      });
      for (const r of page.records) {
        const itemId = String((r as Record<string, unknown>)['item.id'] ?? '');
        if (!itemId) continue;
        const qty = Number((r as Record<string, unknown>).onHand) || 0;
        onHand.set(itemId, (onHand.get(itemId) ?? 0) + qty);
      }
      start = page.nextStart;
    }
  } catch {
    onHandFailed = true;
    summary.notes.push(
      'On-hand quantities could not be read from Intacct — items imported with quantity 0; adjust via cycle count.',
    );
  }

  const svc = new InventoryService(ctx);

  // Cap on work DONE (created + failed), not rows scanned: scanning a page of
  // already-imported SKUs is one API call + one indexed read, so re-runs walk
  // past prior pages instead of burning the whole budget re-skipping them
  // (which would make "run again to continue" a lie for >MAX_PER_RUN catalogs).
  const processedNew = () => summary.created + summary.failed;
  let capped = false;

  let start: number | null = 1;
  outer: while (start !== null) {
    const page = await client.queryPage({
      object: 'inventory-control/item',
      fields: ['id', 'name', 'baseUnit', 'standardCost', 'basePrice', 'status'],
      start,
      size: 500,
    });
    if (page.records.length === 0) break;

    // Existing-SKU check per page (≤500 ids — under the 1000-row read cap).
    // Soft-deleted rows don't count as existing: their SKU is re-importable
    // (matches the 0126 partial unique index, which is scoped to live rows).
    const skus = page.records
      .map((r) => String((r as Record<string, unknown>).id ?? '').trim())
      .filter(Boolean);
    const { data: existingRows, error: existErr } = await ctx.supabase
      .from('inventory_items')
      .select('sku')
      .eq('organization_id', ctx.organizationId)
      .is('deleted_at', null)
      .in('sku', skus);
    if (existErr) throw new ServiceError('internal_error', existErr.message);
    const existing = new Set(
      ((existingRows ?? []) as { sku: string | null }[]).map((r) => r.sku ?? ''),
    );

    for (const r of page.records) {
      const rec = r as Record<string, unknown>;
      const sku = String(rec.id ?? '').trim();
      const name = String(rec.name ?? '').trim() || sku;
      if (!sku) {
        summary.scanned++;
        summary.failed++;
        summary.errors.push({ sku: '(blank)', message: 'Intacct item has no id' });
        continue;
      }
      if (existing.has(sku)) {
        summary.scanned++;
        summary.skippedExisting++;
        continue;
      }
      if (processedNew() >= MAX_PER_RUN) {
        // Stop BEFORE consuming this new item — `capped` discloses the cut
        // even when it lands mid-final-page (start may already be null).
        capped = true;
        break outer;
      }
      summary.scanned++;

      try {
        await svc.create({
          name,
          sku,
          unitCost: Number(rec.standardCost) || 0,
          retailPrice: Number(rec.basePrice) || 0,
          quantityOnHand: onHand.get(sku) ?? 0,
          reorderPoint: 0,
          reorderQuantity: 0,
          unitOfMeasure: String(rec.baseUnit ?? '').trim() || 'unit',
          warehouseId,
          categoryId: null,
          supplierId: null,
          primaryLocationId: null,
          trackingType: 'none',
          itemType: 'product',
          customFields: {},
          // Intacct "inactive" → archived (kept but out of active use).
          status: String(rec.status ?? '').toLowerCase() === 'inactive' ? 'archived' : 'active',
        });
        summary.created++;
      } catch (e) {
        summary.failed++;
        if (summary.errors.length < 50) {
          summary.errors.push({
            sku,
            message: e instanceof Error ? e.message : 'create failed',
          });
        }
      }
    }

    start = page.nextStart;
  }

  // Disclose what the cap left behind (0 when the source was exhausted).
  if (capped) {
    summary.remaining = 1; // unknown exact count; >0 signals "run again"
    summary.notes.push(
      `Import capped at ${MAX_PER_RUN} items per run — run the import again to continue where it left off.`,
    );
  }

  // A successful-but-empty on-hand read means every imported item opened at
  // quantity 0 — say so instead of letting it read as "covered".
  if (!onHandFailed && onHand.size === 0 && summary.created > 0) {
    summary.notes.push(
      'Intacct returned no on-hand rows — imported items start at quantity 0; adjust via cycle count.',
    );
  }

  return summary;
}
