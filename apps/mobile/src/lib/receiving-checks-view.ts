import {
  liveChecklistVersion,
  receiptChecklistAction,
  receiptChecklistActionLabel,
  receiptChecklistChipText,
  receiptChecklistChipTone,
  receiptChecklistState,
  RECEIVING_CHECKLIST_COPY,
  type ReceivingGate,
} from '@stockpilot/core';

import {
  checklistErrorReason,
  type PhoneChecklistEditor,
  type PhonePoChecks,
} from './receiving-checks-api';

/**
 * WHAT THE PHONE SHOWS FOR THE RECEIVING CHECKLIST (F4-1), as pure helpers the
 * node tests run: the chip and action on each Receipt history card, whether
 * the "Posted" alert offers Record checklist, and the words when a start
 * fails after a post. Every state comes from core (receiptChecklistState and
 * receiptChecklistAction), the same rules the web PO page uses.
 */

const C = RECEIVING_CHECKLIST_COPY;

/** The PO screen's checklist read: still loading, or the route's answer. */
export type PoChecksState = { kind: 'loading' } | { kind: 'ready'; checks: PhonePoChecks };

export interface ReceiptChip {
  /**
   * The chip's words; never colour alone. Null for an action-only row: a
   * receipt from a gap after the first checklist, never nagged but offered
   * Record once a checklist is on (core receiptChecklistAction, desk check F4).
   */
  text: string | null;
  tone: 'ok' | 'warn' | 'muted' | null;
  /** What tapping offers, with its label; null = the chip is only words. */
  action: 'record' | 'continue' | 'view' | null;
  actionLabel: string | null;
  /** The run to open for continue and view. */
  runId: string | null;
}

/**
 * One Receipt history card's chip and action. Null while the read is in
 * flight, when it failed (the history says so once, above the cards:
 * historyChecksFailed), and for a receipt with nothing to show or offer (a
 * reversal entry, or one received before the organization's first checklist:
 * it had none to follow). A receipt from a gap after the first checklist has
 * no chip but is offered Record while one is on, as on the web.
 */
export function receiptChip(input: {
  receipt: { id: string; status: string; receivedAt: string | null };
  checks: PoChecksState;
  canRecord: boolean;
}): ReceiptChip | null {
  if (input.checks.kind !== 'ready' || !input.checks.checks.ok) return null;
  const { versions, runs } = input.checks.checks;
  const state = receiptChecklistState({
    receipt: {
      id: input.receipt.id,
      status: input.receipt.status,
      receivedAt: input.receipt.receivedAt ?? '',
    },
    versions,
    runs,
  });
  const text = receiptChecklistChipText(state);
  const tone = text === null ? null : receiptChecklistChipTone(state);
  const action = receiptChecklistAction({
    state,
    receipt: { status: input.receipt.status, receivedAt: input.receipt.receivedAt },
    versions,
    canRecord: input.canRecord,
  });
  if (text === null && action === null) return null;
  return {
    text,
    tone,
    action,
    actionLabel: action ? receiptChecklistActionLabel(action) : null,
    runId: state.kind === 'completed' || state.kind === 'in_progress' ? state.runId : null,
  };
}

/**
 * "Checklist status didn't load", said once in Receipt history, and only when
 * there are receipts to label (a draft or a PO with none says nothing).
 */
export function historyChecksFailed(checks: PoChecksState, receiptCount: number): boolean {
  return receiptCount > 0 && checks.kind === 'ready' && !checks.checks.ok;
}

export interface PostedAlertPlan {
  title: string;
  body: string;
  /** Offer Record checklist (with Done) instead of the plain OK. */
  offerRecord: boolean;
}

/**
 * The "Posted" alert. Record checklist is offered only on a known live
 * version and a known yes to recording; when either is unknown (the read
 * failed, the gate is unknown) the alert is the plain one it always was, and
 * the receipt's card offers the checklist later.
 */
export function postedAlertPlan(input: {
  lineCount: number;
  /** From the post's answer; without an id there is nothing to start. */
  receiptId: string | null;
  receiptNumber: string | null;
  gate: ReceivingGate | null;
  checks: PoChecksState;
}): PostedAlertPlan {
  const live =
    input.checks.kind === 'ready' &&
    input.checks.checks.ok &&
    liveChecklistVersion(input.checks.checks.versions) !== null;
  const received = `Received ${input.lineCount} line${input.lineCount === 1 ? '' : 's'}.`;
  const offerRecord = live && input.gate?.canRecordChecklist === true && input.receiptId !== null;
  if (!offerRecord) return { title: 'Posted', body: received, offerRecord: false };
  return {
    title: input.receiptNumber ? C.postedTitle(input.receiptNumber) : 'Posted',
    body: `${received} ${C.postedBody}`,
    offerRecord: true,
  };
}

/** The alert when the receipt posted but its checklist could not be started. */
export function startAfterPostFailureBody(e: unknown): string {
  return checklistErrorReason(e) === 'no_checklist'
    ? `${C.noChecklist} ${C.startFailedAfterPostPhone}`
    : C.startFailedAfterPostPhone;
}

/** Pass, Fail and Not applicable, in that order, with their words. */
export const CHECK_ANSWER_OPTIONS: readonly { value: 'pass' | 'fail' | 'na'; label: string }[] = [
  { value: 'pass', label: C.pass },
  { value: 'fail', label: C.fail },
  { value: 'na', label: C.notApplicable },
];

/** The run screen's native path for a run id (the web path rewrites to it). */
export function receivingCheckPath(runId: string): string {
  return `/receiving-check/${runId}`;
}

/**
 * The editor screen's read, and the generation its Editor is mounted under
 * (desk check F5). The generation moves only after a publish or a turn off,
 * which start the editor over from what the server holds. Reload after a
 * conflict, and the first read, keep it: the staged title and steps stay (as
 * on the web) with the new live version, history and next number under them.
 */
export type ChecklistEditorScreen =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; editor: PhoneChecklistEditor; generation: number };

/** A read landed; `saved` after a publish or a turn off. */
export function editorScreenLoaded(
  prev: ChecklistEditorScreen,
  editor: PhoneChecklistEditor,
  saved: boolean,
): ChecklistEditorScreen {
  const generation = prev.kind === 'ready' ? prev.generation + (saved ? 1 : 0) : 0;
  return { kind: 'ready', editor, generation };
}

/** A read failed: what is on screen stays; with nothing on screen, why. */
export function editorScreenFailed(
  prev: ChecklistEditorScreen,
  message: string,
): ChecklistEditorScreen {
  return prev.kind === 'ready' ? prev : { kind: 'failed', message };
}
