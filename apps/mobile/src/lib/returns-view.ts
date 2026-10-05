/**
 * Pure helpers for the phone's returns screens (returns RX-1): the list row
 * words, the workbench's actions under the live connection state, the
 * destination choices and the bodies the steps route takes. Free of React
 * and react-native so vitest covers every decision the .tsx screens make
 * (app/(drawer)/returns.tsx, app/returns/[id].tsx and the action sheet).
 *
 * The rules themselves live in core: availableReturnActions (what may be
 * offered), restock-view (destination rows, preselection, decisions),
 * returns-copy (every word). This module only joins them to the screen.
 */

import {
  alreadyClosedSentence,
  alreadyReceivedSentence,
  availableReturnActions,
  choiceNeededSentence,
  choiceToDecision,
  formatOrderNumber,
  isChoiceOffered,
  liveChoice,
  preselectedChoice,
  processLabelFor,
  READINESS_NEEDS_CONNECTION_COPY,
  RETURN_ACTION_LABELS,
  RETURN_WAITING_PROMPT_DAYS,
  RETURNS_COPY,
  returnLineLabel,
  returnStatusLabel,
  sameChoice,
  unreadDestinationChoice,
  whenProcessedSentence,
  type RestockChoice,
  type ReturnAction,
  type ReturnActions,
  type ReturnLineDecision,
} from '@stockpilot/core';

import type {
  MobileReturnListRow,
  MobileReturnStepResult,
  MobileReturnWorkbench,
  MobileReturnWorkbenchLine,
} from './returns-api';

// ── List ───────────────────────────────────────────────────────────────────

export function returnRowTitle(row: Pick<MobileReturnListRow, 'returnNumber' | 'id'>): string {
  return row.returnNumber ?? row.id.slice(0, 8).toUpperCase();
}

/** "SO-000103 · Pat Lee" (the order handle falls back to the id prefix). */
export function returnRowMeta(row: MobileReturnListRow): string {
  const so = formatOrderNumber(row.orderNumber) ?? row.orderRequestId.slice(0, 8).toUpperCase();
  const who = row.requesterName ?? row.requesterEmail ?? (row.source === 'requester' ? 'Requester' : 'Staff');
  return `${so} · ${who}`;
}

/** "Walk Shirt · Size M ×1, Cap ×2 +1". */
export function returnRowItems(row: MobileReturnListRow): string {
  const parts = row.items.map((it) => `${it.name ?? 'Item'}${it.variant ? ` · ${it.variant}` : ''} ×${it.quantity}`);
  return `${parts.join(', ')}${row.moreItems > 0 ? ` ${RETURNS_COPY.moreItems(row.moreItems)}` : ''}`;
}

/** "waiting 9 days" for an approved RMA, with whether it passed the prompt. */
export function returnRowWaiting(row: MobileReturnListRow): { label: string; overdue: boolean } | null {
  if (row.status !== 'approved' || row.waitingDays === null) return null;
  return { label: RETURNS_COPY.waitingDays(row.waitingDays), overdue: row.waitingDays >= RETURN_WAITING_PROMPT_DAYS };
}

export type PillTone = 'default' | 'ok' | 'warn' | 'crit';

export function returnStatusTone(status: string): PillTone {
  switch (status) {
    case 'requested':
      return 'warn';
    case 'closed':
      return 'ok';
    case 'denied':
      return 'crit';
    default:
      return 'default';
  }
}

export { returnStatusLabel };

// ── Workbench actions under the connection state ───────────────────────────

export interface WorkbenchActionView extends ReturnActions {
  /** Why every action is disabled right now (offline, or a request under way). */
  disabledReason: string | null;
}

/**
 * The actions core offers for this RMA and viewer, and whether they can be
 * pressed NOW. Offline, nothing can: every return action needs the server's
 * answer (no outbox kind exists for one).
 */
export function workbenchActions(
  wb: Pick<MobileReturnWorkbench, 'return' | 'viewer' | 'exchangeStatus'>,
  input: { itemIsHere: boolean; online: boolean; busy: boolean },
): WorkbenchActionView {
  const base = availableReturnActions({
    status: wb.return.status,
    exchangeStatus: wb.exchangeStatus ?? 'none',
    viewerCanManageReturns: wb.viewer.canManageReturns,
    viewerCanApproveOrders: wb.viewer.canApproveOrders,
    itemIsHere: input.itemIsHere,
  });
  const offered = base.primary !== null || base.secondary.length > 0;
  return {
    ...base,
    disabledReason: !offered ? null : !input.online ? READINESS_NEEDS_CONNECTION_COPY : input.busy ? 'Saving…' : null,
  };
}

export function actionLabel(action: ReturnAction): string {
  return RETURN_ACTION_LABELS[action];
}

// ── Destinations ───────────────────────────────────────────────────────────

/** The lines whose destination can still change (unapplied, with options). */
export function openLines(wb: Pick<MobileReturnWorkbench, 'lines'>): MobileReturnWorkbenchLine[] {
  return wb.lines.filter((l) => !l.applied && l.restock !== null);
}

/** The choice each open line starts with (core preselection, G12). */
export function initialChoices(wb: Pick<MobileReturnWorkbench, 'lines'>): Record<string, RestockChoice> {
  const out: Record<string, RestockChoice> = {};
  for (const l of openLines(wb)) out[l.id] = preselectedChoice(l.restock!);
  return out;
}

/** A line with no destination answer has NOTHING chosen (returns review):
 *  it is never sent as Staging. */
