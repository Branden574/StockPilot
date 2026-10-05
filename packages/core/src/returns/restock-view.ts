/**
 * The returned item's destination, as the screens show it (returns plan 3.5,
 * graft G12). The server proves where a unit was picked from
 * (`return_restock_options`, draw provenance only) and says, per line, which
 * destinations may be offered NOW; this module only turns that answer into
 * option rows and words. It never decides that a rack is valid: the approval
 * and the close re-check everything under lock and refuse what is not.
 *
 * The cases:
 *   single_source   one recorded location: "Return to original rack: 31-C"
 *   full_remainder  several, the return covers everything still out:
 *                   "Return to original racks: 31-C ×1 · 32-A ×2"
 *   partial         several, otherwise: Staging preselected, or one actual
 *                   source chosen by a manager, capped at what is still out
 *                   less the line's returns no rack leg recorded (its cap)
 *   not_recorded    "Original rack unavailable. The original pick location
 *                   was not recorded for this historical order." Staging or
 *                   Scrap only
 *
 * Location names go through the shared holdings formatter
 * (`formatRackHoldings`), never a new copy. Scrap is a disposition, not a
 * destination: a scrap line has no destination group at all (brief 10), and
 * the reason "Damaged" never selects scrap by itself (brief 38).
 *
 * A live plan the server no longer offers (its rack was archived, moved or
 * closed after approval) is never swapped for Staging on the screen: the
 * line opens with no destination chosen, says why, and every button that
 * would send it stays disabled until a valid choice is made (plan 3.5.4).
 * The same holds for a rack the viewer may not stock (`writable` false).
 *
 * Plain literals and pure functions only: importing this module runs nothing.
 */

import { formatRackHoldings } from '../inventory/rack-holdings';
import {
  RETURNS_COPY,
  whenProcessedSentence,
  type ProcessDestination,
  returnToOriginalRackLabel,
  returnToOriginalRacksLabel,
  returnToRackButton,
  returnedToLabel,
  upToLabel,
} from './returns-copy';
import { RETURN_ERROR_WORDS, restockProblemWords } from './return-error-map';

export type RestockCase = 'single_source' | 'full_remainder' | 'partial' | 'not_recorded';
export type RestockTarget = 'staging' | 'original' | 'source';
export type ReturnDispositionChoice = 'restock' | 'scrap';

export interface RestockSource {
  locationId: string;
  name: string | null;
  kind: string | null;
  type: string | null;
  drawn: number;
  restored: number;
  remaining: number;
  /** What a manager may choose here (partial): remaining less the line's
   *  returns no rack leg recorded. Equals remaining when none. */
  cap: number;
  valid: boolean;
  reason: string | null;
  /** Whether THIS viewer may stock the location (the rack leg's own gate). */
  writable: boolean;
}

export interface RestockPlan {
  disposition: ReturnDispositionChoice;
  target: RestockTarget | null;
  locationId: string | null;
  basis: string | null;
  seq: number;
}

/** One line of `return_restock_options` (the SQL answer, camelCase). */
export interface RestockOptionsLine {
  returnLineId: string;
  itemId: string;
  quantity: number;
  disposition: ReturnDispositionChoice;
  applied: boolean;
  plan: RestockPlan | null;
  case: RestockCase | null;
  notRecordedReason: string | null;
  sources: RestockSource[];
  offerOriginal: boolean;
  offerSourceIds: string[];
  preselect: 'original' | 'staging';
}

export interface RestockOptions {
  returnId: string;
  status: string;
  planSeq: number;
  lines: RestockOptionsLine[];
}

/** What a line's choice is: the disposition and, for a restock, the target. */
export interface RestockChoice {
  disposition: ReturnDispositionChoice;
  target: RestockTarget | null;
  locationId: string | null;
  /**
   * Set when NO destination is chosen yet: the live plan is no longer offered
   * (or the destinations could not be read). Holds why, for the screen to say.
   * Such a choice is never offered and never becomes a decision.
   */
  needsChoice?: string;
}

