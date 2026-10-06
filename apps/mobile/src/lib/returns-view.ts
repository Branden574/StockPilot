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
  addReplacementDecision,
  alreadyClosedSentence,
  alreadyReceivedSentence,
  approvalPreviewLines,
  availableLabel,
  availableReturnActions,
  exchangeLineStatusLabel,
  exchangeReviewDecision,
  exchangeReviewProblem,
  formatOrderNumber as formatSo,
  releasedBeforeReturnLine,
  replacementBannerLines,
  replacementChipState,
  replacementRmaLinkLabel,
  replacementShortItems,
  replacementShortLine,
  returnActionLabel,
  shortLabel,
  type ExchangeReviewState,
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
  MobileExchangeLine,
  MobilePrepareAnswer,
  MobileReturnExchange,
  MobileReturnListRow,
  MobileReturnStepResult,
  MobileReturnWorkbench,
  MobileReturnWorkbenchLine,
} from './returns-api';

/** A workbench from a server before RX-2 has no exchange half. Lives here
 *  (no react-native import) so the pure helpers stay testable. */
export const NO_EXCHANGE: MobileReturnExchange = {
  kind: 'return',
  status: 'none',
  statusLabel: 'Return',
  lines: [],
  replacement: null,
  history: [],
  releasedEarly: false,
  release: null,
  counter: false,
  rail: [],
  hasApprovedExchange: false,
  createEnabled: false,
};

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
  wb: Pick<MobileReturnWorkbench, 'return' | 'viewer' | 'exchangeStatus'> & { exchange?: MobileReturnExchange },
  input: { itemIsHere: boolean; online: boolean; busy: boolean },
): WorkbenchActionView {
  const ex = exchangeOf(wb);
  const base = availableReturnActions({
    status: wb.return.status,
    exchangeStatus: ex.status !== 'none' ? ex.status : (wb.exchangeStatus ?? 'none'),
    hasExchange: ex.kind === 'exchange',
    replacementClass: ex.replacement?.class ?? 'none',
    hasApprovedExchange: ex.hasApprovedExchange,
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

export function actionLabel(action: ReturnAction, opts: { hasExchange?: boolean } = {}): string {
  return opts.hasExchange ? returnActionLabel(action, { hasExchange: true }) : RETURN_ACTION_LABELS[action];
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

// ── RX-2: the exchange ──────────────────────────────────────────────────────

/** The workbench's exchange half (a server before RX-2 sends none). */
export function exchangeOf(wb: { exchange?: MobileReturnExchange | null }): MobileReturnExchange {
  return wb.exchange ?? NO_EXCHANGE;
}

/** The exchange line a returned line asked for, if any. */
export function exchangeForLine(wb: { exchange?: MobileReturnExchange | null }, returnLineId: string): MobileExchangeLine | null {
  return exchangeOf(wb).lines.find((x) => x.returnLineId === returnLineId) ?? null;
}

/** "Walk New Hire Shirt, L" for the replacement the line asked for or was approved. */
export function replacementLabel(x: MobileExchangeLine): string {
  const it = x.approvedItem ?? x.requestedItem;
  return it ? returnLineLabel(it.name, it.variant) : RETURNS_COPY.replacementWarehouseReview;
}

/** The REPLACEMENT side's lines: what was asked, what the warehouse chose, how many, availability. */
export function replacementSideLines(x: MobileExchangeLine): { key: string; text: string; tone: 'ink' | 'muted' | 'crit' }[] {
  const out: { key: string; text: string; tone: 'ink' | 'muted' | 'crit' }[] = [];
  const requested = x.requestedItem ? returnLineLabel(x.requestedItem.name, x.requestedItem.variant) : RETURNS_COPY.replacementWarehouseReview;
  out.push({ key: 'requested', text: `${RETURNS_COPY.replacementRequested}: ${requested}`, tone: 'ink' });
  if (x.requestNote) out.push({ key: 'note', text: `${RETURNS_COPY.replacementNoteFromRequester}: ${x.requestNote}`, tone: 'muted' });
  if (x.approvedItem && x.changedByWarehouse) {
    out.push({
      key: 'changed',
      text: `${RETURNS_COPY.replacementApproved}: ${returnLineLabel(x.approvedItem.name, x.approvedItem.variant)} (${RETURNS_COPY.replacementChangedByWarehouse})`,
      tone: 'ink',
    });
  }
  out.push({ key: 'qty', text: qtyRequestedText(x.approvedQuantity ?? x.requestedQuantity), tone: 'muted' });
  if (x.status === 'requested' && x.requestedFree !== null) {
    const short = x.requestedFree < x.requestedQuantity;
    out.push({
      key: 'free',
      text: short ? shortLabel(x.requestedFree, x.requestedQuantity) : availableLabel(x.requestedFree),
      tone: short ? 'crit' : 'muted',
    });
  }
  return out;
}

/**
 * The REPLACEMENT card's one VoiceOver label (the card is a single accessible
 * element, so its pill is never read on its own): every line it shows, then
 * the status its pill shows, as the RETURNING card's label ends with its own
 * pill. RX-2 simulator finding SIM-1: a declined line read like a pending
 * request because the status was missing.
 */
export function replacementCardLabel(returnedName: string, x: MobileExchangeLine): string {
  const lines = replacementSideLines(x)
    .map((t) => t.text)
    .join(', ');
  return `${RETURNS_COPY.replacement} for ${returnedName}: ${lines}, ${exchangeLineStatusLabel(x.status)}`;
}

function qtyRequestedText(n: number): string {
  return `Qty requested: ${n}`;
}

/** Why the approval cannot be sent yet: one sentence per exchange line or add that needs a choice. */
export function exchangeReviewProblems(
  wb: { exchange?: MobileReturnExchange | null },
  reviews: Record<string, ExchangeReviewState>,
  adds: Record<string, { itemId: string | null; quantity: number } | null>,
): string[] {
  const out = exchangeOf(wb)
    .lines.filter((x) => x.status === 'requested')
    .map((x) => exchangeReviewProblem(x, reviews[x.id] ?? { kind: 'as_requested' }))
    .filter((p): p is string => p !== null);
  for (const a of Object.values(adds)) if (a && !a.itemId) out.push(RETURNS_COPY.chooseReplacement);
  return [...new Set(out)];
}

/** The approval's exchange decisions (requested lines, then adds). */
export function exchangeApprovalDecisions(
  wb: { exchange?: MobileReturnExchange | null },
  reviews: Record<string, ExchangeReviewState>,
  adds: Record<string, { itemId: string | null; quantity: number; reason?: string | null } | null>,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const x of exchangeOf(wb).lines) {
    if (x.status === 'requested') out.push(exchangeReviewDecision(x, reviews[x.id] ?? { kind: 'as_requested' }));
  }
  for (const [lineId, a] of Object.entries(adds)) {
    const d = a ? addReplacementDecision(lineId, a) : null;
    if (d) out.push(d);
  }
  return out;
}

/** "What happens when you approve" with the exchange (core approvalPreviewLines). */
export function exchangeWhatHappens(
  wb: Pick<MobileReturnWorkbench, 'lines'> & { exchange?: MobileReturnExchange | null },
  choices: Record<string, RestockChoice>,
  reviews: Record<string, ExchangeReviewState>,
  adds: Record<string, { itemId: string | null; label: string | null; quantity: number; free: number | null } | null>,
  itemIsHere: boolean,
): { key: string; text: string }[] {
  const ex = exchangeOf(wb);
  const labelOf = (lineId: string) => {
    const l = wb.lines.find((x) => x.id === lineId);
    return l ? lineLabel(l) : 'Item';
  };
  const sentences = approvalPreviewLines({
    lines: openLines(wb).map((l) => ({
      returnedLabel: lineLabel(l),
      destination: processLabelFor(l.restock!, choiceFor(l, choices)).destination,
    })),
    exchanges: [
      ...ex.lines
        .filter((x) => x.status === 'requested')
        .map((x) => {
          const v = reviews[x.id] ?? { kind: 'as_requested' as const };
          const change = v.kind === 'change';
          return {
            returnedLabel: labelOf(x.returnLineId),
            decision: v.kind === 'decline' ? ('decline' as const) : change && !v.itemId ? ('pending' as const) : ('approve' as const),
            replacementLabel: change ? v.label : x.requestedItem ? returnLineLabel(x.requestedItem.name, x.requestedItem.variant) : null,
            quantity: change ? v.quantity : x.requestedQuantity,
            available: change ? v.free : x.requestedFree,
          };
        }),
      ...Object.entries(adds).flatMap(([lineId, a]) =>
        a?.itemId
          ? [{ returnedLabel: labelOf(lineId), decision: 'add' as const, replacementLabel: a.label, quantity: a.quantity, available: a.free }]
          : [],
      ),
    ],
    itemIsHere,
  });
  return sentences.map((text, i) => ({ key: `${i}`, text }));
}

/** A refused approval's short items as sentences ("Walk New Hire Shirt, L: 0 available, 1 needed."). */
export function shortSentences(detail: unknown, labelFor: (itemId: string) => string): string[] {
  const list = Array.isArray(detail) ? replacementShortItems(detail as Record<string, unknown>[]) : [];
  return list.map((s) => replacementShortLine(labelFor(s.itemId), s.available, s.needed));
}

/** The label the short sentences use for an item id (the exchange's own items). */
export function exchangeItemLabel(wb: { exchange?: MobileReturnExchange | null }, itemId: string): string {
  for (const x of exchangeOf(wb).lines) {
    if (x.approvedItemId === itemId && x.approvedItem) return returnLineLabel(x.approvedItem.name, x.approvedItem.variant);
    if (x.requestedItemId === itemId && x.requestedItem) return returnLineLabel(x.requestedItem.name, x.requestedItem.variant);
  }
  return 'Item';
}

/** The replacement order block's lines (SO, reserved per line, the pick hint, the release). */
export function replacementOrderLines(wb: { exchange?: MobileReturnExchange | null }, canReadDecisions: boolean): { key: string; text: string }[] {
  const ex = exchangeOf(wb);
  const out: { key: string; text: string }[] = [];
  if (!ex.replacement) {
    if (ex.kind === 'exchange') out.push({ key: 'none', text: RETURNS_COPY.noReplacementYet });
    return out;
  }
  const so = formatSo(ex.replacement.orderNumber) ?? ex.replacement.orderId.slice(0, 8).toUpperCase();
  out.push({ key: 'so', text: `${RETURNS_COPY.replacementOrderHeading} ${so}${ex.replacement.live ? '' : ' (cancelled)'}` });
  for (const l of ex.replacement.lines) {
    out.push({ key: `l-${l.orderLineId}`, text: `${l.label} ×${l.requested} · reserved ${l.held}` });
    if (l.take) out.push({ key: `t-${l.orderLineId}`, text: l.take });
  }
  if (ex.replacement.short) out.push({ key: 'short', text: RETURNS_COPY.notInStock });
  if (ex.releasedEarly) {
    out.push({ key: 'released', text: releasedBeforeReturnLine(ex.release?.byName ?? null, canReadDecisions ? (ex.release?.reason ?? null) : null) });
  }
  return out;
}

/** The words after "Get replacement ready" (plan 3.3.8). */
export function prepareOutcomeMessage(answer: Pick<MobilePrepareAnswer, 'ran' | 'status'>): string {
  const refused = answer.ran.find((r) => r.outcome === 'refused');
  if (refused) return refused.message ?? RETURNS_COPY.prepareStopped;
  if (answer.status === 'staged_for_delivery') return RETURNS_COPY.prepareStagedDelivery;
  if (answer.status === 'staged_for_pickup') return RETURNS_COPY.prepareStaged;
  return RETURNS_COPY.prepareUnconfirmed;
}

/** The list row's exchange words: "Exchange · Replacement reserved. Waiting for returned item · SO-000104". */
export function returnRowExchange(row: MobileReturnListRow): string | null {
  if (row.type !== 'exchange') return null;
  const so = formatSo(row.replacementOrderNumber ?? null);
  return [RETURNS_COPY.typeExchange, row.exchangeStatusLabel ?? null, so].filter(Boolean).join(' · ');
}

// ── RX-2: the replacement order on the order screen ─────────────────────────

/** The order route's replacement block (GET /api/v1/orders/[id]); mirrors the web's OrderReplacementInfo. */
export interface MobileOrderReplacement {
  returnId: string;
  returnNumber: string | null;
  returnStatus: string | null;
  originalOrderId: string | null;
  originalOrderNumber: number | null;
  live: boolean;
  /** Handed over (its order completed): the banner says how the exchange ended. Absent from an older server. */
  handedOver?: boolean;
  exchangeStatus: string;
  exchangeStatusLabel: string;
  waitingForReturn: boolean;
  /** The RMA was cancelled or denied: never picked again (desk check F3). Absent from an older server. */
  returnClosed?: boolean;
  releasedEarly: boolean;
  release: { byName: string | null; reason: string | null; at: string | null } | null;
  returnReceived: boolean;
  revision: number | null;
  canOpenReturn: boolean;
  canReleaseEarly: boolean;
  slipLine: string;
  driverLine: string | null;
}

/**
 * The banner's sentences, in order (the RMA link is the screen's, for
 * canOpenReturn): core's replacementBannerLines, the web banner's rule too.
 * A replacement already handed over says how the exchange ended instead of
 * the gate, the closed RMA, the driver's line and "Change or cancel".
 */
export function orderReplacementLines(
  info: MobileOrderReplacement,
  fulfillmentType: 'pickup' | 'delivery' | null,
): { key: string; text: string }[] {
  return replacementBannerLines(info, fulfillmentType);
}

/**
 * The return-first gate holds the pick slip and Resume (waiting for the
 * returned item), or the RMA was cancelled or denied and the replacement is
 * never picked again (desk check F3). The web's manager panel, same rule.
 */
export function replacementPickBlocked(info: Pick<MobileOrderReplacement, 'waitingForReturn' | 'returnClosed'> | null | undefined): boolean {
  return info?.waitingForReturn === true || info?.returnClosed === true;
}

/**
 * The link that opens the RMA: "Change or cancel in RMA-…" while the
 * replacement is still to be handed over, "Open RMA-…" once it was.
 */
export function changeInRmaLabel(info: Pick<MobileOrderReplacement, 'returnNumber' | 'live' | 'handedOver'>): string {
  return replacementRmaLinkLabel(info);
}

/** The orders list chip: "Exchange" and, for the live replacement, the gate words. */
export function orderExchangeChip(
  replacementForReturnId: string | null | undefined,
  overview: { replacementOrderId: string | null; exchangeStatus: string | null } | null,
  orderId: string,
): string | null {
  if (!replacementForReturnId) return null;
  const live = overview && overview.replacementOrderId === orderId;
  const state = live ? replacementChipState(overview.exchangeStatus as never) : null;
  return state ? `${RETURNS_COPY.typeExchange} · ${state}` : RETURNS_COPY.typeExchange;
}
