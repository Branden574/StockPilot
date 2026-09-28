/**
 * EVERY SENTENCE ORDER READINESS SHOWS, in one place, so the web order page
 * and the phone order screen read word for word the same.
 *
 * Honest words (owner rules):
 *   - the recorded quantity is "on record", never the accounting jargon;
 *   - no percentages;
 *   - "Ready" only for the ready state (and the all-ready roll-up);
 *   - a PO date is "expected", always with "not a promise";
 *   - nothing is "verified" or "guaranteed", and nothing says an email was
 *     sent.
 * readiness-copy.test.ts renders every sentence and checks those rules.
 */

import { formatOrgDate, formatOrgTime, plainSpaces } from '../time/org-timezone';

import {
  PICKED_LINE_STATES,
  projectCompletePicking,
  READINESS_LINE_CAP,
  READINESS_ORDER_CHANGED_COPY,
  READINESS_STATES,
  type CompletionProjection,
  type NeededBySignal,
  type OrderReadinessResult,
  type ReadinessDraftFacts,
  type ReadinessHold,
  type ReadinessItemAssessment,
  type ReadinessLineAssessment,
  type ReadinessPoShare,
  type ReadinessTone,
} from './readiness';

export interface ReadinessCopyOptions {
  /** The org's time zone, for dates and "Checked at". */
  timeZone?: string;
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** A quantity as people read it: grouped, at most four decimals. */
export function formatReadinessQty(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

const fq = formatReadinessQty;

function isOne(n: number): boolean {
  return Math.abs(n - 1) < 0.00005;
}

/** "Oct 3" in the org's zone. */
function day(iso: string, tz?: string): string {
  return plainSpaces(formatOrgDate(iso, { month: 'short', day: 'numeric' }, tz));
}

/** A PO's expected date, "Oct 3". It is a CALENDAR DATE stored as midnight
 *  UTC of the day typed (the PO form's <input type="date">), so it is read in
 *  UTC: in the org's zone it would print the day before west of UTC (the PO
 *  PDF's rule, lib/pdf/po.tsx). */
function poDay(iso: string): string {
  return day(iso, 'UTC');
}

/** "2:14 PM" in the org's zone. */
function clock(iso: string, tz?: string): string {
  return plainSpaces(formatOrgTime(iso, { hour: 'numeric', minute: '2-digit' }, tz));
}

function lines(n: number): string {
  return `${n} ${n === 1 ? 'line' : 'lines'}`;
}

// ── Fixed sentences ─────────────────────────────────────────────────────────

export const READINESS_READ_FAILED_COPY = "Couldn't check readiness. Try again.";
export const READINESS_LINES_CAPPED_COPY = `This order has more than ${READINESS_LINE_CAP} lines, so readiness isn't checked.`;
export const READINESS_NOT_VISIBLE_COPY =
  "This item isn't visible to you, so its stock can't be checked.";
export const READINESS_ITEM_DELETED_COPY = 'This item was deleted. Remove the line.';
export const READINESS_ITEM_MOVED_COPY =
  'This item now belongs to another warehouse. Approval will refuse it.';
export const READINESS_NEEDS_CONNECTION_COPY = 'Needs a connection.';
export const READINESS_EXPECTED_DATE_CAVEAT = '(an expected date, not a promise)';

/**
 * complete_picking's insufficient_placed_stock, in words (the web service and
 * the phone show the same sentence; the old one blamed Unplaced stock, which
 * the draw engine does take). The draw (0373) raises it whenever the racks,
 * crates, Sites and Unplaced hold less than the batch: units in Staging, OR
 * stock on record that no location holds, with nothing in Staging at all. The
 * error cannot say which, so the sentence names both and claims neither.
 */
export const INSUFFICIENT_PLACED_STOCK_COPY =
  "Picking takes stock from racks, crates, Sites and Unplaced, never from Staging, and they hold less of this item than the pick needs. Put away any of it that is in Staging, or count the item if its locations don't match its stock on record, then try again.";

// ── Failure details ─────────────────────────────────────────────────────────

/** The facts function's own refusals (0377 body gates), as both platforms
 *  word them. */
export const READINESS_ORDER_NOT_FOUND_COPY = 'Order not found.';
export const READINESS_FORBIDDEN_COPY = 'You are not allowed to check readiness for this order.';
export const READINESS_MODULE_OFF_COPY = 'Orders are turned off for this organization.';

const FAILURE_DETAILS: ReadonlySet<string> = new Set([
  READINESS_ORDER_NOT_FOUND_COPY,
  READINESS_FORBIDDEN_COPY,
  READINESS_MODULE_OFF_COPY,
  READINESS_ORDER_CHANGED_COPY,
]);

/**
 * What a failed check says under "Couldn't check readiness. Try again.": its
 * reason, when it is one both platforms can give (the refusals above, and an
 * order that changed while it was checked). Anything else (an internal fault,
 * no answer, an answer that could not be read) shows the headline alone, on
 * the web and the phone alike. Null for an answer that did not fail.
 */
export function readinessFailureDetail(result: OrderReadinessResult): string | null {
  if (result.state !== 'failed') return null;
  return FAILURE_DETAILS.has(result.message) ? result.message : null;
}

// ── Line ────────────────────────────────────────────────────────────────────

function onShelf(ready: number): string {
  return `${fq(ready)} on the shelf`;
}

function stagingSentence(putAway: number, more: boolean): string {
  const verb = isOne(putAway) ? 'is' : 'are';
  const them = isOne(putAway) ? 'it' : 'them';
  return `${fq(putAway)}${more ? ' more' : ''} ${verb} in Staging and must be put away before picking can take ${them}.`;
}

function shareSentence(share: ReadinessPoShare): string {
  if (share.kind === 'hidden') {
    return `${fq(share.units)} ${isOne(share.units) ? 'is' : 'are'} on a PO you can't open.`;
  }
  if (share.kind === 'unlisted') {
    return `${fq(share.units)} ${isOne(share.units) ? 'is' : 'are'} on a PO not listed here, so no expected date is shown.`;
  }
  const po = share.poNumber ?? 'A PO';
  const qty = fq(share.poRemaining ?? share.units);
  if (share.expectedAt) {
    return `${po} expects ${qty} on ${poDay(share.expectedAt)} ${READINESS_EXPECTED_DATE_CAVEAT}.`;
  }
  return `${po} has ${qty} on order, with no expected date on the PO.`;
}

function poSentences(shares: readonly ReadinessPoShare[]): string {
  if (shares.length === 0) return '';
  const first = shareSentence(shares[0]!);
  if (shares.length === 1) return first;
  const rest = shares.slice(1);
  const units = rest.reduce((s, x) => s + x.units, 0);
  const hidden = rest.filter((x) => x.kind === 'hidden').reduce((s, x) => s + x.units, 0);
  const where =
    rest.length === 1 && rest[0]!.kind === 'po'
      ? 'another PO'
      : hidden > 0 && hidden < units
        ? `other POs, ${fq(hidden)} of them on POs you can't open`
        : hidden > 0
          ? "POs you can't open"
          : 'other POs';
  return `${first} ${fq(units)} more ${isOne(units) ? 'is' : 'are'} on ${where}.`;
}

/**
 * Who already needs the item's open PO units when a line is short past them:
 * other orders' committed shortfall (it takes the earliest POs, readiness.ts),
 * and this order's other lines of the same item (earlier lines first). Null
 * when nothing is on order, or when all of it went to this line.
 */
function inboundTakenBy(line: ReadinessLineAssessment, item: ReadinessItemAssessment | null): string | null {
  const q = item?.quantities;
  const f = item?.facts;
  if (!q || !f?.inbound || q.inboundRemaining <= 0) return null;
  const others = Math.min(f.committedOtherShortfall, q.inboundRemaining) > 0.00005;
  const ownOther = q.awaiting - (line.units?.awaiting ?? 0) > 0.00005;
  if (others && ownOther) return "other orders and this item's other lines on this order";
  if (others) return 'other orders';
  if (ownOther) return "this item's other lines on this order";
  return null;
}

/**
 * The draft POs the reader can open, in words: "draft PO-0043" when there is
 * exactly one, "4 draft POs" for several, "more than 10 draft POs" past the
 * facts' row cap (0377 lists 10). Null when none can be opened.
 *
 * A draft's number is named only when it is the only one. F2-1 production
 * walk (2026-09-28): an item on four drafts of 25 said "On draft
 * PO-1785135627464 100", the first draft's number beside the total of all
 * four, so that PO read as holding 100.
 */
function openDraftsPhrase(drafts: ReadinessDraftFacts): string | null {
  const n = drafts.rows.length;
  if (drafts.truncated) return `more than ${n} draft POs`;
  if (n === 1) return `draft ${drafts.rows[0]!.poNumber}`;
  if (n > 1) return `${n} draft POs`;
  return null;
}

function draftSentence(item: ReadinessItemAssessment | null, shortUnits: number): string | null {
  const drafts = item?.facts?.drafts;
  if (!drafts) return null;
  const covers = Math.min(shortUnits, item?.quantities?.draftRemaining ?? 0);
  if (covers <= 0) return null;
  // Units on drafts the reader can't open are a quantity only (0377): how
  // many drafts hold them is not known, so none is counted or named.
  const open = drafts.hiddenRemaining > 0 ? null : openDraftsPhrase(drafts);
  if (!open) return `Draft POs cover ${fq(covers)} but have not been ordered.`;
  if (drafts.rows.length === 1 && !drafts.truncated) {
    return `Draft ${drafts.rows[0]!.poNumber} covers ${fq(covers)} but has not been ordered.`;
  }
  return `${open.charAt(0).toUpperCase()}${open.slice(1)} cover ${fq(covers)} but have not been ordered.`;
}

/**
 * One sentence (or two) for a line, by its state. `item` is the line's item
 * assessment (for drafts and the on-record numbers).
 */
export function describeReadinessLine(
  line: ReadinessLineAssessment,
  item: ReadinessItemAssessment | null,
  // Kept so every caller passes the org's zone the same way; a line's only
  // date is a PO's, a calendar day read in UTC (poDay).
  _opts: ReadinessCopyOptions = {},
): string {
  // What a line owes is on the line itself, readable or not.
  if (line.state === 'handed_over' || line.notes.includes('nothing_owed')) {
    return 'Nothing left to pick: all of this line was handed over.';
  }
  if (line.reasons.includes('not_visible') || !line.units) return READINESS_NOT_VISIBLE_COPY;
  const u = line.units;
  if (line.reasons.includes('item_deleted')) return READINESS_ITEM_DELETED_COPY;
  if (line.reasons.includes('item_moved')) return READINESS_ITEM_MOVED_COPY;

  const parts: string[] = [];
  const covered = u.ready > 0;
  if (line.state === 'ready') {
    parts.push(`${onShelf(u.ready)} for this order.`);
    if (u.noRack > 0) parts.push(`Includes ${fq(u.noRack)} with no rack recorded.`);
    return parts.join(' ');
  }

  if (covered) parts.push(`${onShelf(u.ready)}.`);
  if (u.putAway > 0) parts.push(stagingSentence(u.putAway, covered));
  if (u.gap > 0 && line.reasons.includes('held_elsewhere')) {
    parts.push(
      `${fq(u.gap)} ${isOne(u.gap) ? 'is' : 'are'} in another warehouse and ${isOne(u.gap) ? 'is' : 'are'} not counted here.`,
    );
  }
  // Who already needs what is on order, when this line is short past it
  // (never "nothing is on order" while a PO for the item is open).
  const takenBy = u.short > 0 ? inboundTakenBy(line, item) : null;
  if (u.awaiting > 0) {
    // "N short now", then where the awaited units come from; any rest is
    // short: not on order, or on order but already needed elsewhere.
    parts.push(`${fq(u.awaiting + u.short)} short now.`);
    parts.push(poSentences(line.poShares));
    if (u.short > 0) {
      const verb = isOne(u.short) ? 'is' : 'are';
      parts.push(
        takenBy
          ? `${fq(u.short)} of them ${verb} not covered: the rest of what is on order is already needed by ${takenBy}.`
          : `${fq(u.short)} of them ${verb} not on order.`,
      );
    }
  } else if (u.short > 0) {
    parts.push(`${fq(u.short)} short.`);
  }
  if (u.short > 0) {
    const draft = draftSentence(item, u.short);
    if (u.awaiting <= 0 && item?.facts?.inbound) {
      if (takenBy) parts.push(`What is on order is already needed by ${takenBy}.`);
      else if (!draft) parts.push('Nothing is on order.');
    }
    if (draft) parts.push(draft);
  }
  if (line.reasons.includes('records_disagree') && item?.facts && item.quantities) {
    parts.push(recordsDisagreeSentence(item));
  }
  return parts.filter(Boolean).join(' ');
}

function recordsDisagreeSentence(item: ReadinessItemAssessment): string {
  const f = item.facts!;
  const q = item.quantities!;
  return `On record: ${fq(f.onHand)}, but its locations account for ${fq(q.locationsTotal)}. A count will settle it.`;
}

/** The short label a line's chip shows. */
export function readinessLineLabel(line: ReadinessLineAssessment): string {
  return READINESS_STATES[line.state].label;
}

/** The screen-reader label for a line: "Line 2, Needs put-away, 4 in Staging". */
export function readinessLineAccessibilityLabel(line: ReadinessLineAssessment): string {
  const label = READINESS_STATES[line.state].label;
  const u = line.units;
  let detail: string;
  if (line.state === 'handed_over' || line.notes.includes('nothing_owed')) detail = 'nothing left to pick';
  else if (!u) detail = "stock can't be checked";
  else if (line.state === 'ready') detail = `${fq(u.ready)} on the shelf`;
  else if (line.state === 'needs_put_away') detail = `${fq(u.putAway)} in Staging`;
  else if (line.state === 'awaiting_po') detail = `${fq(u.awaiting)} on order`;
  else if (line.state === 'short') detail = `${fq(u.short)} short`;
  else if (line.reasons.includes('records_disagree')) detail = 'on record and locations disagree';
  else if (line.reasons.includes('held_elsewhere')) detail = `${fq(u.gap)} in another warehouse`;
  else detail = "stock can't be checked";
  return `Line ${line.position}, ${label}, ${detail}`;
}

// ── Holds ───────────────────────────────────────────────────────────────────

export function describeReadinessHold(hold: ReadinessHold | null): string | null {
  if (!hold) return null;
  if (hold.state === 'held') return 'Held for this order';
  if (hold.state === 'partly_held') return `Held ${fq(hold.held)} of ${fq(hold.of)}`;
  return 'Not held: another order could take this stock.';
}

// ── Why ─────────────────────────────────────────────────────────────────────

/**
 * The numbers behind an item's lines, as short parts ("On record 20", "In
 * Staging 4", ...). `text` joins them with " · ".
 */
export function describeReadinessWhy(
  item: ReadinessItemAssessment,
  // As describeReadinessLine: the PO dates here are calendar days (poDay).
  _opts: ReadinessCopyOptions = {},
): { parts: string[]; text: string } {
  if (!item.visible || !item.facts || !item.quantities) {
    return { parts: [READINESS_NOT_VISIBLE_COPY], text: READINESS_NOT_VISIBLE_COPY };
  }
  const f = item.facts;
  const q = item.quantities;
  const parts: string[] = [`On record ${fq(f.onHand)}`];
  const others = f.heldOtherOrders + f.heldRentals;
  if (others > 0) {
    parts.push(
      f.heldRentals > 0
        ? `Held for other orders ${fq(others)}, including ${fq(f.heldRentals)} for rentals`
        : `Held for other orders ${fq(others)}`,
    );
  }
  if (f.heldOwn > 0) parts.push(`Held for this order ${fq(f.heldOwn)}`);
  if (f.here.staging > 0) parts.push(`In Staging ${fq(f.here.staging)}`);
  const noRack = f.here.unplaced + f.here.site;
  if (noRack > 0) parts.push(`No rack recorded ${fq(noRack)}`);
  const elsewhere = f.elsewhere.pickable + f.elsewhere.staging;
  if (elsewhere > 0) parts.push(`In other warehouses ${fq(elsewhere)}, not counted here`);
  if (q.recordsDisagree) parts.push(`Its locations account for ${fq(q.locationsTotal)}`);
  if (f.inbound) {
    for (const row of f.inbound.rows.slice(0, 3)) {
      parts.push(
        row.expectedAt
          ? `On order ${row.poNumber}: ${fq(row.remaining)} expected ${poDay(row.expectedAt)} ${READINESS_EXPECTED_DATE_CAVEAT}`
          : `On order ${row.poNumber}: ${fq(row.remaining)}, no expected date`,
      );
    }
    const more = f.inbound.rows.slice(3).reduce((s, r) => s + r.remaining, 0) + f.inbound.truncatedRemaining;
    if (more > 0) parts.push(`On other POs ${fq(more)}`);
    if (f.inbound.hiddenRemaining > 0) {
      parts.push(`On POs you can't open ${fq(f.inbound.hiddenRemaining)}`);
    }
  }
  if (f.drafts && q.draftRemaining > 0) {
    // As on-order POs above: the drafts the reader can open (named when
    // there is one, counted when there are several), then a quantity only
    // for the ones they can't.
    const open = openDraftsPhrase(f.drafts);
    const openUnits = f.drafts.rows.reduce((s, r) => s + r.remaining, 0) + f.drafts.truncatedRemaining;
    if (open && openUnits > 0) parts.push(`On ${open} ${fq(openUnits)} (not ordered)`);
    if (f.drafts.hiddenRemaining > 0) {
      parts.push(`On draft POs you can't open ${fq(f.drafts.hiddenRemaining)} (not ordered)`);
    }
  }
  if (f.pendingOthers && f.pendingOthers.orders > 0) {
    const n = f.pendingOthers.orders;
    parts.push(
      `${n} other ${n === 1 ? 'order' : 'orders'} waiting for approval also ${n === 1 ? 'asks' : 'ask'} for this item (${fq(f.pendingOthers.units)}); stock is held by whichever is approved first`,
    );
  }
  if (f.isBundle) parts.push('A kit: its stock is the kit\'s own');
  return { parts, text: parts.join(' · ') };
}

// ── Needed-by ───────────────────────────────────────────────────────────────

export function neededBySignalCopy(
  signal: NeededBySignal | null,
  neededBy: string | null,
  opts: ReadinessCopyOptions = {},
): string | null {
  if (!signal) return null;
  if (signal === 'past_due') {
    return neededBy
      ? `Past its needed-by date (${day(neededBy, opts.timeZone)})`
      : 'Past its needed-by date';
  }
  return 'May miss its needed-by date';
}

// ── Order roll-up ───────────────────────────────────────────────────────────

export interface ReadinessRollupCopy {
  /** The one line the strip leads with. */
  headline: string;
  tone: ReadinessTone;
  icon: string;
  /** Further counts, worst first. */
  details: string[];
  /** The needed-by signal, if any. */
  neededBy: string | null;
  /** "Checked at 2:14 PM. Stock can change after this." (null when failed). */
  checkedAt: string | null;
  /** A failed check's reason under the headline (readinessFailureDetail),
   *  when it has one both platforms give; null otherwise. */
  detail: string | null;
}

/** "Checked at 2:14 PM. Stock can change after this." */
export function readinessCheckedAtCopy(observedAt: string, opts: ReadinessCopyOptions = {}): string {
  return `Checked at ${clock(observedAt, opts.timeZone)}. Stock can change after this.`;
}

/** The offline banner: the last assessment, and when it was taken. */
export function readinessOfflineCopy(observedAt: string, opts: ReadinessCopyOptions = {}): string {
  return `You're offline. This is how the order looked at ${clock(observedAt, opts.timeZone)}.`;
}

/**
 * The strip's roll-up. Null for a closed order (nothing is shown). Green
 * ("Ready to pick (5 of 5 lines)") only when every line is ready and every fact
 * was readable; there is never a positive "on track" claim.
 */
export function describeReadinessRollup(
  result: OrderReadinessResult,
  opts: ReadinessCopyOptions = {},
): ReadinessRollupCopy | null {
  if (result.state === 'failed') {
    return {
      headline: READINESS_READ_FAILED_COPY,
      tone: READINESS_STATES.unknown.tone,
      icon: READINESS_STATES.unknown.icon,
      details: [],
      neededBy: null,
      checkedAt: null,
      detail: readinessFailureDetail(result),
    };
  }
  const a = result.assessment;
  if (a.phase === 'closed') return null;
  const checkedAt = readinessCheckedAtCopy(a.observedAt, opts);
  const neededBy = neededBySignalCopy(a.rollup.neededBySignal, a.rollup.neededBy, opts);
  if (a.rollup.capped) {
    return {
      headline: READINESS_LINES_CAPPED_COPY,
      tone: READINESS_STATES.unknown.tone,
      icon: READINESS_STATES.unknown.icon,
      details: [],
      neededBy,
      checkedAt,
      detail: null,
    };
  }
  if (a.phase === 'picked') {
    const { counts, lineCount } = a.rollup;
    if (counts.short_picked === 0) {
      return {
        headline: `Picked (${lineCount} of ${lineCount} ${lineCount === 1 ? 'line' : 'lines'})`,
        tone: PICKED_LINE_STATES.picked_complete.tone,
        icon: PICKED_LINE_STATES.picked_complete.icon,
        details: [],
        neededBy,
        checkedAt,
        detail: null,
      };
    }
    return {
      headline: `${lines(counts.short_picked)} not fully picked`,
      tone: PICKED_LINE_STATES.short_picked.tone,
      icon: PICKED_LINE_STATES.short_picked.icon,
      details: [`${counts.picked_complete} of ${lineCount} ${lineCount === 1 ? 'line' : 'lines'} picked`],
      neededBy,
      checkedAt,
      detail: null,
    };
  }
  const { counts, lineCount } = a.rollup;
  // Handed-over lines have nothing to pick: they are counted apart, never as
  // ready (a backordered order's finished lines).
  const owedCount = lineCount - counts.handed_over;
  const handedOver = counts.handed_over > 0 ? `${lines(counts.handed_over)} handed over` : null;
  if (a.rollup.ready) {
    return {
      headline: `Ready to pick (${owedCount} of ${owedCount} ${owedCount === 1 ? 'line' : 'lines'})`,
      tone: READINESS_STATES.ready.tone,
      icon: READINESS_STATES.ready.icon,
      details: handedOver ? [handedOver] : [],
      neededBy,
      checkedAt,
      detail: null,
    };
  }
  const parts: Array<{ state: keyof typeof READINESS_STATES; text: string }> = [];
  if (counts.short > 0) parts.push({ state: 'short', text: `${lines(counts.short)} short` });
  if (counts.unknown > 0) {
    parts.push({
      state: 'unknown',
      text: `${lines(counts.unknown)} can't be confirmed`,
    });
  }
  if (counts.awaiting_po > 0) {
    parts.push({ state: 'awaiting_po', text: `${lines(counts.awaiting_po)} waiting on a PO` });
  }
  if (counts.needs_put_away > 0) {
    parts.push({
      state: 'needs_put_away',
      text: `${lines(counts.needs_put_away)} ${counts.needs_put_away === 1 ? 'needs' : 'need'} put-away`,
    });
  }
  const first = parts[0];
  if (!first && lineCount > 0 && owedCount === 0) {
    // Every line was handed over: nothing to pick, and nothing is claimed.
    return {
      headline: 'Nothing left to pick: every line was handed over.',
      tone: READINESS_STATES.handed_over.tone,
      icon: READINESS_STATES.handed_over.icon,
      details: [],
      neededBy,
      checkedAt,
      detail: null,
    };
  }
  if (!first) {
    // No lines at all: nothing is ready, and nothing is claimed.
    return {
      headline: 'This order has no lines to check.',
      tone: READINESS_STATES.unknown.tone,
      icon: READINESS_STATES.unknown.icon,
      details: [],
      neededBy,
      checkedAt,
      detail: null,
    };
  }
  const details = parts.slice(1).map((p) => p.text);
  details.push(`${counts.ready} of ${owedCount} ${owedCount === 1 ? 'line' : 'lines'} ready to pick`);
  if (handedOver) details.push(handedOver);
  return {
    headline: first.text,
    tone: READINESS_STATES[first.state].tone,
    icon: READINESS_STATES[first.state].icon,
    details,
    neededBy,
    checkedAt,
    detail: null,
  };
}

// ── Requester ───────────────────────────────────────────────────────────────

export const REQUESTER_ALL_IN_STOCK_COPY = 'All items are in stock.';
export const REQUESTER_WAITING_COPY = 'Some items are waiting on stock.';
export const REQUESTER_CHECKING_COPY = "We're checking stock for some items.";
/** The check failed: it says so, never that stock is being checked. */
export const REQUESTER_CHECK_FAILED_COPY = "Stock couldn't be checked just now.";

/**
 * The one sentence a requester (without the full panel) sees. Null outside
 * the to_pick phase, and when every line was handed over (nothing to say). No
 * numbers, no PO references, no other orders.
 */
export function readinessSummaryForRequester(result: OrderReadinessResult): string | null {
  if (result.state === 'failed') return REQUESTER_CHECK_FAILED_COPY;
  const a = result.assessment;
  if (a.phase !== 'to_pick') return null;
  if (a.rollup.capped || a.lines.length === 0) return REQUESTER_CHECKING_COPY;
  const { counts } = a.rollup;
  if (counts.handed_over === a.lines.length) return null;
  if (counts.short > 0 || counts.awaiting_po > 0) return REQUESTER_WAITING_COPY;
  if (counts.unknown > 0) return REQUESTER_CHECKING_COPY;
  return REQUESTER_ALL_IN_STOCK_COPY;
}

/** What the requester's card shows, on the web and the phone alike. */
export interface ReadinessRequesterCopy {
  sentence: string;
  tone: ReadinessTone;
  icon: string;
  /** "Checked at 2:14 PM. Stock can change after this." (null when failed). */
  checkedAt: string | null;
  /** The check failed: the button says Try again. */
  failed: boolean;
}

/**
 * The requester's card: the one sentence, its tone and icon (never colour
 * alone), and when it was checked, so both platforms lay it out the same way
 * (the sentence, "Checked at", and Check again / Try again). Null when there
 * is nothing to say.
 */
export function describeReadinessForRequester(
  result: OrderReadinessResult,
  opts: ReadinessCopyOptions = {},
): ReadinessRequesterCopy | null {
  const sentence = readinessSummaryForRequester(result);
  if (!sentence) return null;
  const [tone, icon]: [ReadinessTone, string] =
    sentence === REQUESTER_ALL_IN_STOCK_COPY
      ? [READINESS_STATES.ready.tone, READINESS_STATES.ready.icon]
      : sentence === REQUESTER_WAITING_COPY
        ? ['warning', 'clock']
        : [READINESS_STATES.unknown.tone, READINESS_STATES.unknown.icon];
  return {
    sentence,
    tone,
    icon,
    checkedAt: result.state === 'ok' ? readinessCheckedAtCopy(result.assessment.observedAt, opts) : null,
    failed: result.state === 'failed',
  };
}

// ── Completion confirm ──────────────────────────────────────────────────────

/** A line that will be picked short: what the pick takes against what the
 *  line owes. `batch` null (unknown) reads as 0. */
export interface ShortPickLine {
  itemName: string | null;
  batch: number | null;
  owed: number;
}

/**
 * "Not everything will be picked. L4L - Pen Black & Rose Gold: 0 of 60. It
 * will be owed at hand-over, or you can remove it from the order first."
 * Null when no line is short. One sentence for every completion confirm: the
 * one-click "Mark picking complete" (from projectCompletePicking) and the
 * digital pick's own dialog (from what the picker entered), on web and phone.
 */
export function describeShortPickLines(lines: readonly ShortPickLine[]): string | null {
  const short = lines.filter((l) => (l.batch ?? 0) < l.owed - 0.00005);
  if (short.length === 0) return null;
  const listed = short.map((l) => `${l.itemName ?? 'An item'}: ${fq(l.batch ?? 0)} of ${fq(l.owed)}`).join('; ');
  const one = short.length === 1;
  return `Not everything will be picked. ${listed}. ${one ? 'It' : 'They'} will be owed at hand-over, or you can remove ${one ? 'it' : 'them'} from the order first.`;
}

/**
 * The confirm before "Mark picking complete" (F2-2 wires it): what will come up
 * short, what would make the pick fail, and what could not be checked. Null
 * when nothing needs saying. A failed readiness read always says so: the
 * confirm is never skipped for want of facts.
 */
export function describeCompletionProjection(
  projection: CompletionProjection | null,
  readinessFailed: boolean,
): string[] | null {
  if (readinessFailed || !projection) return ["Stock couldn't be checked. Picking may come up short."];
  if (projection.capped) return [READINESS_LINES_CAPPED_COPY, 'Picking may come up short.'];
  const out: string[] = [];
  const shortSentence = describeShortPickLines(projection.shortLines);
  if (shortSentence) out.push(shortSentence);
  for (const f of projection.failingItems) {
    if (f.reason !== 'insufficient_placed_stock') {
      out.push(`Picking can't finish: ${f.itemName} has less on record than this pick needs.`);
      continue;
    }
    // Staging only for what IS in Staging; the rest is on record but in no
    // location (a count settles it), never "in Staging".
    if (f.needPutAway > 0) {
      out.push(
        `Picking can't finish until ${fq(f.needPutAway)} of ${f.itemName} in Staging ${isOne(f.needPutAway) ? 'is' : 'are'} put away.`,
      );
    }
    if (f.unaccounted > 0) {
      const one = isOne(f.unaccounted);
      out.push(
        `Picking can't finish: ${fq(f.unaccounted)} of ${f.itemName} ${one ? 'is' : 'are'} on record, but no location holds ${one ? 'it' : 'them'}. A count will settle it.`,
      );
    }
  }
  if (projection.unknownItemIds.length > 0) {
    const n = projection.unknownItemIds.length;
    out.push(`Stock couldn't be checked for ${n} ${n === 1 ? 'item' : 'items'}. Picking may come up short.`);
  }
  return out.length > 0 ? out : null;
}

/** The completion confirm's title and buttons (web and phone alike). */
export const COMPLETION_CONFIRM_TITLE = 'Before you complete picking';
export const COMPLETION_REVIEW_LABEL = 'Review short lines';
export const COMPLETION_CONFIRM_LABEL = 'Complete picking';

export interface CompletionConfirmCopy {
  title: string;
  /** What will come up short, what would stop the pick, what was not checked. */
  paragraphs: string[];
  /** "Review short lines": closes the confirm and focuses `focusLineId`. */
  reviewLabel: string;
  /** "Complete picking": goes ahead (the server decides, as always). */
  confirmLabel: string;
  /** The first line to look at: the first short line, else the first line of
   *  an item that would stop the pick; null when the check failed. */
  focusLineId: string | null;
}

/**
 * The confirm before "Mark picking complete" (the SO-000100 button) and the
 * digital pick's Complete, or null when nothing needs saying. It is shown
 * whenever a line will be picked short, the pick would fail, an item could not
 * be checked, or the check itself failed: the confirm is never skipped for
 * want of facts. UI only (F2 decision D17): complete_picking stays permissive.
 */
export function describeCompletionConfirm(
  projection: CompletionProjection | null,
  readinessFailed: boolean,
): CompletionConfirmCopy | null {
  const paragraphs = describeCompletionProjection(projection, readinessFailed);
  if (!paragraphs) return null;
  const failing = projection?.failingItems[0]?.itemId ?? null;
  const focusLineId = readinessFailed || !projection
    ? null
    : projection.shortLines[0]?.lineId
      ?? (failing ? projection.lines.find((l) => l.itemId === failing)?.lineId ?? null : null);
  return {
    title: COMPLETION_CONFIRM_TITLE,
    paragraphs,
    reviewLabel: COMPLETION_REVIEW_LABEL,
    confirmLabel: COMPLETION_CONFIRM_LABEL,
    focusLineId,
  };
}

// ── The digital pick's confirm ──────────────────────────────────────────────

/** One line of a digital pick, as its completion confirm reads it. */
export interface PickCompletionLine {
  /** order_request_lines.id */
  id: string;
  itemName: string | null;
  /** lineOwedUnits: requested less handed over. */
  owed: number;
  /** What the picker entered (clamped), which Complete saves first. */
  picking: number;
}

function sameLineSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const theirs = new Set(a.map((x) => x.toLowerCase()));
  return b.every((x) => theirs.has(x.toLowerCase()));
}

/** Prepends what the picker entered short (when the copy could not know it),
 *  and points the review at the first of those lines. */
function withEnteredShortLines(
  copy: CompletionConfirmCopy,
  lines: readonly PickCompletionLine[],
): CompletionConfirmCopy {
  const sentence = describeShortPickLines(
    lines.map((l) => ({ itemName: l.itemName, batch: Math.min(l.picking, l.owed), owed: l.owed })),
  );
  const firstShort = lines.find((l) => Math.min(l.picking, l.owed) < l.owed - 0.00005)?.id ?? null;
  return {
    ...copy,
    paragraphs: sentence ? [sentence, ...copy.paragraphs] : copy.paragraphs,
    focusLineId: copy.focusLineId ?? firstShort,
  };
}

/**
 * The confirm before a DIGITAL pick is completed (F2-2), web and phone alike,
 * or null when nothing needs saying.
 *
 * The digital pick saves what the picker entered before it completes, so
 * complete_picking takes min(entered, owed) per line. With readiness read for
 * these lines, the order's assessment is taken with each line's `picked` set
 * to what was entered, and projectCompletePicking says which lines come up
 * short and whether the draw would fail (units in Staging are never picked);
 * describeCompletionConfirm words it. Without it (not read, failed, or read
 * for another set of lines), what was entered is still known: its short
 * lines are named, followed by "Stock couldn't be checked. Picking may come up
 * short." Never skipped for want of facts. An order past the line cap says so,
 * with what was entered.
 */
export function digitalPickCompletionConfirm(
  lines: readonly PickCompletionLine[],
  readiness: OrderReadinessResult | null | undefined,
): CompletionConfirmCopy | null {
  const assessment =
    readiness?.state === 'ok' && readiness.assessment.phase === 'to_pick' ? readiness.assessment : null;

  if (assessment && assessment.linesCapped) {
    const copy = describeCompletionConfirm(projectCompletePicking(assessment), false);
    return copy ? withEnteredShortLines(copy, lines) : null;
  }

  if (
    assessment &&
    sameLineSet(
      assessment.lines.map((l) => l.lineId),
      lines.map((l) => l.id),
    )
  ) {
    const entered = new Map(lines.map((l) => [l.id.toLowerCase(), l.picking]));
    const projection = projectCompletePicking({
      ...assessment,
      lines: assessment.lines.map((l) => ({ ...l, picked: entered.get(l.lineId.toLowerCase()) ?? 0 })),
    });
    return describeCompletionConfirm(projection, false);
  }

  const failed = describeCompletionConfirm(null, true);
  return failed ? withEnteredShortLines(failed, lines) : null;
}
