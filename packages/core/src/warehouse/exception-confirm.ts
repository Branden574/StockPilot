import { formatCycleCountNumber } from '../cycle-counts/cycle-count-number';
import { formatStockQuantity } from '../inventory/stock-writeoff';

import {
  RECOUNT_COUNTS_TOTAL_COPY,
  recountUnavailableCopy,
  type RecountOutcome,
  type RecountUnavailableReason,
} from './exception-recount';
import {
  countVarianceNumbers,
  EXCEPTION_SYNC_INTERVAL_MINUTES,
  roundQuantity,
  signedQuantity,
  type CountConfirmedAs,
  type OccurrenceState,
} from './exceptions';
import { countedAndPostedByCopy, type VerificationPerson } from './verification';

/**
 * COUNT DIFFERENCES: WHAT CLEARS THEM, AND CONFIRMING THE COUNTED NUMBER
 * (owner decision 2026-09-29, "1 and 2", after EX-000059).
 *
 * A count_variance exception ("Count did not match the stock on record") is
 * raised when a posted count found a different number than was on record.
 * Posting already applied the difference. The owner acknowledged EX-000059
 * expecting it to close; it did not, because only a later matching count
 * clears one. So:
 *
 *   1. the page and the Acknowledge step say plainly what clears it, and that
 *      acknowledging does not (countVarianceClearCopy,
 *      countVarianceAcknowledgeHelp);
 *   2. the person who counted it, or a manager, can confirm the counted
 *      number, which closes it at once without a second count (the owner
 *      accepted that a mistyped count can then close).
 *
 * Confirming ships in two steps. The words and the phone's Confirm screens
 * ship first, dormant: they show Confirm only once the server sends a
 * `countConfirm` block with the exception (CountConfirmBlock). With no block
 * ("feature off"), every surface says what clears it without naming Confirm.
 * The phone keeps this module after the server turns Confirm on, so every
 * word here must be true both before and after.
 *
 * Everything the web page and the phone both say lives here, so the two never
 * word the same exception differently. One gate (countConfirmGate) decides
 * who is offered Confirm; the database function exception_confirm_count
 * restates it, and exception-confirm.fixture.ts holds the two equal.
 */