/** One option row the picker renders (radio semantics: exactly one chosen). */
export interface RestockOptionRow {
  /** Stable key: 'original', 'staging' or 'source:<locationId>'. */
  key: string;
  target: RestockTarget;
  locationId: string | null;
  label: string;
  /** "up to N" for a manager-chosen source. */
  help: string | null;
  enabled: boolean;
  /** Why the row cannot be chosen, when it is shown disabled. */
  disabledReason: string | null;
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Reads the SQL answer defensively (unknown keys ignored, numbers coerced). */
export function parseRestockOptions(raw: unknown): RestockOptions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const lines = Array.isArray(o.lines) ? o.lines : [];
  return {
    returnId: str(o.returnId) ?? '',
    status: str(o.status) ?? '',
    planSeq: num(o.planSeq),
    lines: lines.map((l) => {
      const x = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
      const p = x.plan && typeof x.plan === 'object' ? (x.plan as Record<string, unknown>) : null;
      const kase = str(x.case);
      return {
        returnLineId: str(x.returnLineId) ?? '',
        itemId: str(x.itemId) ?? '',
        quantity: num(x.quantity),
        disposition: x.disposition === 'scrap' ? 'scrap' : 'restock',
        applied: x.applied === true,
        plan: p
          ? {
              disposition: p.disposition === 'scrap' ? 'scrap' : 'restock',
              target: (str(p.target) as RestockTarget | null) ?? null,
              locationId: str(p.locationId),
              basis: str(p.basis),
              seq: num(p.seq),
            }
          : null,
        case:
          kase === 'single_source' || kase === 'full_remainder' || kase === 'partial' || kase === 'not_recorded'
            ? kase
            : null,
        notRecordedReason: str(x.notRecordedReason),
        sources: (Array.isArray(x.sources) ? x.sources : []).map((s) => {
          const y = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
          return {
            locationId: str(y.locationId) ?? '',
            name: str(y.name),
            kind: str(y.kind),
            type: str(y.type),
            drawn: num(y.drawn),
            restored: num(y.restored),
            remaining: num(y.remaining),
            cap: y.cap === undefined || y.cap === null ? num(y.remaining) : num(y.cap),
            valid: y.valid === true,
            reason: str(y.reason),
            writable: y.writable !== false,
          };
        }),
        offerOriginal: x.offerOriginal === true,
        offerSourceIds: (Array.isArray(x.offerSourceIds) ? x.offerSourceIds : []).filter(
          (v): v is string => typeof v === 'string',
        ),
        preselect: x.preselect === 'original' ? 'original' : 'staging',
      };
    }),
  };
}

function sourceName(s: RestockSource): string {
  return s.name ?? 'an unnamed location';
}

/**
 * "Original rack is no longer available: 31-C (archived)." naming every
 * source that failed revalidation, so a two-rack line says which one.
 */
function noLongerAvailable(sources: readonly RestockSource[]): string {
  const bad = sources.filter((s) => !s.valid);
  if (bad.length === 0) return RETURNS_COPY.originalNoLongerAvailable;
  const named = bad.map((s) => {
    const why = restockProblemWords(s.reason);
    return why ? `${sourceName(s)} ${why}` : sourceName(s);
  });
  return `${RETURNS_COPY.originalNoLongerAvailable.replace(/\.$/, '')}: ${named.join(', ')}.`;
}

/** The locations an "original" plan would stock: the one source (C1) or every
 *  source with units still out (C2). */
function originalLegSources(line: Pick<RestockOptionsLine, 'case' | 'sources'>): RestockSource[] {
  if (line.case === 'single_source') return line.sources.slice(0, 1);
  return line.sources.filter((s) => s.remaining > 0);
}

/** The original rack(s) may be chosen now, by this viewer. */
function originalOffered(line: RestockOptionsLine): boolean {
  return line.offerOriginal && originalLegSources(line).every((s) => s.writable);
}

/** One proven source may be chosen now, by this viewer. */
function sourceOffered(line: RestockOptionsLine, locationId: string | null): boolean {
  if (!locationId || !line.offerSourceIds.includes(locationId)) return false;
  const s = line.sources.find((x) => x.locationId === locationId);
  return s ? s.writable : false;
}

