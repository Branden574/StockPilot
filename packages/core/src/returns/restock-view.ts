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
 *   not_recorded    "Original rack unavailable. The original pick location
 *                   was not recorded for this historical order." Staging or
 *                   Scrap only
 *
 * Location names go through the shared holdings formatter
 * (`formatRackHoldings`), never a new copy. Scrap is a disposition, not a
 * destination: a scrap line has no destination group at all (brief 10), and
 * the reason "Damaged" never selects scrap by itself (brief 38).
 *
 * Plain literals and pure functions only: importing this module runs nothing.
 */

import { formatRackHoldings } from '../inventory/rack-holdings';
import {
  RETURNS_COPY,
  returnToOriginalRackLabel,
  returnToOriginalRacksLabel,
  returnToRackButton,
  returnedToLabel,
  upToLabel,
} from './returns-copy';
import { restockProblemWords } from './return-error-map';

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
  valid: boolean;
  reason: string | null;
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
            valid: y.valid === true,
            reason: str(y.reason),
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

/** "Original rack is no longer available. (archived)" for the first invalid source. */
function noLongerAvailable(sources: readonly RestockSource[]): string {
  const bad = sources.find((s) => !s.valid);
  const why = restockProblemWords(bad?.reason ?? null);
  return why ? `${RETURNS_COPY.originalNoLongerAvailable} ${why}` : RETURNS_COPY.originalNoLongerAvailable;
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
        enabled: line.offerOriginal,
        disabledReason: line.offerOriginal ? null : noLongerAvailable(line.sources),
      });
      break;
    case 'partial':
      for (const s of line.sources) {
        const offered = line.offerSourceIds.includes(s.locationId);
        rows.push({
          key: `source:${s.locationId}`,
          target: 'source',
          locationId: s.locationId,
          label: `${RETURNS_COPY.oneOfTheOriginalRacks}: ${sourceName(s)}`,
          help: upToLabel(Math.max(0, s.remaining)),
          enabled: offered,
          disabledReason: offered
            ? null
            : !s.valid
              ? noLongerAvailable([s])
              : `Room for ${Math.max(0, s.remaining)} here; this return is ${line.quantity}.`,
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

/** The row key a choice selects. */
export function choiceKey(choice: RestockChoice): string | null {
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
 * The choice the screen opens with: the live plan when one exists and is
 * still offered; otherwise the line's disposition, with the original rack
 * preselected for C1 or C2 when valid (G12) and Staging otherwise.
 */
export function preselectedChoice(line: RestockOptionsLine): RestockChoice {
  if (line.plan) {
    const fromPlan: RestockChoice = {
      disposition: line.plan.disposition,
      target: line.plan.disposition === 'restock' ? (line.plan.target ?? 'staging') : null,
      locationId: line.plan.locationId,
    };
    if (isChoiceOffered(line, fromPlan)) return fromPlan;
    return { disposition: line.plan.disposition, target: line.plan.disposition === 'restock' ? 'staging' : null, locationId: null };
  }
  if (line.disposition === 'scrap') return { disposition: 'scrap', target: null, locationId: null };
  return line.preselect === 'original' && line.offerOriginal
    ? { disposition: 'restock', target: 'original', locationId: null }
    : { disposition: 'restock', target: 'staging', locationId: null };
}

/** True when the server would accept this choice now (advisory; the server decides). */
export function isChoiceOffered(line: RestockOptionsLine, choice: RestockChoice): boolean {
  if (choice.disposition === 'scrap') return true;
  if (choice.target === 'staging' || choice.target === null) return true;
  if (choice.target === 'original') return line.offerOriginal;
  return choice.locationId !== null && line.offerSourceIds.includes(choice.locationId);
}

/** A choice as the RPC body's line decision. */
export function choiceToDecision(
  returnLineId: string,
  choice: RestockChoice,
): { returnLineId: string; disposition: ReturnDispositionChoice; restock?: { target: RestockTarget; locationId?: string } } {
  if (choice.disposition === 'scrap') return { returnLineId, disposition: 'scrap' };
  const target = choice.target ?? 'staging';
  return target === 'source' && choice.locationId
    ? { returnLineId, disposition: 'restock', restock: { target, locationId: choice.locationId } }
    : { returnLineId, disposition: 'restock', restock: { target: target === 'source' ? 'staging' : target } };
}

/** True when two choices are the same decision. */
export function sameChoice(a: RestockChoice, b: RestockChoice): boolean {
  return choiceKey(a) === choiceKey(b) && a.disposition === b.disposition;
}

/** The process button and its hint for a chosen destination. */
export function processLabelFor(
  line: RestockOptionsLine,
  choice: RestockChoice,
): { destination: { kind: 'rack'; rack: string } | { kind: 'staging' } | { kind: 'scrap' }; button: string } {
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
    return input.returnStatus === 'received' ? RETURNS_COPY.inboundReceived : RETURNS_COPY.inboundWaiting;
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
