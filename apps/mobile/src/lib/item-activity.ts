/**
 * Mobile port of the web's `ActivityService.forItem` merge semantics
 * (apps/web/src/server/services/activity.ts) for the item detail Activity
 * tab. Pure (no Supabase, no React) so the merge/cap/filter/format logic is
 * unit-testable without mocking the network — the actual `stock_movements`
 * and `audit_logs` queries stay in app/item/[id].tsx, mirroring the
 * movement-references.ts / movement-display.ts split already used by this
 * screen.
 *
 * Two bugs this module is specifically built to never reintroduce (Movement/
 * Activity P4 constraints):
 *
 *  1. THE P1 CAP BUG — combining movements+audits into one list and THEN
 *     slicing to a total limit lets audit rows (edits, archives, tag/serial
 *     churn, …) crowd real stock movements out of the feed whenever audits
 *     happen to be more numerous or more recent. `mergeItemActivity` caps
 *     each kind SEPARATELY (movementLimit, auditLimit) and only merges +
 *     sorts AFTER both are already capped — never a combined-then-sliced
 *     list. See forItem's doc-comment for the full history.
 *
 *  2. THE NULLABLE-REASON FILTER BUG (#23b) — `stock_movements.reason` is
 *     NULLABLE, and PostgREST's `.not(col, 'in', (...))` compiles to
 *     `NOT (col = ANY(...))`, which evaluates to NULL (not TRUE) for a NULL
 *     `col`, so Postgres silently DROPS the row instead of keeping it — a
 *     query-layer filter on `reason` would have discarded ~61% of prod
 *     movements (verified in P3). `LIFECYCLE_REASON_MOVEMENTS` is filtered
 *     HERE, in JS, over already-fetched rows, where `null` reasons compare
 *     correctly against the denylist and are always kept.
 */

// ─── Shared filters (mirrors activity.ts verbatim) ─────────────────────────

/**
 * `InventoryService`'s adjust/transfer/receive/remove mutations write BOTH a
 * `stock_movements` row (rendered as a MovementCard, with prev→after and
 * from→to) AND an `audit_logs` row of one of these four events (so the
 * GLOBAL audit page has full before/after attribution). The item Activity
 * feed must not double-render the same fact — the movement row is the
 * richer representation there, so these four audit events are suppressed
 * from THIS feed only (never from audit_logs itself, never from the global
 * audit page).
 */
export const MOVEMENT_SHADOWED_AUDIT_EVENTS: readonly string[] = [
  'stock.adjusted',
  'stock.transferred',
  'stock.received',
  'stock.removed',
];

/**
 * Legacy defense (Movement/Activity P3): a since-removed code path wrote a
 * FICTIONAL `stock_movements` row (`movement_type: 'adjust'`,
 * `reason: 'item_archived' | 'item_deleted'`) when an item was archived or
 * soft-deleted, even though archive/delete deliberately preserve
 * quantity_on_hand — no stock ever physically moved. Any legacy row that
 * slipped through the one-time cleanup (migration 0271) must never render as
 * a real stock event. Filtered in JS ONLY — see the module doc-comment for
 * why a query-layer `.not('reason', 'in', ...)` would silently drop every
 * null-reason movement (most of them) instead.
 */
export const LIFECYCLE_REASON_MOVEMENTS: readonly string[] = ['item_archived', 'item_deleted'];

/** Mirrors forItem's `auditLimit = Math.max(1, Math.ceil(limit / 2))`. */
export function auditCapFor(movementLimit: number): number {
  return Math.max(1, Math.ceil(movementLimit / 2));
}

// ─── Input row shapes (structural — match the screen's mapped rows) ────────

export interface ActivityMovementInput {
  id: string;
  movement_type: string;
  quantity_change: number;
  previous_quantity: number;
  new_quantity: number;
  moved_quantity: number | null;
  reason: string | null;
  notes: string | null;
  created_at: string;
  actor: { full_name: string | null; email: string | null } | null;
  reference_type: string | null;
  reference_id: string | null;
  reference_label: string | null;
  from_location_id: string | null;
  to_location_id: string | null;
}

export interface ActivityAuditInput {
  id: string;
  event: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  actor: { full_name: string | null; email: string | null } | null;
}

// ─── Crash-safe metadata rendering (compact port of metadata-diff.tsx) ─────
// Audit metadata is untrusted jsonb — `unknown` end to end. Every branch
// below has a defined fallback; nothing here can throw on arbitrary input.

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Renders an arbitrary jsonb value as a short human string. Mirrors
 * `stringifyMetadataValue` in apps/web/src/components/audit/metadata-diff.tsx
 * verbatim (see that file for the full case-by-case rationale).
 */
