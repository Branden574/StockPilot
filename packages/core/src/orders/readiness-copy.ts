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
  READINESS_LINE_CAP,
  READINESS_STATES,
  type CompletionProjection,
  type NeededBySignal,
  type OrderReadinessResult,
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
 * the draw engine does take).
 */
export const INSUFFICIENT_PLACED_STOCK_COPY =
  'Part of this item is still in Staging. Picking takes stock from racks, crates, Sites and Unplaced, never from Staging. Put the needed units away, then try again.';

// ── Line ────────────────────────────────────────────────────────────────────

function onShelf(ready: number): string {
  return `${fq(ready)} on the shelf`;
}

function stagingSentence(putAway: number, more: boolean): string {
  const verb = isOne(putAway) ? 'is' : 'are';
  const them = isOne(putAway) ? 'it' : 'them';
  return `${fq(putAway)}${more ? ' more' : ''} ${verb} in Staging and must be put away before picking can take ${them}.`;
}

function shareSentence(share: ReadinessPoShare, tz?: string): string {
  if (share.kind === 'hidden') {
    return `${fq(share.units)} ${isOne(share.units) ? 'is' : 'are'} on a PO you can't open.`;
  }
  if (share.kind === 'unlisted') {
    return `${fq(share.units)} ${isOne(share.units) ? 'is' : 'are'} on a PO not listed here, so no expected date is shown.`;
  }
  const po = share.poNumber ?? 'A PO';
  const qty = fq(share.poRemaining ?? share.units);
  if (share.expectedAt) {
    return `${po} expects ${qty} on ${day(share.expectedAt, tz)} ${READINESS_EXPECTED_DATE_CAVEAT}.`;
  }
  return `${po} has ${qty} on order, with no expected date on the PO.`;
}

