import type { Role } from '../constants/roles';
import { isManagerOrAbove } from '../constants/terminology';

/**
 * WHO MAY POST A RECEIPT, RECORD A RECEIVING CHECKLIST AND PUBLISH ONE (F4-1).
 *
 * ledger.post_receipt_v2 refuses anyone below manager, but the web PO page and
 * the phone's PO screen offered Receive and Post receipt to everyone who could
 * open the purchase order: staff and viewers tapped it and were refused. One
 * predicate, used by the web page, ReceivingService.postReceipt, the checklist
 * service and the phone (pattern #26, F1-2's cycleCountCloseGate shape):
 *   - post a receipt: manager or above, and stock:adjust (the ledger's floor
 *     plus the permission the service asserts);
 *   - record a checklist: posting, plus purchase_orders:read and the
 *     receiving module (_checklist_assert_recorder);
 *   - publish or turn off a checklist: manager or above with
 *     purchase_orders:manage and the receiving module
 *     (_checklist_assert_publisher);
 *   - add a PO file: purchase_orders:manage, the gate PoAttachmentsService.add
 *     and both PO screens use (the RLS insert policy is looser but is not the
 *     path; the 2026-09-30 refresh, b5).
 */
export interface ReceivingGateInput {
  role: Role;
  /** has stock:adjust (effective permissions). */
  canAdjust: boolean;
  /** has purchase_orders:read. */
  canReadPo: boolean;
  /** has purchase_orders:manage. */
  canManagePo: boolean;
  /** the receiving module is on for the organization. */
  receivingOn: boolean;
}

export interface ReceivingGate {
  canPostReceipt: boolean;
  canRecordChecklist: boolean;
  canPublishChecklist: boolean;
  canAddPoFile: boolean;
}

export function receivingGate(input: ReceivingGateInput): ReceivingGate {
  const manager = isManagerOrAbove(input.role);
  const canPostReceipt = manager && input.canAdjust;
  return {
    canPostReceipt,
    canRecordChecklist: canPostReceipt && input.canReadPo && input.receivingOn,
    canPublishChecklist: manager && input.canManagePo && input.receivingOn,
    canAddPoFile: input.canManagePo,
  };
}

/** Shown in place of Receive and Post receipt to someone who cannot post. */
export const RECEIVE_MANAGER_POSTS_COPY = 'A manager posts receipts.';

/** The service's refusal when someone below manager tries to post. */
export const RECEIVE_POST_MANAGER_ONLY_COPY =
  'Only a manager can post a receipt. A manager posts receipts.';

/** The phone footer before it knows who may post. It never guesses. */
export const RECEIVE_GATE_CHECKING_COPY = 'Checking who can post receipts…';

/** The phone footer when the check failed: it offers to check again. */
export const RECEIVE_GATE_UNKNOWN_COPY = 'Could not check who can post receipts.';

/**
 * The phone footer offline with nothing known: posting needs a connection.
 * Only that: a manager opening the app offline sees it too, so it never says
 * who posts (desk check F10).
 */
export const RECEIVE_GATE_OFFLINE_COPY = 'Posting needs a connection.';