export function stringifyMetadataValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value.length > 0 ? value : '—';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '(none)';
    const allPrimitive = value.every(
      (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v),
    );
    if (allPrimitive) {
      return value.map((v) => (v === null ? '—' : String(v))).join(', ');
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  if (isPlainObject(value)) {
    if (Object.keys(value).length === 0) return '(empty)';
    try {
      return JSON.stringify(value);
    } catch {
      return '[object]';
    }
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export interface MetadataDiffField {
  field: string;
  before: string;
  after: string;
}

/**
 * Field-by-field diff between an audit event's `metadata.before` and
 * `metadata.after`. Only returns rows whose stringified value actually
 * differs. Mirrors `diffMetadataFields` in metadata-diff.tsx verbatim.
 */
export function diffMetadataFields(before: unknown, after: unknown): MetadataDiffField[] {
  const beforeObj = isPlainObject(before) ? before : null;
  const afterObj = isPlainObject(after) ? after : null;

  if (!beforeObj && !afterObj) {
    if (before === undefined && after === undefined) return [];
    const b = stringifyMetadataValue(before ?? null);
    const a = stringifyMetadataValue(after ?? null);
    return b === a ? [] : [{ field: 'value', before: b, after: a }];
  }

  const keys = new Set<string>([...Object.keys(beforeObj ?? {}), ...Object.keys(afterObj ?? {})]);

  const rows: MetadataDiffField[] = [];
  for (const key of keys) {
    const bVal = beforeObj ? beforeObj[key] : undefined;
    const aVal = afterObj ? afterObj[key] : undefined;
    const bStr = stringifyMetadataValue(bVal);
    const aStr = stringifyMetadataValue(aVal);
    if (bStr === aStr) continue;
    rows.push({ field: key, before: bStr, after: aStr });
  }
  return rows;
}

/** Mirrors metadata-diff.tsx's ACRONYMS set verbatim. */
const ACRONYMS = new Set([
  'po',
  'sku',
  'id',
  'uom',
  'url',
  'api',
  'mfa',
  'rls',
  'ai',
  'isbn',
  'upc',
  'qbo',
  'gps',
]);

/**
 * "public_display_name" -> "Public display name", "po_number" -> "PO number"
 * (see ACRONYMS above). Mirrors `humanizeFieldName` in metadata-diff.tsx.
 */
export function humanizeFieldName(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim();
  if (spaced.length === 0) return key;
  const words = spaced.split(' ').map((word) => (ACRONYMS.has(word) ? word.toUpperCase() : word));
  const result = words.join(' ');
  return result.charAt(0).toUpperCase() + result.slice(1);
}

// ─── Event label formatting (small port of web's formatAuditEvent) ────────
// Only the subjects that actually appear on an ITEM's audit feed today
// (inventory.item.*, item.serial(s).*, tag.*) need an override — every other
// shape (including any future/unrecognized event) already reads fine via the
// generic title-case fallback, same as web's formatAuditEvent.

const SUBJECT_OVERRIDES: Record<string, string> = {
  inventory: 'Inventory',
  item: 'Item',
};

function titleCase(s: string): string {
  return s
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Turns `inventory.item.updated` into `Inventory Item · Updated`. Falls back
 * gracefully for unknown shapes (no dot -> title-cased whole string), same
 * contract as web's `formatAuditEvent`.
 */
export function formatAuditEventLabel(event: string): string {
  if (!event) return '—';
  const parts = event.split('.');
  if (parts.length === 1) return titleCase(parts[0] ?? event);
  const action = parts[parts.length - 1] ?? '';
  const subjectParts = parts.slice(0, -1);
  const head = subjectParts[0] ?? '';
  const compoundKey = subjectParts.join('.');
  const subjectFromOverride = SUBJECT_OVERRIDES[compoundKey] ?? SUBJECT_OVERRIDES[head];
  const subject = subjectFromOverride
    ? subjectParts.length > 1 && !SUBJECT_OVERRIDES[compoundKey]
      ? `${subjectFromOverride} ${titleCase(subjectParts.slice(1).join(' '))}`
      : subjectFromOverride
    : titleCase(subjectParts.join(' '));
  return `${subject} · ${titleCase(action)}`;
}

// ─── Relative time (no Intl.RelativeTimeFormat dependency — Hermes-safe) ───

/**
 * Compact "5m ago" / "3h ago" style relative time. `now` is injectable so
 * this is deterministically testable (never `new Date()` baked into an
 * assertion). Negative diffs (clock skew / optimistic local writes just
 * ahead of the server clock) clamp to "just now" rather than showing a
 * nonsensical negative duration.
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffSec = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMonth = Math.round(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo ago`;
  const diffYear = Math.round(diffMonth / 12);
  return `${diffYear}y ago`;
}

// ─── Audit card model + merge ───────────────────────────────────────────────

/** Cap on rendered before→after rows per audit card — the rest collapse to a "+N more" line. */
export const AUDIT_DIFF_ROW_CAP = 6;

export interface AuditCardModel {
  id: string;
  event: string;
  eventLabel: string;
  createdAt: string;
  actorName: string;
  /** metadata.reason, when present and a string. Distinct from `notes`, which audit rows never carry. */
  reason: string | null;
  /** metadata.changed_keys, when present and a string array. Rendered as its own chip line. */
  changedKeys: string[] | null;
  /** Field-level before→after rows, capped at AUDIT_DIFF_ROW_CAP. */
  diffRows: MetadataDiffField[];
  /** Count of additional differing fields beyond the cap (0 when none hidden). */
  diffMoreCount: number;
}

/**
 * Builds the render-ready model for one audit row. Never throws — metadata
 * is untrusted jsonb, so every field reads through the crash-safe helpers
 * above with an explicit fallback.
 */
export function buildAuditCardModel(row: ActivityAuditInput): AuditCardModel {
  const meta = isPlainObject(row.metadata) ? row.metadata : {};
  const reason = typeof meta.reason === 'string' ? meta.reason : null;
  const changedKeys = isStringArray(meta.changed_keys) ? meta.changed_keys : null;
  const allDiffRows = diffMetadataFields(meta.before, meta.after);
  return {
    id: row.id,
    event: row.event,
    eventLabel: formatAuditEventLabel(row.event),
    createdAt: row.created_at,
    actorName: row.actor?.full_name ?? row.actor?.email ?? 'system',
    reason,
    changedKeys,
    diffRows: allDiffRows.slice(0, AUDIT_DIFF_ROW_CAP),
    diffMoreCount: Math.max(0, allDiffRows.length - AUDIT_DIFF_ROW_CAP),
  };
}

export type ActivityEntry =
  | { kind: 'movement'; id: string; createdAt: string; movement: ActivityMovementInput }
  | { kind: 'audit'; id: string; createdAt: string; audit: AuditCardModel };

/**
 * Merges already-fetched movement + audit rows into one time-sorted feed,
 * porting `ActivityService.forItem`'s semantics client-side:
 *
 *  - each kind is filtered (shadowed audit events; legacy lifecycle-reason
 *    movements — see the module doc-comment) and capped to its OWN limit
 *    BEFORE the merge — never a combined-then-sliced list (the P1 bug);
 *  - the merge itself only sorts by createdAt desc, exactly like forItem's
 *    final `.sort(...)`.
 *
 * Pure: no network, no Supabase, no React — safe to call with any array
 * lengths/limits from a unit test.
 */
export function mergeItemActivity(input: {
  movements: ActivityMovementInput[];
  audits: ActivityAuditInput[];
  movementLimit: number;
  auditLimit: number;
}): ActivityEntry[] {
  const movementEntries: ActivityEntry[] = input.movements
    // `.includes(null)` on a string[] denylist is simply `false` — a null
    // reason is never in LIFECYCLE_REASON_MOVEMENTS, so it's always kept.
    // (This is the JS-side equivalent of the query-layer bug described in
    // the module doc-comment: unlike PostgREST's `.not(col,'in',...)`, a
    // plain JS `.includes()` never turns "unknown" into "excluded".)
    .filter((m) => !LIFECYCLE_REASON_MOVEMENTS.includes(m.reason as string))
    .slice(0, input.movementLimit)
    .map((m) => ({ kind: 'movement', id: m.id, createdAt: m.created_at, movement: m }));

  const auditEntries: ActivityEntry[] = input.audits
    .filter((a) => !MOVEMENT_SHADOWED_AUDIT_EVENTS.includes(a.event))
    .slice(0, input.auditLimit)
    .map((a) => ({ kind: 'audit', id: a.id, createdAt: a.created_at, audit: buildAuditCardModel(a) }));

  return [...movementEntries, ...auditEntries].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}
