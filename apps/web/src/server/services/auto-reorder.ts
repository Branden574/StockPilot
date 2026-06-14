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
