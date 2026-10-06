/**
 * What the RMA workbench offers, the twin of `availableOrderActions`
 * (returns plan 3.9, graft G3): pure, exhaustive and table-tested, one
 * implementation for the web and the phone. Nothing else branches on an RMA's
 * status to decide a button.
 *
 * BUTTON VISIBILITY IS NEVER AUTHORIZATION (brief 31). Every action here is
 * re-checked by its database function (returns:manage, orders:approve for a
 * replacement, write access to the order's warehouse, the status under the
 * row lock). The viewer booleans are computed by the SERVER (permissions,
 * module, warehouse) and passed in; this module never reads a role.
 *
 * Return only (RX-1):
 *   requested                 Approve ("Approve and receive" with the item
 *                             here)  |  Deny, Cancel
 *   approved                  Receive  |  Change destination, Cancel
 *   received                  Process return  |  Change destination
 *   closed, denied, cancelled (none)
 *
 * With an exchange (RX-2, plan 3.9's table; the exchange status is the view's
 * CASE, 3.10):
 *   requested   any                     Approve | Deny, Cancel
 *   approved    declined                Receive | Change destination, Cancel
 *   approved    waiting_for_return      Receive | Release early, Change replacement,
 *                                                 Cancel replacement, Cancel
 *   approved    unavailable             Receive | Change replacement, Open replacement,
 *                                                 Cancel replacement, Cancel
 *   approved    ready_to_pick           Receive | Get replacement ready, Open replacement,
 *                                                 Cancel replacement
 *   approved    in_progress, ready_for_pickup, out_for_delivery
 *                                       Receive | Open replacement (Hand over when
 *                                                 ready), Cancel replacement
 *   approved    partly_handed_over      Receive | Open replacement, Cancel
 *   approved    handed_over_return_open Receive | Cancel (a reason)
 *   approved    replacement_cancelled   Receive | Issue a new replacement, Close as return
 *                                                 only, Cancel
 *   received    ready_to_pick           Get replacement ready | Process return,
 *                                                 Change replacement, Cancel replacement
 *   received    replacement_cancelled   Process return | Issue a new replacement, Close
 *                                                 as return only
 *   received    unavailable             Process return | Change replacement, Change
 *                                                 destination, Open replacement, Cancel
 *                                                 replacement (review fix P16)
 *   received    anything else           Process return | Change destination, Open
 *                                                 replacement, Cancel replacement (not
 *                                                 handed over)
 *   closed      ready_to_pick           Get replacement ready | Change replacement,
 *                                                 Cancel replacement
 *   closed      unavailable             Open replacement | Change replacement,
 *                                                 Cancel replacement
 *   closed      in_progress, ready_for_pickup, out_for_delivery
 *                                       Open replacement (Hand over when ready) |
 *                                                 Cancel replacement
 *   closed      replacement_cancelled   Issue a new replacement | Close as return only
 *   closed, denied, cancelled: anything else (none)
 *
 * "Close as return only" (desk check F9) declines the lines a replacement
 * cancel left cancelled, for good: the exchange then reads declined and
 * nothing more is offered. It touches no order, so it needs returns:manage
 * only, like declining an exchange at approval; without order approval it
 * becomes the primary action of a closed RMA.
 *
 * Every replacement action needs order approval (viewerCanApproveOrders);
 * without it the exchange is read-only with "Approving the replacement needs
 * order approval permission." and only the return actions stay. Cancelling
 * an RMA whose exchange was approved needs it too (the database asks for
 * orders:approve and a reason). Change replacement needs a replacement that
 * was not picked; Cancel replacement one that was not handed over.
 *
 * A requested exchange is still approved by a viewer without order approval
 * (review fix P1): the database asks for it only to approve or add a
 * replacement, so the review offers that viewer "Decline the exchange, return
 * only" alone (exchange-view.ts exchangeReviewOptions) and the reason says so.
 *
 * Plain literals and pure functions only: importing this module runs nothing.
 */

import type { ExchangeStatus } from './exchange-status';
import type { ReturnStatus } from '../orders/order-returns-view';
import { RETURNS_COPY } from './returns-copy';