/** Why a restock target cannot be chosen now (null when it can). */
function targetProblem(line: RestockOptionsLine, target: RestockTarget | null, locationId: string | null): string | null {
  if (target === 'original') {
    if (!line.offerOriginal) {
      return line.case === 'not_recorded' ? RETURNS_COPY.originalNotRecorded : noLongerAvailable(line.sources);
    }
    return originalLegSources(line).every((s) => s.writable) ? null : RETURN_ERROR_WORDS.restockForbidden;
  }
  if (target === 'source') {
    const s = line.sources.find((x) => x.locationId === locationId);
    if (!s || !line.offerSourceIds.includes(s.locationId)) {
      if (s && !s.valid) return noLongerAvailable([s]);
      return RETURNS_COPY.originalLocationsChanged;
    }
    return s.writable ? null : RETURN_ERROR_WORDS.restockForbidden;
  }
  return null;
}

/** The label of the "original" row for C1 or C2. */
export function originalRowLabel(line: Pick<RestockOptionsLine, 'case' | 'sources'>): string {
  if (line.case === 'single_source') {
    const only = line.sources[0];
    return returnToOriginalRackLabel(only ? sourceName(only) : '');
  }
  const legs = formatRackHoldings(
    line.sources.filter((s) => s.remaining > 0).map((s) => ({ name: sourceName(s), quantity: s.remaining })),
  );
  return returnToOriginalRacksLabel(legs ?? '');
}

/**
 * The destination rows for a RESTOCK line, in display order: the original
 * rack(s) or the proven sources first, Staging last and always enabled.
 * A not-recorded line shows the explanation as a disabled row.
 */
export function restockOptionRows(line: RestockOptionsLine): RestockOptionRow[] {
  const rows: RestockOptionRow[] = [];
  switch (line.case) {
    case 'single_source':
    case 'full_remainder':
      rows.push({
        key: 'original',
        target: 'original',
        locationId: null,
        label: originalRowLabel(line),
        help: null,
        enabled: originalOffered(line),
        disabledReason: targetProblem(line, 'original', null),
      });
      break;
    case 'partial':
      for (const s of line.sources) {
        const offered = sourceOffered(line, s.locationId);
        rows.push({
          key: `source:${s.locationId}`,
          target: 'source',
          locationId: s.locationId,
          label: `${RETURNS_COPY.oneOfTheOriginalRacks}: ${sourceName(s)}`,
          help: upToLabel(Math.max(0, s.cap)),
          enabled: offered,
          disabledReason: offered
            ? null
            : !s.valid
              ? noLongerAvailable([s])
              : !line.offerSourceIds.includes(s.locationId)
                ? `Room for ${Math.max(0, s.cap)} here; this return is ${line.quantity}.`
                : RETURN_ERROR_WORDS.restockForbidden,
        });
      }
      break;
    case 'not_recorded':
      rows.push({
        key: 'original',
        target: 'original',
        locationId: null,
        label: RETURNS_COPY.originalNotRecorded,
        help: null,
        enabled: false,
        disabledReason: RETURNS_COPY.originalNotRecorded,
      });
      break;
    default:
      break;
  }
  rows.push({
    key: 'staging',
    target: 'staging',
    locationId: null,
    label: RETURNS_COPY.leaveInStaging,
    help: null,
    enabled: true,
    disabledReason: null,
  });
  return rows;
}

/** The row key a choice selects (none while a destination must be chosen). */
export function choiceKey(choice: RestockChoice): string | null {
  if (choice.needsChoice) return null;
  if (choice.disposition === 'scrap') return null;
  if (choice.target === 'source' && choice.locationId) return `source:${choice.locationId}`;
  return choice.target === 'original' ? 'original' : 'staging';
}

/** The choice a row key and disposition make. */
export function choiceFromKey(disposition: ReturnDispositionChoice, key: string | null): RestockChoice {
  if (disposition === 'scrap') return { disposition: 'scrap', target: null, locationId: null };
  if (key && key.startsWith('source:')) return { disposition: 'restock', target: 'source', locationId: key.slice(7) };
  if (key === 'original') return { disposition: 'restock', target: 'original', locationId: null };
  return { disposition: 'restock', target: 'staging', locationId: null };
}

