import 'server-only';

/**
 * Automatic reordering — settings model + reader. The daily engine
 * (runAutoReorder) is added in Phase 2; this file owns the per-org settings
 * stored in the `purchase_orders` module's organization_modules.settings jsonb
 * under the `autoReorder` key.
 */

export type AutoReorderMode = 'draft' | 'send';

export interface AutoReorderSettings {
  enabled: boolean;
  mode: AutoReorderMode;
  /** Auto-send cap in cents; a supplier PO over this drops to a draft. null = no cap. */
  maxAutoSendCents: number | null;
}

export const AUTO_REORDER_DEFAULTS: AutoReorderSettings = {
  enabled: false,
  mode: 'draft',
  maxAutoSendCents: null,
};

/**
 * Coerce raw jsonb to a valid settings object — FAIL CLOSED: anything missing
 * or malformed resolves to the safe default (disabled / draft / no cap). The
 * settings ACTION is the write-side trust boundary; this is the read-side one.
 */
export function parseAutoReorderSettings(raw: unknown): AutoReorderSettings {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const cap =
    typeof o.maxAutoSendCents === 'number' &&
    Number.isFinite(o.maxAutoSendCents) &&
    o.maxAutoSendCents >= 0
      ? Math.floor(o.maxAutoSendCents)
      : null;
  return {
    enabled: o.enabled === true,
    mode: o.mode === 'send' ? 'send' : 'draft',
    maxAutoSendCents: cap,
  };
}

// ── Planning (pure) ──────────────────────────────────────────────────────

export interface AutoReorderLine {
  itemId: string;
  quantityOrdered: number;
  unitCost: number;
}

export interface AutoReorderCandidate extends AutoReorderLine {
  supplierId: string | null;
}

export interface AutoReorderSupplierGroup {
  supplierId: string;
  lines: AutoReorderLine[];
  /** Sum of quantity × unit cost (dollars), used for cap/threshold decisions. */
  total: number;
}

export interface AutoReorderPlan {
  bySupplier: AutoReorderSupplierGroup[];
  /** Below-par items already on an open PO — skipped so we never double-order. */
  skippedDuplicate: number;
  /** Below-par items with no supplier — can't be auto-ordered (surfaced manually). */
  skippedNoSupplier: number;
}

/**
 * PURE: turn below-par candidates into per-supplier PO groups, applying the two
 * skip rules — items already on an open PO (dedup, the no-double-order
 * guarantee) and items with no supplier (nothing to send to). Deterministic +
 * unit-tested; all I/O lives in the runAutoReorder method.
 */
export function planAutoReorder(
  candidates: AutoReorderCandidate[],
  openItemIds: Set<string>,
): AutoReorderPlan {
  const bySupplier = new Map<string, AutoReorderLine[]>();
  let skippedDuplicate = 0;
  let skippedNoSupplier = 0;

  for (const c of candidates) {
    if (openItemIds.has(c.itemId)) {
      skippedDuplicate++;
      continue;
    }
    if (!c.supplierId) {
      skippedNoSupplier++;
      continue;
    }
    const line: AutoReorderLine = {
      itemId: c.itemId,
      quantityOrdered: c.quantityOrdered,
      unitCost: c.unitCost,
    };
    const list = bySupplier.get(c.supplierId) ?? [];
    list.push(line);
    bySupplier.set(c.supplierId, list);
  }

  return {
    bySupplier: [...bySupplier.entries()].map(([supplierId, lines]) => ({
      supplierId,
      lines,
      total: lines.reduce((sum, l) => sum + l.quantityOrdered * l.unitCost, 0),
    })),
    skippedDuplicate,
    skippedNoSupplier,
  };
}

/**
 * PURE money-gate: may an auto-reorder PO be auto-SENT (vs held as a draft)?
 *
 * Safety posture: NEVER auto-send unbounded. A PO is auto-sent only when there
 * is at least one ceiling (the auto-send cap OR the org approval threshold) AND
 * the total is under both. With neither configured we HOLD (draft) — no
 * unbounded auto-spend. All amounts in dollars.
 */
export function shouldAutoSend(
  total: number,
  capDollars: number | null,
  threshold: number | null,
): boolean {
  if (capDollars == null && threshold == null) return false; // no ceiling → hold
  if (threshold != null && total >= threshold) return false; // at/over approval threshold
  if (capDollars != null && total > capDollars) return false; // over auto-send cap
  return true;
}

/** Minimal supabase shape the reader needs (satisfied by both clients). */
type DbLike = { from: (t: string) => any };

/**
 * Reads an org's auto-reorder settings from the purchase_orders module row.
 * Fail-closed to defaults on any error or missing row.
 */
export async function readAutoReorderSettings(
  db: DbLike,
  organizationId: string,
): Promise<AutoReorderSettings> {
  try {
    const { data, error } = await db
      .from('organization_modules')
      .select('settings')
      .eq('organization_id', organizationId)
      .eq('module_id', 'purchase_orders')
      .maybeSingle();
    if (error || !data) return AUTO_REORDER_DEFAULTS;
    const settings = (data as { settings?: unknown }).settings;
    const bucket =
      settings && typeof settings === 'object'
        ? (settings as Record<string, unknown>).autoReorder
        : undefined;
    return parseAutoReorderSettings(bucket);
  } catch {
    return AUTO_REORDER_DEFAULTS;
  }
}
