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
  approvalOutcomeLine,
  approvalPreviewLines,
  availableLabel,
  availableReturnActions,
  defaultExchangeReviewState,
  earlierReplacementsLine,
  exchangeActionConsequences,
  exchangeReviewDecision,
  exchangeReviewProblem,
  formatOrderNumber as formatSo,
  releasedBeforeReturnLine,
  replacementBannerLines,
  replacementCardQuantityLabel,
  replacementCardStatusLabel,
  replacementChipState,
  replacementLineSummary,
  replacementRmaLinkLabel,
  replacementShortItems,
  replacementCancelledLines,
  replacementShortLine,
  returnActionLabel,
  shortLabel,
  type ApprovalOutcomeAnswer,
  type ExchangeConsequenceAction,
  type ExchangeConsequenceKey,
  type ExchangeReviewState,
  type ExchangeReviewViewer,
  type RailStep,
  choiceNeededSentence,
  choiceToDecision,
  formatOrderNumber,
  isChoiceOffered,
  liveChoice,
  noReplacementLine,
  preselectedChoice,
  processLabelFor,
  railStepStateWords,
  READINESS_NEEDS_CONNECTION_COPY,
  RETURN_ACTION_LABELS,
  RETURN_WAITING_PROMPT_DAYS,
  RETURNS_COPY,
  returnLineLabel,
  returnStatusLabel,
  returnWaitingDays,
  sameChoice,
  stillWaitingPrompt,
  unreadDestinationChoice,
  waitingForReturnLine,
  whenProcessedSentence,
  type OrderReadinessResult,
  type RestockChoice,
  type ReturnAction,
  type ReturnActions,
  type ReturnLineDecision,
} from '@stockpilot/core';