// ═══════════════════════════════════════════════════════════════════════════
// The state, independent of the reader
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Whether the count on the page can be confirmed right now, whoever reads it.
 * In the order it is checked (the database function's checks 9 to 14):
 *   recount_in_progress - a recount linked to this exception is in progress
 *                         and its line can re-check the item: its result
 *                         settles this;
 *   count_in_progress   - another count in progress has recorded a different
 *                         number for the item (a line that can re-check it);
 *                         posting it would reopen a confirmed row;
 *   rechecking          - the linked recount was posted and the next check
 *                         has not applied it yet;
 *   unavailable         - something needed could not be read (app only);
 *   count_changed       - the item's latest count is no longer this one, or
 *                         its number changed;
 *   not_countable       - the item can no longer be counted (it closes at the
 *                         next check);
 *   stock_moved         - the stock on record no longer equals the counted
 *                         number (owner default: confirm only while it does;
 *                         a move that nets to zero still counts as equal);
 *   already_confirmed   - this count was already confirmed on another
 *                         exception of the item;
 *   confirmable         - none of the above.
 */
export type CountConfirmState =
  | 'recount_in_progress'
  | 'count_in_progress'
  | 'rechecking'
  | 'unavailable'
  | 'count_changed'
  | 'not_countable'
  | 'stock_moved'
  | 'already_confirmed'
  | 'confirmable';

/** Every state, in the order countConfirmState checks them. */
export const COUNT_CONFIRM_STATES: readonly CountConfirmState[] = [
  'recount_in_progress',
  'count_in_progress',
  'rechecking',
  'unavailable',
  'count_changed',
  'not_countable',
  'stock_moved',
  'already_confirmed',
  'confirmable',
];

export function isCountConfirmState(value: unknown): value is CountConfirmState {
  return typeof value === 'string' && (COUNT_CONFIRM_STATES as readonly string[]).includes(value);
}

/** A counted line in a count that is still in progress, for the item. */
export interface CountConfirmOpenLine {
  cycleCountId: string;
  countNumber: number | null;
  counted: number | null;
  expected: number | null;
  /** cycle_count_line_rechecks: whether posting it would re-check the item.
   *  Null when unknown, which is treated as yes (caution). */
  rechecks: boolean | null;
}

export interface CountConfirmStateInput {
  /** The exception's facts: the count it names and the counted number. */
  facts: unknown;
  /** The displayed state (core occurrenceState); `rechecking` is step 3. */
  displayed: Pick<OccurrenceState, 'kind'>;
  /** The recount linked to this exception, with whether its line for the
   *  item can re-check it (null: unknown, treated as yes). */
  linkedRecount: { cycleCountId: string; status: string; lineRechecks: boolean | null } | null;
  /** Counted lines for the item in counts that are in progress; null when
   *  they could not be read. */
  openLines: readonly CountConfirmOpenLine[] | null;
  /** The item's latest physical count as of now; null when it could not be
   *  read. */
  latest: { cycleCountId: string; counted: number | null; countable: boolean } | null;
  /** inventory_items.quantity_on_hand now; null when it could not be read. */
  onRecordNow: number | null;
  /** Whether another occurrence of the item already confirms this count;
   *  null when it could not be read. */
  alreadyConfirmed: boolean | null;
}

function sameQuantity(a: number, b: number): boolean {
  return roundQuantity(a) === roundQuantity(b);
}

/**
 * The open count that blocks a confirm (count_in_progress), or null: a
 * counted line, other than the linked recount's, that can re-check the item
 * and differs from its own expected quantity (a null expected counts as
 * different). An uncounted line does not block (a warehouse-wide count must
 * not freeze every Confirm for its length), and neither does one that matches
 * (posting it changes nothing and opens nothing).
 */
export function blockingOpenCount(
  input: Pick<CountConfirmStateInput, 'openLines' | 'linkedRecount'>,
): CountConfirmOpenLine | null {
  for (const l of input.openLines ?? []) {
    if (input.linkedRecount && l.cycleCountId === input.linkedRecount.cycleCountId) continue;
    if (l.counted === null || l.rechecks === false) continue;
    if (l.expected === null || !sameQuantity(l.counted, l.expected)) return l;
  }
  return null;
}

/** The state, from what the server read (see CountConfirmState). */
export function countConfirmState(input: CountConfirmStateInput): CountConfirmState {
  const rc = input.linkedRecount;
  if (rc && rc.status === 'in_progress' && rc.lineRechecks !== false) return 'recount_in_progress';
  if (blockingOpenCount(input)) return 'count_in_progress';
  if (input.displayed.kind === 'rechecking') return 'rechecking';
  const n = countVarianceNumbers(input.facts);
  if (
    input.latest === null ||
    input.openLines === null ||
    input.onRecordNow === null ||
    input.alreadyConfirmed === null ||
    n.cycleCountId === null ||
    n.counted === null
  ) {
    return 'unavailable';
  }
  const latest = input.latest;
  if (latest.cycleCountId !== n.cycleCountId || latest.counted === null || !sameQuantity(latest.counted, n.counted)) {
    return 'count_changed';
  }
  if (!latest.countable) return 'not_countable';
  if (!sameQuantity(input.onRecordNow, n.counted)) return 'stock_moved';
  if (input.alreadyConfirmed) return 'already_confirmed';
  return 'confirmable';
}

// ═══════════════════════════════════════════════════════════════════════════
// The gate: the state, then the reader
// ═══════════════════════════════════════════════════════════════════════════

/** Why Confirm is withheld from this reader: the act gate (not_permitted),
 *  the state, or not the counter and not a manager (not_counter). */
export type CountConfirmReason = 'not_permitted' | 'not_counter' | Exclude<CountConfirmState, 'confirmable'>;

export const COUNT_CONFIRM_REASONS: readonly CountConfirmReason[] = [
  'not_permitted',
  'not_counter',
  ...COUNT_CONFIRM_STATES.filter((s): s is Exclude<CountConfirmState, 'confirmable'> => s !== 'confirmable'),
];

export function isCountConfirmReason(value: unknown): value is CountConfirmReason {
  return typeof value === 'string' && (COUNT_CONFIRM_REASONS as readonly string[]).includes(value);
}

export interface CountConfirmGateInput {
  state: CountConfirmState;
  /** The act gate (stock:adjust and write access to the item's LIVE
   *  warehouse, or a manager when it has none). */
  canAct: boolean;
  /** Manager, admin or owner. */
  isManager: boolean;
  readerId: string | null;
  /** The counted line's counted_by (the last recorder); null when unknown. */
  countedBy: string | null;
}

export interface CountConfirmGate {
  state: CountConfirmState;
  canConfirm: boolean;
  reason: CountConfirmReason | null;
  /** How a confirm by this reader is recorded: the counter (a manager who
   *  counted the line is the counter), else a manager. */
  as: CountConfirmedAs;
}

/**
 * THE one predicate for offering Confirm this count: the web page, the phone
 * (through the server's block) and the service hint all use it, and the
 * database function restates it in the same order (the act gate, then the
 * state, then counter or manager; exception-confirm.fixture.ts).
 *
 * The act gate comes first so a viewer never learns more than the page shows.
 * The counter check comes last so someone who did not count reads the real
 * state (for example that the stock on record changed) rather than "only Dana
 * Lee can confirm" on a row nobody can confirm.
 */
export function countConfirmGate(input: CountConfirmGateInput): CountConfirmGate {
  const isCounter = input.countedBy !== null && input.readerId !== null && input.countedBy === input.readerId;
  const as: CountConfirmedAs = isCounter ? 'counter' : 'manager';
  let reason: CountConfirmReason | null = null;
  if (!input.canAct) reason = 'not_permitted';
  else if (input.state !== 'confirmable') reason = input.state;
  else if (!isCounter && !input.isManager) reason = 'not_counter';
  return { state: input.state, canConfirm: reason === null, reason, as };
}

// ═══════════════════════════════════════════════════════════════════════════
// What the server sends (the wire shapes the phone parses)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `countConfirm` on an exception's detail: sent only for an OPEN
 * count_variance exception while the server offers confirming. Absent or null
 * means the feature is off, and every surface uses the recount-only words.
 * Every field is a hint for the screens: the database re-checks all of it.
 */
export interface CountConfirmBlock {
  state: CountConfirmState;
  /** countConfirmGate for this reader. */
  canConfirm: boolean;
  /** Why not, when not (countConfirmGate's reason). */
  unavailableReason: CountConfirmReason | null;
  /** The count the confirm names; sent back with the request. */
  cycleCountId: string;
  countNumber: number | null;
  /** The counted number shown; sent back with the request. */
  counted: number;
  /** What was on record when it was counted (facts.expected). */
  onRecordBefore: number | null;
  /** The stock on record now. */
  onRecordNow: number | null;
  countedBy: VerificationPerson | null;
  postedBy: VerificationPerson | null;
  readerIsCounter: boolean;
  /** For count_in_progress: the other count and what it recorded. */
  otherCount: { countNumber: number | null; counted: number } | null;
}

/**
 * `confirmation` on an occurrence resolved by a count confirmation (null
 * otherwise). The stock on record at the confirm is stored but never sent:
 * while confirming requires it to equal the counted number, it says nothing
 * more. History rows carry only `confirmedAs`.
 */
export interface OccurrenceConfirmation {
  at: string;
  by: { id: string | null; label: string } | null;
  cycleCountId: string | null;
  countNumber: number | null;
  quantity: number | null;
  as: CountConfirmedAs | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// The words (section 9 of the plan; one copy for the web and the phone)
// ═══════════════════════════════════════════════════════════════════════════

export const COUNT_VARIANCE_CLEARS_TITLE = 'What clears this';
export const CONFIRM_COUNT_LABEL = 'Confirm this count';
export const CONFIRM_COUNT_INSTEAD_LABEL = 'Confirm this count instead';
export const EXCEPTION_CONFIRM_OFFLINE_COPY = 'You are offline. Confirming a count needs a connection.';
const ACK = 'Acknowledging does not clear this.';
const MODULE_OFF =
  'Cycle Counts is turned off for this organization, so it cannot be recounted until it is turned on again.';
const RECHECKING = `A newer count of this item was posted and is being checked. This updates at the next check, within ${EXCEPTION_SYNC_INTERVAL_MINUTES} minutes.`;
const NOT_COUNTABLE = 'This item can no longer be counted, so this exception closes at the next check.';

type Surface = 'web' | 'phone';

function unavailableCopy(surface: Surface): string {
  return surface === 'phone'
    ? 'Confirming is unavailable right now. Pull down to try again.'
    : 'Confirming is unavailable right now. Reload to try again.';
}

/** Whether this reader can start a recount, or why not. */
export type RecountAbility = 'can' | 'not_permitted' | 'module_disabled';

/** The server's Recount hint as an ability. A reason this build does not know
 *  (or none) reads as the permission rule, as recountUnavailableCopy does. */
export function recountAbilityOf(
  canRecount: boolean,
  reason: RecountUnavailableReason | null | undefined,
): RecountAbility {
  if (canRecount) return 'can';
  return reason === 'module_disabled' ? 'module_disabled' : 'not_permitted';
}

/**
 * The top sentence, in every state: "CC-000035 found 2 where 100 was on
 * record, and posting it changed the stock on record by -98." Always true: the
 * post applies exactly counted minus expected. (The owner's "changed from 100
 * to 2" is exact only when nothing moved between the count and its post.)
 */
export function countVarianceLead(facts: unknown): string {
  const n = countVarianceNumbers(facts);
  const cc = formatCycleCountNumber(n.countNumber);
  if (n.counted === null || n.expected === null || n.variance === null) {
    return `A count did not match the stock on record${cc ? ` (${cc})` : ''}.`;
  }
  return `${cc ?? 'A count'} found ${formatStockQuantity(n.counted)} where ${formatStockQuantity(n.expected)} was on record, and posting it changed the stock on record by ${signedQuantity(n.variance)}.`;
}

/** The recount linked to the exception as the words name it. */
interface RecountRef {
  ref: string | null;
  progress: string | null;
}

function recountRefOf(
  displayed: OccurrenceState,
  recount: { countNumber: number | null; outcome: RecountOutcome } | null,
): RecountRef {
  const fromState =
    displayed.kind === 'recount_in_progress' || displayed.kind === 'rechecking' ? displayed.countNumber : null;
  const ref = formatCycleCountNumber(recount?.countNumber ?? fromState ?? null);
  const o = recount?.outcome;
  const progress =
    o && o.kind === 'in_progress' && o.counted !== null && o.total !== null ? `${o.counted} of ${o.total} counted` : null;
  return { ref, progress };
}

function recountInProgressSentence(r: RecountRef): string {
  return `${r.ref ? `Recount ${r.ref}` : 'A recount'} is in progress${r.progress ? ` (${r.progress})` : ''}. When it is posted, this clears if it matches the stock on record, or shows the new numbers if it does not.`;
}

function recountInProgressReason(r: RecountRef): string {
  return `Confirm this count is not offered while ${r.ref ? `recount ${r.ref}` : 'a recount'} is in progress. Its result will settle this, or a manager can cancel it.`;
}

function notCounterReason(counterLabel: string | null): string {
  return counterLabel
    ? `Only ${counterLabel}, who counted it, or a manager can confirm this count.`
    : 'Only a manager can confirm this count.';
}

/** What the reader can do once Confirm is not offered (stock_moved,
 *  already_confirmed), and whether it says why the reader cannot recount. */
function noConfirmTail(ability: RecountAbility, canAct: boolean): { text: string; explainsRecount: boolean } {
  if (ability === 'can') return { text: 'Count it once more with Recount.', explainsRecount: false };
  if (ability === 'module_disabled') return { text: MODULE_OFF, explainsRecount: true };
  if (canAct) return { text: 'Ask a manager who can assign counts for a recount.', explainsRecount: true };
  return { text: 'It clears when a recount matches the stock on record.', explainsRecount: false };
}

function sentences(...parts: Array<string | null | false>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' ');
}

export interface CountVarianceClearInput {
  /** The exception's facts (its numbers and count number). */
  facts: unknown;
  /** The displayed state (core occurrenceState). */
  displayed: OccurrenceState;
  /** The exception's active recount, with how far it has got. */
  recount: { countNumber: number | null; outcome: RecountOutcome } | null;
  /** The server's canAct: this reader sees Acknowledge. */
  canAct: boolean;
  /** The server's canRecount and, when false, why. */
  canRecount: boolean;
  recountUnavailableReason: RecountUnavailableReason | null;
  /** The server's countConfirm block; null when the feature is off. */
  confirm: Pick<
    CountConfirmBlock,
    'state' | 'canConfirm' | 'unavailableReason' | 'onRecordNow' | 'countedBy' | 'postedBy' | 'otherCount'
  > | null;
  /** The phone's live network state (default online): offline, Confirm stays
   *  on screen, disabled, with the reason. */
  online?: boolean;
  surface?: Surface;
}

export interface CountVarianceClearCopy {
  /** The top sentence (countVarianceLead). */
  lead: string;
  /** What clears it, for this state and reader. */
  options: string;
  /** Why Confirm is withheld, shown under it, only where `options` does not
   *  already say it; null otherwise. */
  reason: string | null;
  /** "Counted by X, posted by Y." (feature on only). */
  who: string | null;
  /** The line under Recount: what a count covers, or why this reader cannot
   *  start one when `options` does not already say so; null otherwise. */
  recountLine: string | null;
  /** Show Confirm this count (the server's canConfirm, on a confirmable row). */
  offerConfirm: boolean;
  /** Why the offered Confirm is disabled (offline), or null. */
  confirmDisabledReason: string | null;
}

/**
 * THE "WHAT CLEARS THIS" CARD at the top of a count_variance exception, on
 * the web page and the phone screen. The words choose by the state first
 * (reader-independent), then the reader, then whether they can recount:
 * no string names Confirm to a reader who cannot confirm, and none promises
 * a recount with Cycle Counts off. With no `confirm` block (feature off) the
 * words never name Confirm at all.
 */
export function countVarianceClearCopy(input: CountVarianceClearInput): CountVarianceClearCopy {
  const surface = input.surface ?? 'web';
  const online = input.online ?? true;
  const n = countVarianceNumbers(input.facts);
  const counted = n.counted === null ? null : formatStockQuantity(n.counted);
  const ability = recountAbilityOf(input.canRecount, input.recountUnavailableReason);
  const ack = input.canAct ? ACK : null;
  const r = recountRefOf(input.displayed, input.recount);
  const c = input.confirm;

  let options: string;
  let reason: string | null = null;
  let explainsRecount = false;
  let offerConfirm = false;

  if (c === null) {
    // Feature off: the recount-only words, by the displayed state.
    if (input.displayed.kind === 'recount_in_progress') {
      options = sentences(recountInProgressSentence(r), ack);
    } else if (input.displayed.kind === 'rechecking') {
      options = sentences(RECHECKING, ack);
    } else {
      const base = 'It clears when a later count of this item matches the stock on record.';
      if (ability === 'can') {
        options = sentences(base, 'To close it, count it once more with Recount.', ack);
      } else if (ability === 'module_disabled') {
        options = sentences(base, MODULE_OFF, ack);
        explainsRecount = true;
      } else if (input.canAct) {
        options = sentences(base, 'To close it, ask a manager who can assign counts for a recount.', ack);
        explainsRecount = true;
      } else {
        options = base;
      }
    }
  } else {
    // Feature on: the state first, then the reader.
    const counterLabel = c.countedBy?.label?.trim() || null;
    // The gate's act check against the item's live warehouse.
    const confirmCanAct = c.unavailableReason !== 'not_permitted';
    const ifRight = counted === null ? 'If the counted number is right' : `If ${counted} is right`;
    switch (c.state) {
      case 'confirmable': {
        if (c.canConfirm) {
          offerConfirm = true;
          const confirmIt = `${ifRight}, confirm it with ${CONFIRM_COUNT_LABEL}.`;
          if (ability === 'can') {
            options = sentences(confirmIt, 'If you are not sure, count it once more with Recount.', ack);
          } else if (ability === 'module_disabled') {
            options = sentences(confirmIt, MODULE_OFF, ack);
            explainsRecount = true;
          } else {
            options = sentences(confirmIt, 'If you are not sure, ask a manager who can assign counts for a recount.', ack);
            explainsRecount = true;
          }
          if (!online) reason = EXCEPTION_CONFIRM_OFFLINE_COPY;
        } else {
          const who = counterLabel ? `${counterLabel}, who counted it, or a manager` : 'a manager';
          const what = counted === null ? 'the counted number is right' : `${counted} is right`;
          const orRecount = ability === 'module_disabled' ? '' : ', or when a recount matches the stock on record';
          options = sentences(`It clears when ${who} confirms that ${what}${orRecount}.`, ack);
          if (c.unavailableReason === 'not_counter') reason = notCounterReason(counterLabel);
        }
        break;
      }
      case 'recount_in_progress':
        options = sentences(recountInProgressSentence(r), ack);
        if (confirmCanAct) reason = recountInProgressReason(r);
        break;
      case 'count_in_progress': {
        const other = c.otherCount;
        const otherRef = formatCycleCountNumber(other?.countNumber ?? null);
        options = sentences(
          other
            ? `${otherRef ?? 'Another count'}, which is in progress, has already recorded ${formatStockQuantity(other.counted)} for this item. When it is posted, this exception shows its numbers.`
            : 'Another count in progress has already recorded a different number for this item. When it is posted, this exception shows its numbers.',
          ack,
        );
        if (confirmCanAct) {
          reason = `Confirm this count is not offered while ${otherRef ?? 'another count'} is in progress with a different number for this item.`;
        }
        break;
      }
      case 'rechecking':
      case 'count_changed':
        options = sentences(RECHECKING, ack);
        break;
      case 'unavailable':
        options = sentences(
          'It clears when the counted number is confirmed or a later count matches the stock on record.',
          ack,
        );
        if (confirmCanAct) reason = unavailableCopy(surface);
        break;
      case 'not_countable':
        options = NOT_COUNTABLE;
        break;
      case 'stock_moved':
      case 'already_confirmed': {
        const tail = noConfirmTail(ability, input.canAct);
        explainsRecount = tail.explainsRecount;
        let head: string;
        if (c.state === 'stock_moved') {
          const now = c.onRecordNow === null ? '' : `, on record now ${formatStockQuantity(c.onRecordNow)}`;
          const nums = counted === null ? '' : ` (counted ${counted}${now})`;
          head = `The stock on record changed after this count${nums}, so confirming it is not offered.`;
        } else {
          const cc = formatCycleCountNumber(n.countNumber);
          head = `${cc ?? 'This count'} was already confirmed on an earlier exception, so it cannot be confirmed again.`;
        }
        options = sentences(head, tail.text, ack);
        break;
      }
    }
  }

  let recountLine: string | null = null;
  if (ability === 'can') recountLine = RECOUNT_COUNTS_TOTAL_COPY;
  else if (!explainsRecount) recountLine = recountUnavailableCopy(input.recountUnavailableReason);

  return {
    lead: countVarianceLead(input.facts),
    options,
    reason,
    who: c ? countedAndPostedByCopy(c.countedBy, c.postedBy) : null,
    recountLine,
    offerConfirm,
    confirmDisabledReason: offerConfirm && !online ? EXCEPTION_CONFIRM_OFFLINE_COPY : null,
  };
}

/**
 * The Acknowledge step's help on a count_variance exception (web section and
 * phone sheet; other rules keep EXCEPTION_ACKNOWLEDGE_HELP): the lead with
 * its numbers, that acknowledging does not clear it, and one way it does.
 * With `confirm.canConfirm` the surface also offers CONFIRM_COUNT_INSTEAD_LABEL.
 */
export function countVarianceAcknowledgeHelp(input: {
  facts: unknown;
  displayed: OccurrenceState;
  recount: { countNumber: number | null; outcome: RecountOutcome } | null;
  canRecount: boolean;
  confirm: Pick<CountConfirmBlock, 'state' | 'canConfirm'> | null;
}): string {
  const n = countVarianceNumbers(input.facts);
  const counted = n.counted === null ? null : formatStockQuantity(n.counted);
  const c = input.confirm;
  let tail: string;
  if (c?.canConfirm && c.state === 'confirmable') {
    tail = `If you have checked that ${counted ?? 'the counted number'} is right, confirm the count instead.`;
  } else if (input.displayed.kind === 'recount_in_progress' || c?.state === 'recount_in_progress') {
    const r = recountRefOf(input.displayed, input.recount);
    tail = `It clears when ${r.ref ? `recount ${r.ref}` : 'the recount'} is posted and matches the stock on record.`;
  } else if (input.canRecount) {
    tail = 'To close it, count it once more with Recount.';
  } else if (c && (c.state === 'confirmable' || c.state === 'unavailable')) {
    // Only where a confirmation can still close it: a row whose state
    // refuses one never promises it.
    tail = 'It clears when the count is confirmed or a later count matches the stock on record.';
  } else {
    tail = 'It clears when a later count matches the stock on record.';
  }
  return sentences(
    countVarianceLead(input.facts),
    'Acknowledging tells others this is being looked at. It does not clear this exception.',
    tail,
  );
}

export interface ConfirmCountDialogCopy {
  /** The web dialog's title. */
  title: string;
  /** The phone sheet's header. */
  sheetTitle: string;
  /** "Counted in CC-000035: 2", "On record before the count: 100", "On record
   *  now: 2"; a line whose number is not known is left out. */
  numbers: string[];
  who: string | null;
  /** The numbers and who as one sentence, for one accessible element. */
  numbersLabel: string;
  consequence: string;
  noteLabel: string;
  notePlaceholder: string;
  noteMax: number;
  cancelLabel: string;
  confirmLabel: string;
  pendingLabel: string;
  /** Said once the confirm succeeded. */
  success: string;
}

/** Longest note a confirmation takes, in characters, after trimming. */
export const CONFIRM_COUNT_NOTE_MAX = 1000;

/** The confirmation step (web dialog, phone sheet). */
export function confirmCountDialogCopy(input: {
  /** "EX-000059", or null. */
  reference: string | null;
  confirm: Pick<CountConfirmBlock, 'countNumber' | 'counted' | 'onRecordBefore' | 'onRecordNow' | 'countedBy' | 'postedBy'>;
}): ConfirmCountDialogCopy {
  const c = input.confirm;
  const cc = formatCycleCountNumber(c.countNumber);
  const counted = formatStockQuantity(c.counted);
  const numbers = [
    cc ? `Counted in ${cc}: ${counted}` : `Counted: ${counted}`,
    ...(c.onRecordBefore === null ? [] : [`On record before the count: ${formatStockQuantity(c.onRecordBefore)}`]),
    ...(c.onRecordNow === null ? [] : [`On record now: ${formatStockQuantity(c.onRecordNow)}`]),
  ];
  const who = countedAndPostedByCopy(c.countedBy, c.postedBy);
  const ex = input.reference?.trim() || null;
  return {
    title: `${CONFIRM_COUNT_LABEL}?`,
    sheetTitle: CONFIRM_COUNT_LABEL,
    numbers,
    who,
    numbersLabel: sentences(`${numbers.join('. ')}.`, who),
    consequence: `Confirming records that ${counted} is right. It closes ${ex ?? 'this exception'} now, without a second count. If a later count does not match the stock on record, a new exception opens.`,
    noteLabel: 'Note (optional)',
    notePlaceholder: 'How you checked, for example counted twice on the floor',
    noteMax: CONFIRM_COUNT_NOTE_MAX,
    cancelLabel: 'Cancel',
    confirmLabel: 'Confirm and close',
    pendingLabel: 'Confirming...',
    success: ex ? `Count confirmed. ${ex} is closed.` : 'Count confirmed. This exception is closed.',
  };
}

/**
 * A refused confirm, by the route's `details.reason` (never by message
 * text). A reason this build does not know reads the generic line, so a
 * reason a later server adds still reads sensibly. 403 without one of these
 * reasons, 429, 5xx and no answer are each surface's existing words.
 */
export function describeConfirmError(
  reason: unknown,
  ctx: {
    surface: Surface;
    recount: RecountAbility;
    /** The linked recount's number, for recount_in_progress. */
    recountNumber?: number | null;
    /** The counter's name, for not_counter. */
    counterLabel?: string | null;
  },
): string {
  const phone = ctx.surface === 'phone';
  const tail = noConfirmTail(ctx.recount, true).text;
  switch (reason) {
    case 'occurrence_resolved':
      return phone
        ? 'This exception has already been resolved. Pull down to refresh.'
        : 'This exception has already been resolved. Refresh to see how.';
    case 'count_changed':
      return phone
        ? 'A newer count of this item was posted. Pull down to refresh and see its numbers before confirming.'
        : 'A newer count of this item was posted. Refresh to see its numbers before confirming.';
    case 'stock_moved':
      return `The stock on record changed after this count, so it can no longer be confirmed. ${tail}`;
    case 'recount_in_progress':
      return recountInProgressReason({ ref: formatCycleCountNumber(ctx.recountNumber ?? null), progress: null });
    case 'count_in_progress':
      return 'Another count in progress has recorded a different number for this item. This exception shows its numbers when that count is posted.';
    case 'already_confirmed':
      return `This count was already confirmed on an earlier exception, so it cannot be confirmed again. ${tail}`;
    case 'not_countable':
      return NOT_COUNTABLE;
    case 'not_counter':
      return notCounterReason(ctx.counterLabel?.trim() || null);
    case 'busy':
      return 'A check is running. Try again in a moment.';
    case 'unavailable':
      return unavailableCopy(ctx.surface);
    default:
      return phone
        ? 'This count could not be confirmed. Pull down to refresh and try again.'
        : 'This count could not be confirmed. Refresh and try again.';
  }
}

/**
 * The facts-card row for an exception resolved by a confirmation: "Count
 * confirmed | Dana Lee, who counted it, Sep 29, 10:41 AM, without a second
 * count". `timeLabel` is the confirm time as the surface prints its times.
 */
export function confirmationFactsRow(
  confirmation: Pick<OccurrenceConfirmation, 'at' | 'by' | 'as'>,
  timeLabel: string,
): { label: string; value: string } {
  const who = confirmation.by?.label?.trim() || 'Former member';
  const role =
    confirmation.as === 'counter' ? ', who counted it' : confirmation.as === 'manager' ? ', who did not count it' : '';
  return { label: 'Count confirmed', value: `${who}${role}, ${timeLabel}, without a second count` };
}