export type ReturnAction =
  | 'approve'
  | 'approve_and_receive'
  | 'deny'
  | 'cancel'
  | 'receive'
  | 'change_destination'
  | 'process'
  | 'release_early'
  | 'change_replacement'
  | 'cancel_replacement'
  | 'issue_replacement'
  | 'open_replacement'
  | 'hand_over'
  | 'get_replacement_ready'
  | 'close_as_return_only';

/**
 * What a live replacement is (plan 3.3.5), the SQL `_return_replacement_class`:
 * undrawn (nothing picked out of stock yet, nothing handed over), drawn
 * (picked, not handed over: a cancel restocks the picked batch to Staging),
 * handed_over (completed, or anything handed over at all), or none.
 */
export type ReplacementClass = 'undrawn' | 'drawn' | 'handed_over' | 'none';

const DRAWN_STATUSES: readonly string[] = ['picking_complete', 'packing_slip_generated', 'staged_for_pickup', 'staged_for_delivery', 'in_transit'];
const UNDRAWN_STATUSES: readonly string[] = ['pending_approval', 'approved', 'pick_slip_generated', 'picking_in_progress', 'backordered'];

/**
 * The class of a replacement order from its status and whether anything was
 * handed over. Anything handed over makes it handed_over WHATEVER the status
 * (desk check F2): a backorder, or one resumed into picking again. Neither
 * "Change replacement" nor "Cancel replacement" is offered for it, and the
 * database refuses both (replacement_handed_over), so a new replacement can
 * never send those units a second time.
 */
export function replacementClassOf(status: string | null | undefined, anythingHandedOver = false): ReplacementClass {
  if (!status || status === 'cancelled' || status === 'denied') return 'none';
  if (status === 'completed') return 'handed_over';
  if (anythingHandedOver) return 'handed_over';
  if (DRAWN_STATUSES.includes(status)) return 'drawn';
  if (UNDRAWN_STATUSES.includes(status)) return 'undrawn';
  return 'none';
}

export interface ReturnActionsInput {
  status: ReturnStatus | string;
  /** The view's derived exchange status ('none' for a return). */
  exchangeStatus?: ExchangeStatus;
  /** An exchange row exists. */
  hasExchange?: boolean;
  /** The live replacement's class (server-computed under the same rule as SQL). */
  replacementClass?: ReplacementClass;
  /** An exchange line was approved at some point (a replacement exists or existed). */
  hasApprovedExchange?: boolean;
  /** Server-computed: returns:manage, the module on, and write access to the
   *  original order's warehouse. */
  viewerCanManageReturns: boolean;
  /** Server-computed effective orders:approve (replacement actions). */
  viewerCanApproveOrders?: boolean;
  /** The create dialog's "The item is here" switch (off by default). */
  itemIsHere?: boolean;
}

export interface ReturnActions {
  primary: ReturnAction | null;
  secondary: ReturnAction[];
  /** Why nothing (or less) is offered, for a read-only viewer. */
  readOnlyReason: string | null;
}

const NONE: ReturnActions = { primary: null, secondary: [], readOnlyReason: null };

/** The actions that act on the replacement order: order approval needed. */
export const REPLACEMENT_ACTIONS: readonly ReturnAction[] = [
  'release_early',
  'change_replacement',
  'cancel_replacement',
  'issue_replacement',
  'get_replacement_ready',
];

/** Navigation to the replacement order (its own page decides its buttons). */
const NAVIGATION: readonly ReturnAction[] = ['open_replacement', 'hand_over'];

/** Whether an action acts on the replacement order (order approval needed). */
export function isReplacementAction(action: ReturnAction): boolean {
  return REPLACEMENT_ACTIONS.includes(action);
}