import type {
  MobileExchangeLine,
  MobilePrepareAnswer,
  MobileReplacement,
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

/** The button words; a viewer who can only decline the exchange approves the
 *  return (fix round 1, verification L3: core's returnActionLabel). */
export function actionLabel(action: ReturnAction, opts: { hasExchange?: boolean; canApproveOrders?: boolean } = {}): string {
  return opts.hasExchange
    ? returnActionLabel(action, { hasExchange: true, canApproveOrders: opts.canApproveOrders })
    : RETURN_ACTION_LABELS[action];
}

/** The live replacement's status as the sheet shows it, sent with Cancel
 *  replacement: the server refuses (return_changed) one picked or sent since
 *  (fix round 1, verification V1). Null when none is shown. */
export function shownReplacementStatus(wb: { exchange?: MobileReturnExchange | null }): string | null {
  const shown = exchangeOf(wb).replacement;
  return shown?.live ? shown.status : null;
}

/** The notice after Cancel replacement, from the answer: what to do with what
 *  was picked or sent (core's words; the notice is an announced alert). */
export function cancelReplacementMessage(answer: { changed: boolean; drawn?: boolean; inTransit?: boolean }): string {
  return replacementCancelledLines(answer).join(' ');
}

/** The short block's backorder button for the sheet's mode (fix round 1,
 *  verification L1): nothing is approved in a change or a re-issue. */
export function shortBackorderLabel(mode: string): string {
  if (mode === 'change_replacement') return RETURNS_COPY.changeReplacementOnBackorder;
  if (mode === 'issue_replacement') return RETURNS_COPY.issueReplacementOnBackorder;
  return RETURNS_COPY.approveReplacementOnBackorder;
}

/**
 * What a workbench button does, shown under it and read as its VoiceOver
 * hint (review fix P18): "Get replacement ready" draws stock and stages the
 * order in one tap, so core's words say so first. Null for the others.
 */
export function actionHelp(action: ReturnAction | null): string | null {
  return action === 'get_replacement_ready' ? RETURNS_COPY.getReplacementReadyHelp : null;
}

/**
 * A workbench button's VoiceOver hint: why it is off, else its own help,
 * else, for Cancel replacement and Cancel return, the 14-day prompt (the
 * web's aria-describedby on both; RX-3 fix round 1, desk check L3).
 */
export function workbenchActionHint(
  action: ReturnAction | null,
  ctx: { disabledReason: string | null | undefined; stillWaiting: string | null },
): string | undefined {
  if (ctx.disabledReason) return ctx.disabledReason;
  const help = actionHelp(action);
  if (help) return help;
  if (ctx.stillWaiting && (action === 'cancel_replacement' || action === 'cancel')) return ctx.stillWaiting;
  return undefined;
}

/**
 * The 14-day prompt under the next-step bar (RX-2 review fix P17, built in
 * RX-3; plan 3.10, D28): from 14 whole days after approval, while the
 * returned item is still out and the replacement waits for it (reserved, or
 * not in stock), for a viewer offered Cancel replacement, core's words name
 * the two buttons that end the wait ("Waiting 15 days. Still waiting for the
 * returned item? Cancel replacement frees the reserved items; Cancel return
 * ends the return too."), and say nothing is freed when nothing is held.
 * Nothing expires on its own. The days follow the list's rule (the view's
 * waiting_days, core returnWaitingDays) from the workbench's approval time;
 * the buttons are the ones this workbench offers (the same core
 * availableReturnActions the server runs). Null otherwise.
 */
export function workbenchStillWaiting(
  wb: Pick<MobileReturnWorkbench, 'return'> & { exchange?: MobileReturnExchange | null },
  actions: Pick<ReturnActions, 'primary' | 'secondary'>,
  now: number = Date.now(),
): string | null {
  const ex = exchangeOf(wb);
  return stillWaitingPrompt({
    status: wb.return.status,
    exchangeStatus: ex.status,
    waitingDays: returnWaitingDays(wb.return.status, wb.return.approvedAt, now),
    offered: [actions.primary, ...actions.secondary],
    held: ex.replacement ? ex.replacement.held : null,
  });
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

/**
 * The approval's answer as the workbench after it shows it (the steps route
 * answers the whole workbench): the RMA's status and the live replacement
 * the approval created, if any (core approvalOutcomeLine, review fix P23).
 */
function approvalAnswerOf(wb: Pick<MobileReturnWorkbench, 'return'> & { exchange?: MobileReturnExchange | null }): ApprovalOutcomeAnswer {
  const shown = exchangeOf(wb).replacement;
  const live = shown?.live ? shown : null;
  return {
    status: wb.return.status,
    replacement: live ? { orderNumber: live.orderNumber, short: live.short, lines: live.lines.map((l) => ({ held: l.held })) } : null,
  };
}

/** The words for one ran step (refused: the server's own words). An
 *  approval names the replacement order it created and what it reserved, or
 *  that it went on backorder (review fix P23). */
export function stepOutcomeMessage(
  r: MobileReturnStepResult,
  wb: Pick<MobileReturnWorkbench, 'return'> & { exchange?: MobileReturnExchange | null },
  receiveNow: boolean,
): string {
  if (r.outcome === 'refused') return r.message ?? 'This step could not be completed.';
  if (r.outcome === 'already') {
    if (r.step === 'process') return alreadyClosedSentence(wb.return.closedByName, null);
    if (r.step === 'receive') return alreadyReceivedSentence(wb.return.receivedByName, null);
    return 'Already approved.';
  }
  if (r.step === 'approve') return approvalOutcomeLine(approvalAnswerOf(wb), { receiveNow });
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

/**
 * The REPLACEMENT side's lines: what was asked, what the warehouse chose, how
 * many, availability. `replacement` is the workbench's replacement block:
 * once it was handed over the quantity says so (core's rule, the web card's
 * too; returns RX-3 PR stage, polish (a)).
 */
export function replacementSideLines(
  x: MobileExchangeLine,
  replacement: MobileReplacement | null = null,
): { key: string; text: string; tone: 'ink' | 'muted' | 'crit' }[] {
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
  out.push({ key: 'qty', text: replacementCardQuantityLabel(x, replacement), tone: 'muted' });
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

/** An item's photo for a card: its thumbnail first, else the full image. */
export function itemPhotoUrl(item: { thumbUrl: string | null; imageUrl: string | null } | null | undefined): string | null {
  return item?.thumbUrl || item?.imageUrl || null;
}

/** The REPLACEMENT card's photo (review fix P11): the approved item's, else
 *  the one asked for; none for a note-only request. */
export function replacementPhotoUrl(x: MobileExchangeLine): string | null {
  return itemPhotoUrl(x.approvedItem ?? x.requestedItem);
}

/**
 * The REPLACEMENT card's one VoiceOver label (the card is a single accessible
 * element, so its pill is never read on its own): every line it shows, then
 * the status its pill shows, as the RETURNING card's label ends with its own
 * pill. RX-2 simulator finding SIM-1: a declined line read like a pending
 * request because the status was missing.
 */
export function replacementCardLabel(returnedName: string, x: MobileExchangeLine, replacement: MobileReplacement | null = null): string {
  const lines = replacementSideLines(x, replacement)
    .map((t) => t.text)
    .join(', ');
  return `${RETURNS_COPY.replacement} for ${returnedName}: ${lines}, ${replacementCardStatus(x, replacement)}`;
}

/**
 * The REPLACEMENT card's pill: Handed over, Partly handed over or Not sent
 * once the replacement was handed over or closed, else the line's stored
 * status (core replacementCardStatusLabel, the web pill's rule).
 */
export function replacementCardStatus(x: MobileExchangeLine, replacement: MobileReplacement | null = null): string {
  return replacementCardStatusLabel(x, replacement);
}

/** The workbench as the review reads it: its exchange half and who is reviewing. */
type ReviewWorkbench = {
  exchange?: MobileReturnExchange | null;
  viewer?: { canApproveOrders: boolean } | null;
  /** The return lines (how many come back), for where a note-only review starts. */
  lines?: readonly { id: string; quantity: number }[];
};

/** Who reviews (server-computed order approval; a workbench without a viewer reads as before). */
function reviewerOf(wb: ReviewWorkbench): ExchangeReviewViewer {
  return { canApproveOrders: wb.viewer?.canApproveOrders !== false };
}

/**
 * A requested exchange line's review: the person's choice, else where core
 * starts it for this viewer (review fix P1): "Approve as requested", or the
 * decline for a returns manager without order approval, who may only decline.
 */
export function exchangeReviewStateFor(
  wb: ReviewWorkbench,
  reviews: Record<string, ExchangeReviewState>,
  exchangeLineId: string,
): ExchangeReviewState {
  const chosen = reviews[exchangeLineId];
  if (chosen) return chosen;
  // RX-3 fix round 1 (M3): a note-only request starts at Change replacement,
  // never at "Approve as requested" (off for it); core decides from the line.
  const x = exchangeOf(wb).lines.find((l) => l.id === exchangeLineId);
  const returned = x ? (wb.lines ?? []).find((l) => l.id === x.returnLineId)?.quantity ?? null : null;
  return defaultExchangeReviewState(
    reviewerOf(wb),
    x ? { requestedItemId: x.requestedItemId, requestedQuantity: x.requestedQuantity, returnedQuantity: returned } : undefined,
  );
}

/** Why the approval cannot be sent yet: one sentence per exchange line or add
 *  that needs a choice; a choice the viewer may not make is refused here,
 *  before anything is sent (core exchangeReviewProblem with the viewer). */
export function exchangeReviewProblems(
  wb: ReviewWorkbench,
  reviews: Record<string, ExchangeReviewState>,
  adds: Record<string, { itemId: string | null; quantity: number } | null>,
): string[] {
  const reviewer = reviewerOf(wb);
  const out = exchangeOf(wb)
    .lines.filter((x) => x.status === 'requested')
    .map((x) => exchangeReviewProblem(x, exchangeReviewStateFor(wb, reviews, x.id), reviewer))
    .filter((p): p is string => p !== null);
  for (const a of Object.values(adds)) if (a && !a.itemId) out.push(RETURNS_COPY.chooseReplacement);
  return [...new Set(out)];
}

/** The approval's exchange decisions (requested lines, then adds), always the
 *  ones the review holds (review fix P1: a decline is sent too). */
export function exchangeApprovalDecisions(
  wb: ReviewWorkbench,
  reviews: Record<string, ExchangeReviewState>,
  adds: Record<string, { itemId: string | null; quantity: number; reason?: string | null } | null>,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const x of exchangeOf(wb).lines) {
    if (x.status === 'requested') out.push(exchangeReviewDecision(x, exchangeReviewStateFor(wb, reviews, x.id)));
  }
  for (const [lineId, a] of Object.entries(adds)) {
    const d = a ? addReplacementDecision(lineId, a) : null;
    if (d) out.push(d);
  }
  return out;
}

/** "What happens when you approve" with the exchange (core approvalPreviewLines). */
export function exchangeWhatHappens(
  wb: Pick<MobileReturnWorkbench, 'lines'> & ReviewWorkbench,
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
          const v = exchangeReviewStateFor(wb, reviews, x.id);
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

/** The sheets that say what happens to the replacement (review fix P2). */
const CONSEQUENCE_MODES: readonly ExchangeConsequenceAction[] = ['cancel', 'cancel_replacement', 'change_replacement', 'issue_replacement'];

/**
 * What a sheet says happens to the replacement (review fix P2, core
 * exchangeActionConsequences: the web dialogs' words too): Cancel return
 * (the replacement not handed over is cancelled too and named; what was
 * handed over stays), Cancel replacement (the picked and in-transit warnings
 * first, then what it does; never "The return stays open."), Change
 * replacement and Issue a new replacement (what is created). Read from the
 * live replacement the screen shows; every other sheet says nothing about it.
 */
export function exchangeSheetConsequences(
  mode: string,
  wb: { exchange?: MobileReturnExchange | null },
): { key: ExchangeConsequenceKey; text: string }[] {
  const action = CONSEQUENCE_MODES.find((a) => a === mode);
  if (!action) return [];
  const shown = exchangeOf(wb).replacement;
  const live = shown?.live ? shown : null;
  return exchangeActionConsequences(action, {
    replacementStatus: live?.status ?? null,
    anythingHandedOver: live ? live.class === 'handed_over' || live.lines.some((l) => l.fulfilled > 0) : false,
    replacementOrderNumber: live?.orderNumber ?? null,
    held: live ? live.held : null,
  });
}

/** A refused approval's short items as sentences ("Walk New Hire Shirt, L: 0 available, 1 needed."). */
export function shortSentences(detail: unknown, labelFor: (itemId: string) => string): string[] {
  const list = Array.isArray(detail) ? replacementShortItems(detail as Record<string, unknown>[]) : [];
  return list.map((s) => replacementShortLine(labelFor(s.itemId), s.available, s.needed));
}

/**
 * "Change replacement" after a short refusal (review fix P7, the web's rule):
 * each requested line approved as requested whose item is short switches to
 * Change replacement, its picker open with nothing chosen; a change already
 * under way to a short item keeps its choice. `focusIds` are the lines to
 * look at, in screen order (an exchange line's id, or the returned line's id
 * for an added replacement), the first scrolled to and focused. Nothing
 * switches for a viewer without order approval (Change is off for them) or a
 * detail that cannot be read.
 */
export function reviewsForShortChange(
  wb: Pick<MobileReturnWorkbench, 'lines'> & ReviewWorkbench,
  reviews: Record<string, ExchangeReviewState>,
  detail: unknown,
  adds: Record<string, { itemId: string | null; quantity: number } | null>,
): { reviews: Record<string, ExchangeReviewState>; focusIds: string[] } {
  const short = new Set((Array.isArray(detail) ? replacementShortItems(detail as Record<string, unknown>[]) : []).map((s) => s.itemId));
  if (short.size === 0 || !reviewerOf(wb).canApproveOrders) return { reviews, focusIds: [] };
  const ex = exchangeOf(wb);
  const next: Record<string, ExchangeReviewState> = { ...reviews };
  const focusIds: string[] = [];
  for (const l of wb.lines) {
    const x = ex.lines.find((e) => e.returnLineId === l.id) ?? null;
    if (!x) {
      const add = adds[l.id];
      if (add?.itemId && short.has(add.itemId)) focusIds.push(l.id);
      continue;
    }
    if (x.status !== 'requested') continue;
    const v = exchangeReviewStateFor(wb, reviews, x.id);
    if (v.kind === 'as_requested' && x.requestedItemId && short.has(x.requestedItemId)) {
      next[x.id] = { kind: 'change', itemId: null, label: null, free: null, quantity: Math.min(x.requestedQuantity, l.quantity), reason: '' };
      focusIds.push(x.id);
    } else if (v.kind === 'change' && v.itemId && short.has(v.itemId)) {
      focusIds.push(x.id);
    }
  }
  return { reviews: next, focusIds };
}

/**
 * The most a replacement line may ask for (review fix P12): its returned
 * line's quantity, the web's quantity field's max. The server refuses more
 * (exchange_quantity_exceeds_return) and checks what the original order line
 * has left to exchange (exchange_already_sent). Never below 1.
 */
export function replacementQuantityMax(wb: Pick<MobileReturnWorkbench, 'lines'>, returnLineId: string): number {
  const l = wb.lines.find((x) => x.id === returnLineId);
  const q = l && Number.isFinite(l.quantity) ? Math.floor(l.quantity) : 1;
  return Math.max(1, q);
}

/** One tap of the replacement quantity's stepper: a whole number from 1 to max. */
export function stepReplacementQuantity(current: number, delta: number, max: number): number {
  const from = Number.isFinite(current) ? Math.floor(current) : 1;
  return Math.min(Math.max(from + delta, 1), Math.max(1, Math.floor(max)));
}

/** The stepper buttons' VoiceOver names ("Increase the replacement quantity for Walk Exchange Tee - M"). */
export function replacementQuantityStepLabel(delta: number, label: string): string {
  return `${delta > 0 ? 'Increase' : 'Decrease'} the replacement quantity for ${label}`;
}

/**
 * The label a short refusal's sentence uses for an item id: an item the review
 * itself chose (Change replacement, Add a replacement) by the review's label,
 * else the exchange's own items (simulator fault F-C: an item picked in the
 * review read "Item: 0 available, 1 needed.").
 */
export function shortItemLabel(
  wb: { exchange?: MobileReturnExchange | null },
  reviews: Record<string, ExchangeReviewState>,
  adds: Record<string, { itemId: string | null; label?: string | null } | null>,
  itemId: string,
  // Fix round 1 (verification L1): Change replacement's and Issue a new
  // replacement's own picks, with the picked row's label.
  picks: Record<string, { itemId: string | null; label?: string | null }> = {},
): string {
  for (const v of Object.values(reviews)) {
    if (v.kind === 'change' && v.itemId === itemId && v.label) return v.label;
  }
  for (const a of Object.values(adds)) {
    if (a && a.itemId === itemId && a.label) return a.label;
  }
  for (const p of Object.values(picks)) {
    if (p.itemId === itemId && p.label) return p.label;
  }
  return exchangeItemLabel(wb, itemId);
}

/** The label the short sentences use for an item id (the exchange's own items). */
export function exchangeItemLabel(wb: { exchange?: MobileReturnExchange | null }, itemId: string): string {
  for (const x of exchangeOf(wb).lines) {
    if (x.approvedItemId === itemId && x.approvedItem) return returnLineLabel(x.approvedItem.name, x.approvedItem.variant);
    if (x.requestedItemId === itemId && x.requestedItem) return returnLineLabel(x.requestedItem.name, x.requestedItem.variant);
  }
  return 'Item';
}

/**
 * The outbound rail as the card prints it: every step with its state in
 * core's words, "Requested (done)  →  Declined (stopped)  →  Waiting for
 * return (not reached)  →  …" (review fixes P4 and P21: after a stop nothing
 * reads "next"). VoiceOver reads core's exchangeRailAccessibilityLabel.
 */
export function exchangeRailText(rail: readonly RailStep[]): string {
  return rail.map((s) => `${s.label} (${railStepStateWords(s)})`).join('  →  ');
}

/** The replacement order block's lines (SO, each line as core words it,
 *  the pick hint, the release, the earlier replacements); with no
 *  replacement order, why there is none (review fix P4: declined, cancelled
 *  with the return, or not approved yet). */
export function replacementOrderLines(
  wb: { exchange?: MobileReturnExchange | null; return?: { status: string } | null },
  canReadDecisions: boolean,
): { key: string; text: string }[] {
  const ex = exchangeOf(wb);
  const out: { key: string; text: string }[] = [];
  if (!ex.replacement) {
    if (ex.kind === 'exchange') out.push({ key: 'none', text: noReplacementLine(ex.status, { returnStatus: wb.return?.status ?? null }) });
    return out;
  }
  const so = formatSo(ex.replacement.orderNumber) ?? ex.replacement.orderId.slice(0, 8).toUpperCase();
  out.push({ key: 'so', text: `${RETURNS_COPY.replacementOrderHeading} ${so}${ex.replacement.live ? '' : ' (cancelled)'}` });
  for (const l of ex.replacement.lines) {
    // Review fix P19: "· picked" once picked or staged (nothing is reserved
    // then), the hand-over beside what is still reserved (core's rule).
    out.push({
      key: `l-${l.orderLineId}`,
      text: replacementLineSummary({ label: l.label, requested: l.requested, fulfilled: l.fulfilled, held: l.held, status: ex.replacement.status }),
    });
    if (l.take) out.push({ key: `t-${l.orderLineId}`, text: l.take });
  }
  if (ex.replacement.short) out.push({ key: 'short', text: RETURNS_COPY.notInStock });
  if (ex.releasedEarly) {
    out.push({ key: 'released', text: releasedBeforeReturnLine(ex.release?.byName ?? null, canReadDecisions ? (ex.release?.reason ?? null) : null) });
  }
  // Review fix P22: the RMA's earlier replacements, in the order status words
  // (the web lists them too), never a raw status code.
  const earlier = earlierReplacementsLine(ex.history ?? []);
  if (earlier) out.push({ key: 'earlier', text: earlier });
  return out;
}

/**
 * The refusals that mean the screen is behind the server (review fix S2):
 * another person changed the return (return_changed), its status moved on
 * (invalid_status_transition, whose words say it now shows the latest), or
 * its replacement was picked or left meanwhile (replacement_in_progress, 0396:
 * the RMA cancel is refused then), or (returns RX-4, 0397) Close the rest
 * found nothing on backorder any more (replacement_not_backordered: the rest
 * was resumed or closed meanwhile). The workbench reloads and says why.
 */
const STALE_REFUSALS: readonly string[] = [
  'return_changed',
  'invalid_status_transition',
  'replacement_in_progress',
  'replacement_not_backordered',
];

export function refusalRefreshesWorkbench(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && STALE_REFUSALS.includes(reason);
}

/**
 * Where Open replacement and Hand over go: the replacement's own order screen
 * (its signature is the one hand-over). Hand over opens it with the paper
 * signature ready (?focus=sign: returns RX-2 review, counter taps).
 */
export function replacementOrderHref(orderId: string, action: 'open_replacement' | 'hand_over'): string {
  return action === 'hand_over' ? `/order/${orderId}?focus=sign` : `/order/${orderId}`;
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
  /** The viewer may change and cancel it (returns:manage and orders:approve):
   *  the RMA link reads "Change or cancel in RMA-…" only then (fix round 1,
   *  verification L5). Absent from an older server. */
  canChangeReplacement?: boolean;
  slipLine: string;
  driverLine: string | null;
  /** What this order holds now (its active holds), from a server with review
   *  fix P5; null or absent: unknown. */
  held?: number | null;
}

/**
 * What the replacement holds now, for the gate's words (review fix P5): the
 * server's number when it sends one, else what the readiness this screen
 * read holds for each owed line (only when every owed line's hold is known),
 * else null, and core then decides by the exchange status.
 */
export function replacementHeldNow(
  info: Pick<MobileOrderReplacement, 'held'>,
  readiness: OrderReadinessResult | null | undefined,
): number | null {
  if (typeof info.held === 'number' && Number.isFinite(info.held)) return info.held;
  if (!readiness || readiness.state !== 'ok') return null;
  const a = readiness.assessment;
  if (a.phase !== 'to_pick' || !a.holdAnnotated || a.linesCapped) return null;
  let held = 0;
  for (const l of a.lines) {
    if (l.owed <= 0) continue;
    if (!l.hold) return null;
    held += l.hold.held;
  }
  return held;
}

/**
 * The banner's sentences, in order: core's replacementBannerLines, the web
 * banner's rule too, for who reads it (review fixes P9 and P10): someone who
 * can open the RMA gets the RMA link itself (key 'rma_link', which the screen
 * draws as the link), the requester who to ask, anyone else who can; the
 * driver's line only for an early-released delivery, never to the requester.
 * The gate says what the replacement holds (P5). A replacement already handed
 * over says how the exchange ended instead.
 */
export function orderReplacementLines(
  info: MobileOrderReplacement,
  fulfillmentType: 'pickup' | 'delivery' | null,
  reader: { isRequester?: boolean; held?: number | null } = {},
): { key: string; text: string }[] {
  return replacementBannerLines({ ...info, held: reader.held ?? info.held ?? null }, fulfillmentType, {
    canOpenRma: info.canOpenReturn,
    isRequester: reader.isRequester === true,
  });
}

/** The gate line beside "Release before return is received" (the web manager
 *  panel's): core's words with what the replacement holds (review fix P5). */
export function replacementGateLine(
  info: Pick<MobileOrderReplacement, 'returnNumber' | 'exchangeStatus'>,
  held: number | null,
): string {
  return waitingForReturnLine(info.returnNumber, { exchangeStatus: info.exchangeStatus, held });
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
export function changeInRmaLabel(
  info: Pick<MobileOrderReplacement, 'returnNumber' | 'live' | 'handedOver' | 'canChangeReplacement'>,
): string {
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
