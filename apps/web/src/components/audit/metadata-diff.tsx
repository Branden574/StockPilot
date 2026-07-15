/**
 * Shared before/after diff renderer for audit-log metadata.
 *
 * `audit()` (server/services/audit.ts) always writes `metadata.before` and
 * `metadata.after` (coalesced to `null` when the caller doesn't pass them),
 * plus sometimes a `metadata.changed_keys` string array (item update,
 * category update, notification-preferences — see those call sites). Until
 * this component existed, both were captured at write time and rendered
 * NOWHERE — this is the one place that turns that jsonb into something a
 * human can read, shared by the global audit log page, `AuditTimeline`, and
 * `ActivityFeed`'s audit rows.
 *
 * Contract: never throws on weird/arbitrary jsonb. `before`/`after` are
 * `unknown` end to end (Postgres jsonb has no static shape), so every branch
 * here has a defined fallback instead of assuming an object shape.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Renders an arbitrary jsonb value as a short human string.
 * - null/undefined -> "—" (also used for "field didn't exist on this side")
 * - empty string -> "—" (an explicitly-cleared text field reads better as
 *   "—" than as a blank that looks like a rendering bug)
 * - primitives -> String(value)
 * - arrays of primitives -> comma-joined; arrays of objects -> JSON
 * - objects -> compact JSON (never pretty-printed; this renders inline)
 * Exported for the diff-drawer unit tests (nested/edge-case stringification).
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
  // Anything else (function, symbol, …) shouldn't occur in jsonb, but
  // metadata is `unknown` end to end — never let a weird value crash render.
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export interface MetadataDiffField {
  /** Raw jsonb key from the before/after objects (e.g. "public_display_name"). */
  field: string;
  before: string;
  after: string;
}

/**
 * Field-by-field diff between an audit event's `metadata.before` and
 * `metadata.after`. Only returns rows for keys whose stringified value
 * actually differs — unchanged fields are omitted so the drawer only shows
 * what moved.
 *
 * Handles every shape seen in the codebase's ~40 `audit({ before, after })`
 * call sites:
 *  - both plain objects (the common case) -> union of keys, per-key diff
 *  - one side null/absent (creation events only set `after`; some deletions
 *    only set `before`) -> every key on the present side diffs against "—"
 *  - neither side is a keyed object (defensive — no current writer does
 *    this, but metadata is `unknown`) -> a single "value" row, or no rows
 *    if they stringify the same
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

  const keys = new Set<string>([
    ...Object.keys(beforeObj ?? {}),
    ...Object.keys(afterObj ?? {}),
  ]);

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

/** "public_display_name" / "charterIds" -> "Public display name" / "Charter ids". */
export function humanizeFieldName(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim();
  return spaced.length > 0 ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Renders whichever of the two the metadata supports:
 *  1. A `<details>` diff drawer when `metadata.before`/`metadata.after`
 *     yield at least one differing field (module/PO/role/warehouse/receipt
 *     events, ~57-100% fill per event type).
 *  2. A compact "Fields changed: a, b" chip when there's no before/after but
 *     `metadata.changed_keys` is a non-empty string array (item update,
 *     category archive, notification-preferences).
 *  3. Nothing, when neither is present (most create-only / no-diff events).
 *
 * Plain `<details>/<summary>` — no client-side state needed, so this stays a
 * Server Component and drops straight into the two async server components
 * that render it (AuditTimeline, the global audit page) as well as the
 * (also-server) ActivityFeed.
 */
export function MetadataDiff({
  metadata,
}: {
  metadata: Record<string, unknown> | null | undefined;
}) {
  const meta = metadata ?? {};
  const rows = diffMetadataFields(meta.before, meta.after);

  if (rows.length > 0) {
    return (
      <details className="mt-1.5">
        <summary className="cursor-pointer select-none text-[11px] text-muted-foreground hover:text-foreground">
          {rows.length === 1 ? 'Show 1 field change' : `Show ${rows.length} field changes`}
        </summary>
        <dl className="mt-1.5 space-y-1 rounded-md border border-border bg-muted/30 p-2">
          {rows.map((r) => (
            <div key={r.field} className="flex flex-wrap items-baseline gap-x-1.5 text-[11px]">
              <dt className="font-medium text-foreground">{humanizeFieldName(r.field)}:</dt>
              <dd className="min-w-0 break-words text-muted-foreground">
                <span className="line-through opacity-70">{r.before}</span>
                <span className="mx-1">→</span>
                <span className="text-foreground">{r.after}</span>
              </dd>
            </div>
          ))}
        </dl>
      </details>
    );
  }

  const changedKeys = isStringArray(meta.changed_keys) ? meta.changed_keys : null;
  if (changedKeys && changedKeys.length > 0) {
    return (
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Fields changed: {changedKeys.map(humanizeFieldName).join(', ')}
      </p>
    );
  }

  return null;
}