function poSentences(shares: readonly ReadinessPoShare[], tz?: string): string {
  if (shares.length === 0) return '';
  const first = shareSentence(shares[0]!, tz);
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

function draftSentence(item: ReadinessItemAssessment | null, shortUnits: number): string | null {
  const drafts = item?.facts?.drafts;
  if (!drafts) return null;
  const covers = Math.min(shortUnits, item?.quantities?.draftRemaining ?? 0);
  if (covers <= 0) return null;
  const first = drafts.rows[0];
  return first
    ? `Draft ${first.poNumber} covers ${fq(covers)} but has not been ordered.`
    : `A draft PO covers ${fq(covers)} but has not been ordered.`;
}

/**
 * One sentence (or two) for a line, by its state. `item` is the line's item
 * assessment (for drafts and the on-record numbers).
 */
export function describeReadinessLine(
  line: ReadinessLineAssessment,
  item: ReadinessItemAssessment | null,
  opts: ReadinessCopyOptions = {},
): string {
  const tz = opts.timeZone;
  if (line.reasons.includes('not_visible') || !line.units) return READINESS_NOT_VISIBLE_COPY;
  const u = line.units;
  if (line.notes.includes('nothing_owed')) {
    return 'Nothing left to pick: all of this line was handed over.';
  }
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
  if (u.awaiting > 0) {
    // "N short now", then where the awaited units come from; any rest is
    // short with nothing on order.
    parts.push(`${fq(u.awaiting + u.short)} short now.`);
    parts.push(poSentences(line.poShares, tz));
    if (u.short > 0) parts.push(`${fq(u.short)} of them ${isOne(u.short) ? 'is' : 'are'} not on order.`);
  } else if (u.short > 0) {
    parts.push(`${fq(u.short)} short.`);
  }
  if (u.short > 0) {
    const draft = draftSentence(item, u.short);
    if (draft) parts.push(draft);
    else if (u.awaiting <= 0 && item?.facts?.inbound) parts.push('Nothing is on order.');
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
  if (!u) detail = "stock can't be checked";
  else if (line.notes.includes('nothing_owed')) detail = 'nothing left to pick';
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
  opts: ReadinessCopyOptions = {},
): { parts: string[]; text: string } {
  const tz = opts.timeZone;
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
          ? `On order ${row.poNumber}: ${fq(row.remaining)} expected ${day(row.expectedAt, tz)} ${READINESS_EXPECTED_DATE_CAVEAT}`
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
    parts.push(
      f.drafts.rows[0]
        ? `On draft ${f.drafts.rows[0].poNumber} ${fq(q.draftRemaining)} (not ordered)`
        : `On draft POs ${fq(q.draftRemaining)} (not ordered)`,
    );
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
      };
    }
    return {
      headline: `${lines(counts.short_picked)} not fully picked`,
      tone: PICKED_LINE_STATES.short_picked.tone,
      icon: PICKED_LINE_STATES.short_picked.icon,
      details: [`${counts.picked_complete} of ${lineCount} ${lineCount === 1 ? 'line' : 'lines'} picked`],
      neededBy,
      checkedAt,
    };
  }
  const { counts, lineCount } = a.rollup;
  if (a.rollup.ready) {
    return {
      headline: `Ready to pick (${lineCount} of ${lineCount} ${lineCount === 1 ? 'line' : 'lines'})`,
      tone: READINESS_STATES.ready.tone,
      icon: READINESS_STATES.ready.icon,
      details: [],
      neededBy,
      checkedAt,
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
  if (!first) {
    // No lines at all: nothing is ready, and nothing is claimed.
    return {
      headline: 'This order has no lines to check.',
      tone: READINESS_STATES.unknown.tone,
      icon: READINESS_STATES.unknown.icon,
      details: [],
      neededBy,
      checkedAt,
    };
  }
  const details = parts.slice(1).map((p) => p.text);
  details.push(`${counts.ready} of ${lineCount} ${lineCount === 1 ? 'line' : 'lines'} ready to pick`);
  return {
    headline: first.text,
    tone: READINESS_STATES[first.state].tone,
    icon: READINESS_STATES[first.state].icon,
    details,
    neededBy,
    checkedAt,
  };
}

// ── Requester ───────────────────────────────────────────────────────────────

export const REQUESTER_ALL_IN_STOCK_COPY = 'All items are in stock.';
export const REQUESTER_WAITING_COPY = 'Some items are waiting on stock.';
export const REQUESTER_CHECKING_COPY = "We're checking stock for some items.";

/**
 * The one sentence a requester (without the full panel) sees. Null outside
 * the to_pick phase. No numbers, no PO references, no other orders.
 */
export function readinessSummaryForRequester(result: OrderReadinessResult): string | null {
  if (result.state === 'failed') return REQUESTER_CHECKING_COPY;
  const a = result.assessment;
  if (a.phase !== 'to_pick') return null;
  if (a.rollup.capped || a.lines.length === 0) return REQUESTER_CHECKING_COPY;
  const { counts } = a.rollup;
  if (counts.short > 0 || counts.awaiting_po > 0) return REQUESTER_WAITING_COPY;
  if (counts.unknown > 0) return REQUESTER_CHECKING_COPY;
  return REQUESTER_ALL_IN_STOCK_COPY;
}

// ── Completion confirm ──────────────────────────────────────────────────────

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
  if (projection.shortLines.length > 0) {
    const listed = projection.shortLines
      .map((l) => `${l.itemName ?? 'An item'}: ${fq(l.batch ?? 0)} of ${fq(l.owed)}`)
      .join('; ');
    const one = projection.shortLines.length === 1;
    out.push(
      `Not everything will be picked. ${listed}. ${one ? 'It' : 'They'} will be owed at hand-over, or you can remove ${one ? 'it' : 'them'} from the order first.`,
    );
  }
  for (const f of projection.failingItems) {
    out.push(
      f.reason === 'insufficient_placed_stock'
        ? `Picking can't finish until ${fq(f.needPutAway)} of ${f.itemName} in Staging ${isOne(f.needPutAway) ? 'is' : 'are'} put away.`
        : `Picking can't finish: ${f.itemName} has less on record than this pick needs.`,
    );
  }
  if (projection.unknownItemIds.length > 0) {
    const n = projection.unknownItemIds.length;
    out.push(`Stock couldn't be checked for ${n} ${n === 1 ? 'item' : 'items'}. Picking may come up short.`);
  }
  return out.length > 0 ? out : null;
}
