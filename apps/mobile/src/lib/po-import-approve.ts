/**
 * Pure decision/validation helpers for the native PO-import detail screen
 * (app/po-import/[id].tsx). Kept free of React/react-native imports so the
 * status→action map, the approve-flow line decisions, and the payload
 * builders are unit-testable exactly like movement-note.ts / serials.ts.
 *
 * Server contract these build against (PINNED — 2026-07-18 parity plan):
 *   POST /api/v1/po-imports/[id]/approve       { warehouseId, vendorId,
 *     locationId, charterId?, itemCharterId?, expectedAt?, lineOverrides? }
 *     → { ok, poId }
 *     charterId    = BILL-TO (billing metadata; PO PDF only).
 *     itemCharterId = item OWNERSHIP; OMIT the key to change no ownership.
 *   POST /api/v1/po-imports/[id]/cancel        → { ok }
 *   POST /api/v1/po-imports/[id]/parse         → { ok }
 *   POST /api/v1/po-imports/[id]/line-matches  { lineIds? } → { ok, matches }
 *   POST /api/v1/po-imports/[id]/create-items  (createItemsFromPoLines input
 *     minus poImportId) → { ok, created, mapped, linked, skipped }
 */

// ── Status → available actions ──────────────────────────────────────────────

export type PoImportAction = 'parse' | 'cancel' | 'approve';

/**
 * Which actions the detail screen offers per import status. Mirrors the web
 * service's gates exactly:
 *   • approve — PoImportsService.approve throws unless parsed/needs_review;
 *   • cancel  — the service's update is guarded `not in (approved,canceled)`,
 *               i.e. every non-terminal status (duplicate included) may cancel;
 *   • parse   — surfaced as a (re)parse retry for uploaded/failed, matching
 *               the web review page's affordances. ('parsing' gets no parse
 *               button — a parse is already in flight.)
 * Unknown/terminal statuses get no actions (defensive: render-only).
 */
export function actionsForStatus(status: string | null | undefined): PoImportAction[] {
  switch (status) {
    case 'uploaded':
      return ['parse', 'cancel'];
    case 'failed':
      return ['parse', 'cancel'];
    case 'parsed':
    case 'needs_review':
      return ['approve', 'cancel'];
    case 'parsing':
    case 'duplicate':
      return ['cancel'];
    case 'approved':
    case 'canceled':
    default:
      return [];
  }
}

// ── Per-line decisions for the approve flow ─────────────────────────────────

/**
 * How the user resolved one UNMATCHED inventory line:
 *   • use_existing — link the line to an item picked from suggestions
 *     (becomes an approve lineOverride `{ lineId, itemId }`);
 *   • create — create a fresh item via POST create-items BEFORE approve
 *     (the server maps the line to the new item, so no override is needed);
 *   • skip — drop the line from the PO (`{ lineId, skip: true }`).
 */
export type LineDecision =
  | { mode: 'create' }
  | { mode: 'skip' }
  | { mode: 'use_existing'; itemId: string };

export interface ApproveLineOverride {
  lineId: string;
  itemId?: string;
  skip?: boolean;
}

/**
 * Builds the approve payload's `lineOverrides` from the per-line decisions.
 * 'create' decisions intentionally produce NO override: the create-items call
 * (made before approve) sets item_id on those lines server-side, so approve
 * already sees them mapped. Decisions with an empty/blank itemId on
 * use_existing are ignored (validateApprove blocks submission first, but the
 * builder stays safe if called anyway).
 */
export function buildLineOverrides(
  decisions: Record<string, LineDecision>,
): ApproveLineOverride[] {
  const overrides: ApproveLineOverride[] = [];
  for (const [lineId, d] of Object.entries(decisions)) {
    if (!lineId) continue;
    if (d.mode === 'skip') {
      overrides.push({ lineId, skip: true });
    } else if (d.mode === 'use_existing') {
      const itemId = typeof d.itemId === 'string' ? d.itemId.trim() : '';
      if (itemId.length > 0) overrides.push({ lineId, itemId });
    }
    // mode === 'create' → no override (resolved by create-items beforehand).
  }
  return overrides;
}

/** Line ids the user chose to CREATE items for — the create-items batch. */
export function createLineIds(decisions: Record<string, LineDecision>): string[] {
  return Object.entries(decisions)
    .filter(([, d]) => d.mode === 'create')
    .map(([lineId]) => lineId);
}

// ── Unmatched-line detection ────────────────────────────────────────────────

export interface ImportLineLike {
  id: string;
  line_type?: string | null;
  item_id?: string | null;
}

/**
 * Inventory lines with no mapped item — the ones approve would reject
 * ("Line N has no mapped item") unless the user decides them. Non-inventory
 * lines (tax/freight/…) pass through as financial-only charges and never
 * need a decision.
 */