function returnOnly(input: ReturnActionsInput): ReturnActions {
  switch (input.status) {
    case 'requested':
      return {
        primary: input.itemIsHere ? 'approve_and_receive' : 'approve',
        secondary: ['deny', 'cancel'],
        readOnlyReason: null,
      };
    case 'approved':
      return { primary: 'receive', secondary: ['change_destination', 'cancel'], readOnlyReason: null };
    case 'received':
      return { primary: 'process', secondary: ['change_destination'], readOnlyReason: null };
    default:
      return NONE;
  }
}

/** The exchange rows of plan 3.9, before the permission and class filters. */
function exchangeRows(input: ReturnActionsInput, ex: ExchangeStatus): { primary: ReturnAction | null; secondary: ReturnAction[] } {
  const openOrHand = (): ReturnAction =>
    ex === 'ready_for_pickup' || ex === 'out_for_delivery' ? 'hand_over' : 'open_replacement';
  switch (input.status) {
    case 'requested':
      return { primary: input.itemIsHere ? 'approve_and_receive' : 'approve', secondary: ['deny', 'cancel'] };
    case 'approved':
      switch (ex) {
        case 'waiting_for_return':
          return { primary: 'receive', secondary: ['release_early', 'change_replacement', 'cancel_replacement', 'cancel'] };
        case 'unavailable':
          return { primary: 'receive', secondary: ['change_replacement', 'open_replacement', 'cancel_replacement', 'cancel'] };
        case 'ready_to_pick':
          return { primary: 'receive', secondary: ['get_replacement_ready', 'open_replacement', 'cancel_replacement'] };
        case 'in_progress':
        case 'ready_for_pickup':
        case 'out_for_delivery':
          return { primary: 'receive', secondary: [openOrHand(), 'cancel_replacement'] };
        case 'partly_handed_over':
          return { primary: 'receive', secondary: ['open_replacement', 'cancel'] };
        case 'handed_over_return_open':
          return { primary: 'receive', secondary: ['cancel'] };
        case 'replacement_cancelled':
          return { primary: 'receive', secondary: ['issue_replacement', 'close_as_return_only', 'cancel'] };
        default:
          // declined (or a state with no replacement): the return alone.
          return { primary: 'receive', secondary: ['change_destination', 'cancel'] };
      }
    case 'received':
      switch (ex) {
        case 'ready_to_pick':
          return { primary: 'get_replacement_ready', secondary: ['process', 'change_replacement', 'cancel_replacement'] };
        case 'replacement_cancelled':
          return { primary: 'process', secondary: ['issue_replacement', 'close_as_return_only'] };
        case 'declined':
          return { primary: 'process', secondary: ['change_destination'] };
        case 'unavailable':
          // Not in stock: change it here as at approved and closed (the
          // database allows a change at received), instead of a cancel and a
          // re-issue with two reasons.
          return { primary: 'process', secondary: ['change_replacement', 'change_destination', 'open_replacement', 'cancel_replacement'] };
        default:
          return { primary: 'process', secondary: ['change_destination', openOrHand(), 'cancel_replacement'] };
      }
    case 'closed':
      switch (ex) {
        case 'ready_to_pick':
          return { primary: 'get_replacement_ready', secondary: ['change_replacement', 'cancel_replacement'] };
        case 'unavailable':
          return { primary: 'open_replacement', secondary: ['change_replacement', 'cancel_replacement'] };
        case 'in_progress':
        case 'ready_for_pickup':
        case 'out_for_delivery':
          return { primary: openOrHand(), secondary: ['cancel_replacement'] };
        case 'partly_handed_over':
          return { primary: 'open_replacement', secondary: [] };
        case 'replacement_cancelled':
          return { primary: 'issue_replacement', secondary: ['close_as_return_only'] };
        default:
          return { primary: null, secondary: [] };
      }
    default:
      return { primary: null, secondary: [] };
  }
}

