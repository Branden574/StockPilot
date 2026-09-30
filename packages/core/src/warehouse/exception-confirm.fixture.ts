import type { CountConfirmReason, CountConfirmState } from './exception-confirm';
import type { CountConfirmedAs } from './exceptions';

/**
 * THE GATE AGREEMENT TABLE for confirming a count (pattern #26: one predicate,
 * restated in two places, held equal by a shared table).
 *
 * core countConfirmGate decides whether the web page and the phone offer
 * Confirm this count; the database function exception_confirm_count (0383)
 * decides whether a confirm is accepted. The same reader x state table below
 * is asserted against both: exception-confirm.test.ts checks countConfirmGate
 * cell by cell, and the pgTAP file for 0383 restates these rows as its
 * C-matrix, using GATE_REASON_TO_RPC for the answer each reason becomes. If
 * either side changes, its test fails against this table.
 *
 * Written out cell by cell on purpose: a table computed from the function it
 * checks would agree with any bug in it.
 *
 * The order both sides check: the act gate (stock:adjust and write access to
 * the item's live warehouse, or a manager when it has none), then the state,
 * then counter or manager.
 */

export interface GateReader {
  name: string;
  /** Passes the act gate against the item's live warehouse. */
  canAct: boolean;
  /** Manager, admin or owner. */
  isManager: boolean;
  readerId: string | null;
  /** cycle_count_lines.counted_by of the confirmed line (the last recorder). */
  countedBy: string | null;
}

export const GATE_READERS: readonly GateReader[] = [
  { name: 'counter (staff)', canAct: true, isManager: false, readerId: 'staff-a', countedBy: 'staff-a' },
  { name: 'counter (manager)', canAct: true, isManager: true, readerId: 'mgr', countedBy: 'mgr' },
  { name: 'manager who did not count', canAct: true, isManager: true, readerId: 'mgr', countedBy: 'staff-a' },
  { name: 'staff who did not count', canAct: true, isManager: false, readerId: 'staff-b', countedBy: 'staff-a' },
  { name: 'viewer', canAct: false, isManager: false, readerId: 'viewer', countedBy: 'staff-a' },
  { name: 'manager without stock:adjust', canAct: false, isManager: true, readerId: 'mgr-no-adjust', countedBy: 'staff-a' },
  { name: 'staff, counted_by null', canAct: true, isManager: false, readerId: 'staff-a', countedBy: null },
  { name: 'manager, counted_by null', canAct: true, isManager: true, readerId: 'mgr', countedBy: null },
];

/** What each cell comes to: a refusal reason, or a confirm recorded as the
 *  counter or as a manager. */
export type GateCell = CountConfirmReason | CountConfirmedAs;

export const GATE_EXPECTATIONS: Record<string, Record<CountConfirmState, GateCell>> = {
  'counter (staff)': {
    recount_in_progress: 'recount_in_progress',
    count_in_progress: 'count_in_progress',
    rechecking: 'rechecking',
    unavailable: 'unavailable',
    count_changed: 'count_changed',
    not_countable: 'not_countable',
    stock_moved: 'stock_moved',
    already_confirmed: 'already_confirmed',
    confirmable: 'counter',
  },
  'counter (manager)': {
    recount_in_progress: 'recount_in_progress',
    count_in_progress: 'count_in_progress',
    rechecking: 'rechecking',
    unavailable: 'unavailable',
    count_changed: 'count_changed',
    not_countable: 'not_countable',
    stock_moved: 'stock_moved',
    already_confirmed: 'already_confirmed',
    // A manager who counted the line is recorded as the counter, so
    // "confirmed without anyone else looking" stays countable.
    confirmable: 'counter',
  },
  'manager who did not count': {
    recount_in_progress: 'recount_in_progress',
    count_in_progress: 'count_in_progress',
    rechecking: 'rechecking',
    unavailable: 'unavailable',
    count_changed: 'count_changed',
    not_countable: 'not_countable',
    stock_moved: 'stock_moved',
    already_confirmed: 'already_confirmed',
    confirmable: 'manager',
  },
  'staff who did not count': {
    // The state before the counter check: a row nobody can confirm reads its
    // real state, never "only Dana Lee can confirm".
    recount_in_progress: 'recount_in_progress',
    count_in_progress: 'count_in_progress',
    rechecking: 'rechecking',
    unavailable: 'unavailable',
    count_changed: 'count_changed',
    not_countable: 'not_countable',
    stock_moved: 'stock_moved',
    already_confirmed: 'already_confirmed',
    confirmable: 'not_counter',
  },
  viewer: {
    // The act gate first: a viewer never learns more than the page shows.
    recount_in_progress: 'not_permitted',
    count_in_progress: 'not_permitted',
    rechecking: 'not_permitted',
    unavailable: 'not_permitted',
    count_changed: 'not_permitted',
    not_countable: 'not_permitted',
    stock_moved: 'not_permitted',
    already_confirmed: 'not_permitted',
    confirmable: 'not_permitted',
  },
  'manager without stock:adjust': {
    recount_in_progress: 'not_permitted',
    count_in_progress: 'not_permitted',
    rechecking: 'not_permitted',
    unavailable: 'not_permitted',
    count_changed: 'not_permitted',
    not_countable: 'not_permitted',
    stock_moved: 'not_permitted',
    already_confirmed: 'not_permitted',
    confirmable: 'not_permitted',
  },
  'staff, counted_by null': {
    // A line with no recorder (legacy, or a direct write): only a manager.
    recount_in_progress: 'recount_in_progress',
    count_in_progress: 'count_in_progress',
    rechecking: 'rechecking',
    unavailable: 'unavailable',
    count_changed: 'count_changed',
    not_countable: 'not_countable',
    stock_moved: 'stock_moved',
    already_confirmed: 'already_confirmed',
    confirmable: 'not_counter',
  },
  'manager, counted_by null': {
    recount_in_progress: 'recount_in_progress',
    count_in_progress: 'count_in_progress',
    rechecking: 'rechecking',
    unavailable: 'unavailable',
    count_changed: 'count_changed',
    not_countable: 'not_countable',
    stock_moved: 'stock_moved',
    already_confirmed: 'already_confirmed',
    confirmable: 'manager',
  },
};

/** The answer exception_confirm_count gives for each gate reason (SQLSTATE
 *  and hint), 'ok' for a confirm it accepts. `rechecking` and `count_changed`
 *  are one refusal in the database; `unavailable` (a read the app could not
 *  make) exists only in the app. */
export const GATE_REASON_TO_RPC: Record<CountConfirmReason | 'ok', { sqlstate: string; hint: string } | 'app_only'> = {
  not_permitted: { sqlstate: '42501', hint: 'not_permitted' },
  not_counter: { sqlstate: '42501', hint: 'not_counter' },
  recount_in_progress: { sqlstate: 'P0001', hint: 'recount_in_progress' },
  count_in_progress: { sqlstate: 'P0001', hint: 'count_in_progress' },
  rechecking: { sqlstate: 'P0001', hint: 'count_changed' },
  count_changed: { sqlstate: 'P0001', hint: 'count_changed' },
  unavailable: 'app_only',
  not_countable: { sqlstate: 'P0001', hint: 'not_countable' },
  stock_moved: { sqlstate: 'P0001', hint: 'stock_moved' },
  already_confirmed: { sqlstate: 'P0001', hint: 'already_confirmed' },
  ok: { sqlstate: '00000', hint: 'ok' },
};