/**
 * The choice the screen opens with: the live plan while it is still offered;
 * a live plan that is not (its rack was archived, moved or closed, or the
 * viewer may not stock it) opens with NO destination and says why, never
 * quietly as Staging (plan 3.5.4). With no plan: the line's disposition, the
 * original rack preselected for C1 or C2 when offered to this viewer (G12),
 * Staging otherwise.
 */
export function preselectedChoice(line: RestockOptionsLine): RestockChoice {
  if (line.plan) {
    const fromPlan: RestockChoice = {
      disposition: line.plan.disposition,
      target: line.plan.disposition === 'restock' ? (line.plan.target ?? 'staging') : null,
      locationId: line.plan.locationId,
    };
    if (isChoiceOffered(line, fromPlan)) return fromPlan;
    return {
      disposition: 'restock',
      target: null,
      locationId: null,
      needsChoice: targetProblem(line, fromPlan.target, fromPlan.locationId) ?? RETURNS_COPY.originalLocationsChanged,
    };
  }
  if (line.disposition === 'scrap') return { disposition: 'scrap', target: null, locationId: null };
  return line.preselect === 'original' && originalOffered(line)
    ? { disposition: 'restock', target: 'original', locationId: null }
    : { disposition: 'restock', target: 'staging', locationId: null };
}

/**
 * The choice for a line whose destinations could not be read: nothing is
 * chosen, so nothing can be sent (no silent Staging).
 */
export function unreadDestinationChoice(disposition: ReturnDispositionChoice): RestockChoice {
  return { disposition, target: null, locationId: null, needsChoice: RETURNS_COPY.destinationsUnavailable };
}

/** True when the server would accept this choice now, from this viewer
 *  (advisory; the server decides). A choice still to be made never is. */
export function isChoiceOffered(line: RestockOptionsLine, choice: RestockChoice): boolean {
  if (choice.needsChoice) return false;
  if (choice.disposition === 'scrap') return true;
  if (choice.target === 'staging' || choice.target === null) return true;
  if (choice.target === 'original') return originalOffered(line);
  return sourceOffered(line, choice.locationId);
}

/**
 * The live plan, as the read-only summary of an approved RMA shows it:
 * "When processed, New Hire Shirt, M goes back to 31-C." or, when the
 * provenance no longer offers that plan, the line's name and why, with
 * "Choose a destination." (never "goes into Staging" while the stored plan
 * says otherwise).
 */
export function plannedSentence(line: RestockOptionsLine, itemLabel: string | null): string {
  const live = liveChoice(line);
  if (live.disposition === 'restock' && (live.target === 'original' || live.target === 'source')) {
    const offered = live.target === 'original' ? line.offerOriginal : line.offerSourceIds.includes(live.locationId ?? '');
    if (!offered) {
      return whenProcessedSentence(
        { kind: 'choose', reason: targetProblem({ ...line, sources: line.sources.map((s) => ({ ...s, writable: true })) }, live.target, live.locationId) ?? RETURNS_COPY.originalLocationsChanged },
        itemLabel,
      );
    }
  }
  return whenProcessedSentence(processLabelFor(line, live).destination, itemLabel);
}

/** A choice as the RPC body's line decision. A choice still to be made has
 *  none: the screens keep every button that sends one disabled, and this
 *  refuses rather than sending Staging in its place. */
export function choiceToDecision(
  returnLineId: string,
  choice: RestockChoice,
): { returnLineId: string; disposition: ReturnDispositionChoice; restock?: { target: RestockTarget; locationId?: string } } {
  if (choice.needsChoice) throw new Error(`No destination is chosen for return line ${returnLineId}.`);
  if (choice.disposition === 'scrap') return { returnLineId, disposition: 'scrap' };
  const target = choice.target ?? 'staging';
  return target === 'source' && choice.locationId
    ? { returnLineId, disposition: 'restock', restock: { target, locationId: choice.locationId } }
    : { returnLineId, disposition: 'restock', restock: { target: target === 'source' ? 'staging' : target } };
}