export function unmatchedLineIds(lines: ImportLineLike[]): string[] {
  return lines
    .filter((l) => (l.line_type ?? 'unknown') === 'inventory' && !l.item_id)
    .map((l) => l.id);
}

// ── Approve validation ──────────────────────────────────────────────────────

export interface ApproveDraftFields {
  warehouseId: string | null;
  vendorId: string | null;
  locationId: string | null;
}

export type ApproveValidation = { ok: true } | { ok: false; reason: string };

/**
 * Gate for the Approve button: the three REQUIRED server fields must be set
 * (warehouse, vendor, destination location — mirrors approvePoImportSchema)
 * and every unmatched inventory line must carry a complete decision. Returns
 * the FIRST blocking reason so the sheet can show one actionable message.
 */
export function validateApprove(
  fields: ApproveDraftFields,
  unmatched: string[],
  decisions: Record<string, LineDecision>,
): ApproveValidation {
  if (!fields.warehouseId) return { ok: false, reason: 'Pick a destination warehouse.' };
  if (!fields.vendorId) return { ok: false, reason: 'Pick a vendor.' };
  if (!fields.locationId) {
    return { ok: false, reason: 'Pick a destination location for this warehouse.' };
  }
  let undecided = 0;
  for (const lineId of unmatched) {
    const d = decisions[lineId];
    if (!d) {
      undecided++;
      continue;
    }
    if (d.mode === 'use_existing' && (typeof d.itemId !== 'string' || d.itemId.trim() === '')) {
      return { ok: false, reason: 'Pick an item for every "use existing" line.' };
    }
  }
  if (undecided > 0) {
    return {
      ok: false,
      reason:
        undecided === 1
          ? 'Decide how to handle 1 unmatched line.'
          : `Decide how to handle ${undecided} unmatched lines.`,
    };
  }
  return { ok: true };
}

// ── Sites-only location filter ──────────────────────────────────────────────

export interface LocationLike {
  type: string | null;
  kind: string | null;
}

// Mirrors apps/web/src/lib/locations/groups.ts — the ONE definition of "what
// is a site". A PO's receiving destination is a SITE (warehouse/room/vehicle/
// job site), never a rack/shelf/crate/bin/area nor the staging/unplaced
// system buckets. Catch-all on unknown types so new site types keep working.
//
// WHY THIS COPY IS DANGEROUS, AND WHAT NOW STOPS IT: this is a hand-copy, and
// recurring bug pattern #26 says a duplicated function drifts silently. The
// concrete drift: add a placement kind (say 'zone') to the web's
// PLACEMENT_KINDS and the web pickers stop offering zones while THIS list still
// calls them sites — so app/po-import/[id].tsx (which reads every `locations`
// row from Supabase and filters here, because no /api/v1 locations endpoint
// exposes a sitesOnly filter) lets staff receive a PO into a zone the web then
// hides. po-import-approve.test.ts now drives these three sets off the WEB's
// exported constants, so any addition on that side turns the mobile suite red
// instead of diverging quietly. Proper fix (deferred — it touches
// packages/core/src/index.ts and the web module, outside this change's reach):
// lift groups.ts into packages/core/src/locations and have BOTH apps import it,
// after which this block becomes a re-export and the guard can assert function
// identity instead.
const SYSTEM_KINDS = new Set(['staging', 'unplaced']);
const PLACEMENT_KINDS = new Set(['rack', 'crate', 'area']);
const PLACEMENT_TYPES = new Set(['shelf', 'bin']);

export function isSiteLocation(loc: LocationLike): boolean {
  if (SYSTEM_KINDS.has(loc.kind ?? '')) return false;
  if (PLACEMENT_KINDS.has(loc.kind ?? '')) return false;
  if (PLACEMENT_TYPES.has(loc.type ?? '')) return false;
  return true;
}

// ── expectedAt normalization ────────────────────────────────────────────────

export type ExpectedAtResult = { ok: true; value: string | null } | { ok: false };

/**
 * The approve schema wants `expectedAt` as a full ISO datetime
 * (z.string().datetime()) or null. Mobile collects a plain YYYY-MM-DD, so:
 * empty → null (omit), a real calendar date → midnight-UTC ISO string,
 * anything else (including rollover dates like 2026-02-31) → { ok: false }.
 */