export function availableReturnActions(input: ReturnActionsInput): ReturnActions {
  const ex: ExchangeStatus = input.exchangeStatus ?? 'none';
  const hasExchange = input.hasExchange === true || ex !== 'none';
  if (input.status === 'denied' || input.status === 'cancelled') return NONE;
  if (!hasExchange) {
    if (input.status === 'closed') return NONE;
    if (!input.viewerCanManageReturns) {
      return { primary: null, secondary: [], readOnlyReason: RETURNS_COPY.noManagePermission };
    }
    return returnOnly(input);
  }

  const rows = exchangeRows(input, ex);
  if (rows.primary === null && rows.secondary.length === 0) return NONE;
  if (!input.viewerCanManageReturns) {
    return { primary: null, secondary: [], readOnlyReason: RETURNS_COPY.noManagePermission };
  }
  const cls = input.replacementClass;
  const canOrders = input.viewerCanApproveOrders === true;
  let dropped = false;
  const allowed = (a: ReturnAction): boolean => {
    // The class rules (the database refuses the rest with its own words).
    if (cls !== undefined) {
      if (a === 'change_replacement' && cls !== 'undrawn') return false;
      if (a === 'cancel_replacement' && cls !== 'undrawn' && cls !== 'drawn') return false;
      if ((a === 'open_replacement' || a === 'hand_over') && cls === 'none') return false;
    }
    const needsOrders = REPLACEMENT_ACTIONS.includes(a) || (a === 'cancel' && input.hasApprovedExchange === true);
    if (needsOrders && !canOrders) {
      dropped = true;
      return false;
    }
    return true;
  };
  let primary = rows.primary && allowed(rows.primary) ? rows.primary : null;
  const secondary = rows.secondary.filter(allowed);
  if (primary === null && rows.primary !== null) {
    // The primary needed a permission the viewer lacks: the first return
    // action left (never a navigation) takes its place.
    const promoted = secondary.find((a) => !REPLACEMENT_ACTIONS.includes(a) && !NAVIGATION.includes(a));
    if (promoted) {
      primary = promoted;
      secondary.splice(secondary.indexOf(promoted), 1);
    }
  }
  // Review fix P1: at requested such a viewer still approves the return,
  // with the exchange declined (the review offers only that).
  const readOnlyReason =
    input.status === 'requested' && !canOrders
      ? RETURNS_COPY.noOrdersApproveDeclineOnly
      : dropped
        ? RETURNS_COPY.noOrdersApprovePermission
        : null;
  return { primary, secondary, readOnlyReason };
}

/** The button words for an action. */
export const RETURN_ACTION_LABELS: Record<ReturnAction, string> = {
  approve: RETURNS_COPY.approveReturn,
  approve_and_receive: RETURNS_COPY.approveAndReceive,
  deny: RETURNS_COPY.deny,
  cancel: RETURNS_COPY.cancelReturn,
  receive: RETURNS_COPY.receive,
  change_destination: RETURNS_COPY.changeDestination,
  process: RETURNS_COPY.processReturn,
  release_early: RETURNS_COPY.releaseEarly,
  change_replacement: RETURNS_COPY.changeReplacement,
  cancel_replacement: RETURNS_COPY.cancelReplacement,
  issue_replacement: RETURNS_COPY.issueNewReplacement,
  open_replacement: RETURNS_COPY.openReplacement,
  hand_over: RETURNS_COPY.handOver,
  get_replacement_ready: RETURNS_COPY.getReplacementReady,
  close_as_return_only: RETURNS_COPY.closeAsReturnOnly,
};

/** The label in context: an exchange's approval reads "Approve return & exchange". */
export function returnActionLabel(action: ReturnAction, opts: { hasExchange?: boolean } = {}): string {
  if (action === 'approve' && opts.hasExchange) return RETURNS_COPY.approveReturnAndExchange;
  return RETURN_ACTION_LABELS[action];
}

/** The steps endpoint's order (plan 3.3.8): each step one RPC and one transaction. */
export const RETURN_STEPS = ['approve', 'receive', 'process'] as const;
export type ReturnStep = (typeof RETURN_STEPS)[number];

/** The steps an action runs through `/steps`. */
export function stepsForAction(action: ReturnAction): ReturnStep[] | null {
  switch (action) {
    case 'approve':
    case 'approve_and_receive':
      return ['approve'];
    case 'receive':
      return ['receive'];
    case 'process':
      return ['process'];
    default:
      return null;
  }
}