/**
 * The line's live decision: its highest-seq plan, or (no plan yet, a legacy
 * RMA) its disposition with a restock landing in Staging, today's close.
 */
export function liveChoice(line: Pick<RestockOptionsLine, 'plan' | 'disposition'>): RestockChoice {
  const plan = line.plan;
  if (plan) {
    return {
      disposition: plan.disposition,
      target: plan.disposition === 'restock' ? (plan.target ?? 'staging') : null,
      locationId: plan.locationId,
    };
  }
  return { disposition: line.disposition, target: line.disposition === 'restock' ? 'staging' : null, locationId: null };
}

/** True when two choices are the same decision. */
export function sameChoice(a: RestockChoice, b: RestockChoice): boolean {
  return choiceKey(a) === choiceKey(b) && a.disposition === b.disposition;
}

/** The process button and its hint for a chosen destination. */
export function processLabelFor(
  line: RestockOptionsLine,
  choice: RestockChoice,
): { destination: ProcessDestination; button: string } {
  if (choice.needsChoice) return { destination: { kind: 'choose', reason: choice.needsChoice }, button: RETURNS_COPY.processReturn };
  if (choice.disposition === 'scrap') return { destination: { kind: 'scrap' }, button: RETURNS_COPY.scrap };
  if (choice.target === 'original') {
    const rack =
      line.case === 'single_source'
        ? sourceName(line.sources[0] ?? ({ name: null } as RestockSource))
        : (formatRackHoldings(line.sources.filter((s) => s.remaining > 0).map((s) => ({ name: sourceName(s), quantity: s.remaining }))) ?? '');
    return { destination: { kind: 'rack', rack }, button: returnToRackButton(rack) };
  }
  if (choice.target === 'source' && choice.locationId) {
    const s = line.sources.find((x) => x.locationId === choice.locationId);
    const rack = s ? sourceName(s) : '';
    return { destination: { kind: 'rack', rack }, button: returnToRackButton(rack) };
  }
  return { destination: { kind: 'staging' }, button: RETURNS_COPY.leaveInStaging };
}

// ── Inbound state (per returned line) ──────────────────────────────────────

/** A closed line's restock legs (from its `return` movements). */
export interface InboundLeg {
  locationName: string | null;
  quantity: number;
  /** true when the leg named a rack (to_location_id set). */
  rack: boolean;
}

/**
 * Waiting, Received, "Returned to 31-C" (or "Returned to 31-C ×1 · 32-A ×2"),
 * In Staging, Scrapped (plan 3.10).
 */
export function inboundStateLabel(input: {
  returnStatus: string;
  applied: boolean;
  disposition: ReturnDispositionChoice;
  legs?: readonly InboundLeg[];
}): string {
  if (!input.applied) {
    if (input.returnStatus === 'received') return RETURNS_COPY.inboundReceived;
    // A denied or cancelled RMA waits for nothing: the item is not coming back.
    if (input.returnStatus === 'denied' || input.returnStatus === 'cancelled') return RETURNS_COPY.inboundNotReturned;
    return RETURNS_COPY.inboundWaiting;
  }
  if (input.disposition === 'scrap') return RETURNS_COPY.inboundScrapped;
  const racks = (input.legs ?? []).filter((l) => l.rack && l.quantity > 0);
  if (racks.length === 0) return RETURNS_COPY.inboundInStaging;
  if (racks.length === 1) return returnedToLabel(racks[0]!.locationName ?? '');
  return returnedToLabel(
    formatRackHoldings(racks.map((l) => ({ name: l.locationName ?? '', quantity: l.quantity }))) ?? '',
  );
}

/** "Inspect before choosing." beside the reason Damaged (never a preselection). */
export function damagedHint(reasonCode: string | null | undefined): string | null {
  return reasonCode === 'damaged' ? RETURNS_COPY.inspectBeforeChoosing : null;
}