export function choiceFor(line: MobileReturnWorkbenchLine, choices: Record<string, RestockChoice>): RestockChoice {
  return choices[line.id] ?? (line.restock ? preselectedChoice(line.restock) : unreadDestinationChoice(line.disposition));
}

/** "New Hire Shirt, M": how the sentences name a line. */
export function lineLabel(line: MobileReturnWorkbenchLine): string {
  return returnLineLabel(line.item.name, line.item.variant);
}

/** Every unapplied line has a choice the server offers now (none while the
 *  destinations could not be read). */
export function allChoicesOffered(
  wb: Pick<MobileReturnWorkbench, 'lines'> & { destinationsUnavailable?: boolean },
  choices: Record<string, RestockChoice>,
): boolean {
  if (wb.destinationsUnavailable) return false;
  return wb.lines.filter((l) => !l.applied).every((l) => (l.restock ? isChoiceOffered(l.restock, choiceFor(l, choices)) : false));
}

/** Why the send button is disabled, one sentence per line that needs a
 *  destination, naming it (returns review, plan 3.5.4). */
export function choiceProblems(
  wb: Pick<MobileReturnWorkbench, 'lines'> & { destinationsUnavailable?: boolean },
  choices: Record<string, RestockChoice>,
): string[] {
  if (wb.destinationsUnavailable) return [RETURNS_COPY.destinationsUnavailable];
  return openLines(wb).flatMap((l) => {
    const c = choiceFor(l, choices);
    return c.needsChoice ? [choiceNeededSentence(lineLabel(l), c.needsChoice)] : [];
  });
}

/** The approval's decision: every unapplied line (no silent default; call
 *  only when allChoicesOffered, a line with nothing chosen throws). */
export function approvalDecision(
  wb: Pick<MobileReturnWorkbench, 'lines'>,
  choices: Record<string, RestockChoice>,
): { lines: ReturnLineDecision[] } {
  return {
    lines: wb.lines
      .filter((l) => !l.applied)
      .map((l) => choiceToDecision(l.id, choiceFor(l, choices)) as ReturnLineDecision),
  };
}

/** Only the lines whose choice differs from the live plan (process, plan). */
export function changedDecisions(
  wb: Pick<MobileReturnWorkbench, 'lines'>,
  choices: Record<string, RestockChoice>,
): ReturnLineDecision[] {
  return openLines(wb)
    .filter((l) => !sameChoice(liveChoice(l.restock!), choiceFor(l, choices)))
    .map((l) => choiceToDecision(l.id, choiceFor(l, choices)) as ReturnLineDecision);
}

/** The process button: "Return to 31-C" for one line, else "Process return". */
export function processButtonLabel(wb: Pick<MobileReturnWorkbench, 'lines'>, choices: Record<string, RestockChoice>): string {
  const lines = openLines(wb);
  if (lines.length === 1) return processLabelFor(lines[0]!.restock!, choiceFor(lines[0]!, choices)).button;
  return RETURNS_COPY.processReturn;
}

/** "What happens when you approve": the general line, then one sentence per
 *  open line that names it ("When processed, New Hire Shirt, M goes back to
 *  31-C."), each with a stable key (the line id; two lines with the same
 *  destination are two rows, never one React key). */
export function whatHappensLines(
  wb: Pick<MobileReturnWorkbench, 'lines'>,
  choices: Record<string, RestockChoice>,
): { key: string; text: string }[] {
  return [
    { key: 'nothing-moves', text: RETURNS_COPY.approveNothingMoves },
    ...openLines(wb).map((l) => ({
      key: l.id,
      text: whenProcessedSentence(processLabelFor(l.restock!, choiceFor(l, choices)).destination, lineLabel(l)),
    })),
  ];
}

/** The hint under a received line ("Put it back on 31-C now. …"), or why it
 *  needs a destination. */
export function processingHint(line: MobileReturnWorkbenchLine, choice: RestockChoice): string | null {
  if (!line.restock) return null;
  const p = processLabelFor(line.restock, choice);
  if (p.destination.kind === 'rack') return RETURNS_COPY.processToRackHint(p.destination.rack);
  if (p.destination.kind === 'staging') return RETURNS_COPY.processToStagingHint;
  if (p.destination.kind === 'choose') return whenProcessedSentence(p.destination, lineLabel(line));
  return RETURNS_COPY.processScrapHint;
}

/** The deny sheet's help: only a requester's RMA tells anyone (review). */
export function denyHelp(wb: Pick<MobileReturnWorkbench, 'return'>): string {
  return wb.return.source === 'requester' ? RETURNS_COPY.denyReasonHelp : RETURNS_COPY.denyReasonHelpInternal;
}

// ── Step outcomes ──────────────────────────────────────────────────────────

/** The words for one ran step (refused: the server's own words). */
export function stepOutcomeMessage(
  r: MobileReturnStepResult,
  wb: Pick<MobileReturnWorkbench, 'return'>,
  receiveNow: boolean,
): string {
  if (r.outcome === 'refused') return r.message ?? 'This step could not be completed.';
  if (r.outcome === 'already') {
    if (r.step === 'process') return alreadyClosedSentence(wb.return.closedByName, null);
    if (r.step === 'receive') return alreadyReceivedSentence(wb.return.receivedByName, null);
    return 'Already approved.';
  }
  if (r.step === 'approve') return receiveNow ? 'Approved and received.' : 'Return approved.';
  if (r.step === 'receive') return 'Return received.';
  return 'Return processed.';
}