export function normalizeExpectedAt(input: string): ExpectedAtResult {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return { ok: false };
  const iso = `${trimmed}T00:00:00.000Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { ok: false };
  // Round-trip guard: JS Date silently rolls invalid days (Feb 31 → Mar 3).
  if (d.toISOString().slice(0, 10) !== trimmed) return { ok: false };
  return { ok: true, value: iso };
}

// ── line-matches response normalization ─────────────────────────────────────

export interface MatchCandidate {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  quantityOnHand: number;
  matchType: 'barcode' | 'name';
}

/**
 * Normalizes the line-matches response body to `lineId → candidates[]`.
 * The pinned contract wraps findDuplicatesForPoLines verbatim, whose result
 * is `{ matches: Record<lineId, DuplicateCandidate[]> }` — but this stays
 * defensive against an array-of-{lineId,candidates} encoding and against
 * junk entries, so a malformed payload degrades to "no suggestions" instead
 * of crashing the sheet.
 */
export function normalizeLineMatches(payload: unknown): Record<string, MatchCandidate[]> {
  const out: Record<string, MatchCandidate[]> = {};
  const matches = (payload as { matches?: unknown } | null | undefined)?.matches;
  if (!matches) return out;

  const addCandidates = (lineId: unknown, candidates: unknown): void => {
    if (typeof lineId !== 'string' || lineId.length === 0) return;
    if (!Array.isArray(candidates)) return;
    const clean = candidates
      .map((c) => normalizeCandidate(c))
      .filter((c): c is MatchCandidate => c !== null);
    if (clean.length > 0) out[lineId] = clean;
  };

  if (Array.isArray(matches)) {
    for (const entry of matches) {
      const e = entry as { lineId?: unknown; candidates?: unknown } | null;
      addCandidates(e?.lineId, e?.candidates);
    }
    return out;
  }
  if (typeof matches === 'object') {
    for (const [lineId, candidates] of Object.entries(matches as Record<string, unknown>)) {
      addCandidates(lineId, candidates);
    }
  }
  return out;
}

function normalizeCandidate(c: unknown): MatchCandidate | null {
  if (!c || typeof c !== 'object') return null;
  const r = c as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) return null;
  return {
    id: r.id,
    name: typeof r.name === 'string' ? r.name : 'Unnamed item',
    sku: typeof r.sku === 'string' ? r.sku : '',
    barcode: typeof r.barcode === 'string' ? r.barcode : null,
    quantityOnHand: Number(r.quantityOnHand) || 0,
    matchType: r.matchType === 'name' ? 'name' : 'barcode',
  };
}

// ── API error → friendly message ────────────────────────────────────────────

/**
 * The api() client throws `Error("API 422: {\"error\":…,\"message\":\"…\"}")`.
 * Pull the server's friendly `message` (or `error`) out so inline errors show
 * "Line 3 has no mapped item…" instead of the raw status+JSON blob. Mirrors
 * stock-api.ts's private extractor.
 */
export function extractApiErrorMessage(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (!raw) return fallback;
  const brace = raw.indexOf('{');
  if (brace >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(brace)) as { message?: unknown; error?: unknown };
      if (typeof parsed.message === 'string' && parsed.message.length > 0) return parsed.message;
      if (typeof parsed.error === 'string' && parsed.error.length > 0) return parsed.error;
    } catch {
      /* not JSON — fall through to the raw text */
    }
  }
  return raw || fallback;
}

// ── Charter payload split (billing vs ownership) ────────────────────────────

/**
 * The two charter choices the approve sheet collects. They are deliberately
 * different shapes because they mean different things:
 *
 *   billToCharterId  — BILLING. null = "Generic" (bill the org only). Written
 *                      to purchase_orders.charter_id, read only by the PO PDF.
 *   itemCharterId    — OWNERSHIP, tri-state. `undefined` = the user stated no
 *                      ownership intent, so approve() must leave every item's
 *                      charter untouched; `null` = explicitly Generic; a uuid =
 *                      explicitly that charter.
 */
export interface CharterDraft {
  billToCharterId: string | null;
  itemCharterId: string | null | undefined;
}

/**
 * Builds the charter half of the approve body.
 *
 * The `itemCharterId` key is OMITTED (not sent as null) when no ownership
 * intent was stated — the server distinguishes absent from null, and an absent
 * key is what makes "change nothing" expressible. Sending null instead would
 * silently re-charter every line to Generic.
 *
 * These two values are never derived from one another. Until 2026-07-22 the
 * mobile sheet held a SINGLE state, labelled "BILL-TO CHARTER", and passed it
 * to both create-items (ownership) and approve (billing) — so on mobile the
 * billing field literally was the ownership field.
 */
export function buildApproveCharterFields(
  draft: CharterDraft,
): { charterId: string | null; itemCharterId?: string | null } {
  return {
    charterId: draft.billToCharterId,
    ...(draft.itemCharterId === undefined ? {} : { itemCharterId: draft.itemCharterId }),
  };
}

/**
 * The ownership charter to stamp on items CREATED from this import.
 * "Keep as-is" (undefined) collapses to null here — a brand-new item has no
 * prior ownership to keep — but it must never collapse to the bill-to charter.
 */
export function ownershipCharterForCreate(draft: CharterDraft): string | null {
  return draft.itemCharterId ?? null;
}
