/**
 * What the RMA workbench offers, the twin of `availableOrderActions`
 * (returns plan 3.9, graft G3): pure, exhaustive and table-tested, one
 * implementation for the web and the phone. Nothing else branches on an RMA's
 * status to decide a button.
 *
 * BUTTON VISIBILITY IS NEVER AUTHORIZATION (brief 31). Every action here is
 * re-checked by its database function (returns:manage, write access to the
 * order's warehouse, the status under the row lock). The viewer booleans are
 * computed by the SERVER (permissions, module, warehouse) and passed in; this
 * module never reads a role.
 *
 * RX-1 carries the return-only rows. An RMA with an exchange (which only
 * RX-2's functions can create) is read-only here until RX-2 adds its rows,
 * so the screen can never offer a return-only action on an exchange.
 *
 *   requested                 Approve ("Approve and receive" with the item
 *                             here)  |  Deny, Cancel
 *   approved                  Receive  |  Change destination, Cancel
 *   received                  Process return  |  Change destination
 *   closed, denied, cancelled (none)
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
  | 'process';

export interface ReturnActionsInput {
  status: ReturnStatus | string;
  /** Derived exchange status (RX-2); RX-1 always 'none'. */
  exchangeStatus?: ExchangeStatus;
  /** An exchange row exists (RX-2). */
  hasExchange?: boolean;
  /** Server-computed: returns:manage, the module on, and write access to the
   *  original order's warehouse. */
  viewerCanManageReturns: boolean;
  /** Server-computed effective orders:approve (replacement actions, RX-2). */
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

export function availableReturnActions(input: ReturnActionsInput): ReturnActions {
  const terminal = input.status === 'closed' || input.status === 'denied' || input.status === 'cancelled';
  if (terminal) return NONE;
  if (!input.viewerCanManageReturns) {
    return { primary: null, secondary: [], readOnlyReason: RETURNS_COPY.noManagePermission };
  }
  if (input.hasExchange || (input.exchangeStatus !== undefined && input.exchangeStatus !== 'none')) {
    // The exchange rows arrive with RX-2.
    return { primary: null, secondary: [], readOnlyReason: null };
  }
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

/** The button words for an action. */
export const RETURN_ACTION_LABELS: Record<ReturnAction, string> = {
  approve: RETURNS_COPY.approveReturn,
  approve_and_receive: RETURNS_COPY.approveAndReceive,
  deny: RETURNS_COPY.deny,
  cancel: RETURNS_COPY.cancelReturn,
  receive: RETURNS_COPY.receive,
  change_destination: RETURNS_COPY.changeDestination,
  process: RETURNS_COPY.processReturn,
};

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
