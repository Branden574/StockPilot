'use client';

import { Clock, ExternalLink, FileDown, Loader2, Truck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  AddReplacement,
  CancelReplacementDialog,
  CloseAsReturnOnlyDialog,
  CloseReplacementRestDialog,
  SiteChoiceDialog,
  ChangeReplacementDialog,
  ReleaseEarlyDialog,
  ReplacementOrderSection,
  ReplacementSide,
  reviewDecision,
  reviewProblem,
  type AddReplacementState,
  type ChangeLineInput,
  type ExchangeReviewState,
} from '@/components/returns/exchange-panel';
import { DetailSection } from '@/components/patterns/detail-section';
import { KeyValueList, KeyValueRow } from '@/components/patterns/key-value-row';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { PatternPhoto } from '@/components/patterns/photo';
import { Timeline } from '@/components/patterns/timeline';
import { ReturnStatusBadge } from '@/components/returns/return-status-badge';
import { RestockDestinationPicker } from '@/components/returns/restock-destination-picker';
import { cardClass, eyebrowClass } from '@/components/returns/returns-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useHydrated } from '@/lib/use-hydrated';
import { cn, formatCurrency, formatRelative } from '@/lib/utils';
import {
  buyReturnLabelAction,
  cancelReturnAction,
  cancelReturnReplacementAction,
  closeReturnReplacementRestAction,
  changeReturnReplacementAction,
  declineReturnReplacementAction,
  denyReturnAction,
  planReturnDispositionsAction,
  prepareReturnReplacementAction,
  releaseReturnReplacementAction,
  returnExchangeCandidatesAction,
  runReturnStepsAction,
} from '@/server/actions/returns';
import type { ReturnWorkbenchExchange } from '@/server/services/returns-exchange-workbench';
import type {
  ReturnWorkbench as Workbench,
  ReturnWorkbenchLine,
} from '@/server/services/returns-workbench';

import {
  addReplacementDecision,
  alreadyClosedSentence,
  alreadyReceivedSentence,
  approvalOutcomeLine,
  approvalPreviewLines,
  availableReturnActions,
  choiceNeededSentence,
  choiceToDecision,
  defaultExchangeReviewState,
  exchangeActionConsequences,
  formatOrderNumber,
  isChoiceOffered,
  liveChoice,
  plannedSentence,
  preselectedChoice,
  processLabelFor,
  qtyReturningLabel,
  releaseOutcomeLine,
  replacementCancelledLines,
  returnActionLabel,
  returnLineLabel,
  returnWaitingDays,
  replacementShortItems,
  replacementShortLine,
  RETURN_ACTION_LABELS,
  RETURN_ERROR_WORDS,
  RETURN_REASON_MAX,
  RETURNS_COPY,
  returnReasonLabel,
  sameChoice,
  stillWaitingPrompt,
  unreadDestinationChoice,
  whenProcessedSentence,
  type ReplacementFulfilment,
  type RestockChoice,
  type ReturnAction,
} from '@stockpilot/core';

/** The subset of the return label (carrier_shipments) the workbench renders. */
export interface WorkbenchReturnLabel {
  status: string;
  carrier: string | null;
  service: string | null;
  rate_cents: number | null;
  currency: string | null;
  tracking_code: string | null;
  tracking_url: string | null;
  label_url: string | null;
}

type Mode = 'idle' | 'change_destination';

/** A replacement change or re-issue as the change dialog sends it. */
type ChangeBody = {
  lines: Array<{ exchangeLineId: string; itemId: string | null; quantity: number }>;
  reason: string;
  whenShort: 'refuse' | 'backorder';
};

/** Refusals that mean the screen was stale: the dialog closes and the page redraws. */
const STALE_SCREEN_REASONS: ReadonlySet<string> = new Set([
  'replacement_in_progress',
  'return_changed',
  'invalid_status_transition',
]);

/** A workbench payload from before RX-2 (or a test) has no exchange half. */
const NO_EXCHANGE: ReturnWorkbenchExchange = {
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
  deliverySites: [],
};

/**
 * The RMA workbench (returns RX-1, graft G3): the header, the RETURNING
 * cards (photo, name, size, SKU, quantity, inbound state), the approval
 * review (disposition, then destination per plan 3.5 with the original rack
 * preselected when proven and valid), processing (revalidated live; the
 * button stays disabled until every choice is one the server offers now: a
 * planned rack that is gone opens with no destination and a sentence naming
 * the line and why, never a quiet Staging; plan 3.5.4),
 * one next-step bar from core's availableReturnActions, and the chain.
 *
 * Every write goes through ONE server action calling ONE database function;
 * the steps action answers with the whole workbench, so the screen redraws
 * from server truth. Buttons are never authorization: the database refuses
 * what the viewer may not do.
 */
export function ReturnWorkbench({
  workbench,
  canManageShipping = false,
  returnLabel = null,
}: {
  workbench: Workbench;
  canManageShipping?: boolean;
  returnLabel?: WorkbenchReturnLabel | null;
}) {
  const router = useRouter();
  const [wb, setWb] = React.useState(workbench);
  const [choices, setChoices] = React.useState<Record<string, RestockChoice>>(() =>
    initialChoices(workbench.lines),
  );
  // A fresh server payload (router.refresh) replaces the local copy and the
  // choices it implies; adjusted during render, not in an effect.
  const [seenProp, setSeenProp] = React.useState(workbench);
  if (seenProp !== workbench) {
    setSeenProp(workbench);
    setWb(workbench);
    setChoices(initialChoices(workbench.lines));
  }
  const adopt = (next: Workbench) => {
    setWb(next);
    setChoices(initialChoices(next.lines));
  };

  const r = wb.return;
  const openLines = wb.lines.filter((l) => !l.applied && l.restock);
  const [itemIsHere, setItemIsHere] = React.useState(workbench.createdOnCounter);
  const [mode, setMode] = React.useState<Mode>('idle');
  const [busy, setBusy] = React.useState<string | null>(null);
  const [denyOpen, setDenyOpen] = React.useState(false);
  const [denyReason, setDenyReason] = React.useState('');
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [cancelReason, setCancelReason] = React.useState('');

  const ex = wb.exchange ?? NO_EXCHANGE;
  const hasExchange = ex.kind === 'exchange';
  const actions = availableReturnActions({
    status: r.status,
    exchangeStatus: ex.status,
    hasExchange,
    replacementClass: ex.replacement?.class ?? 'none',
    hasApprovedExchange: ex.hasApprovedExchange,
    viewerCanManageReturns: wb.viewer.canManageReturns,
    viewerCanApproveOrders: wb.viewer.canApproveOrders,
    itemIsHere,
  });

  // RX-2: the approval's exchange review, "Add a replacement", and the
  // replacement dialogs.
  const [reviews, setReviews] = React.useState<Record<string, ExchangeReviewState>>({});
  const [adds, setAdds] = React.useState<Record<string, AddReplacementState | null>>({});
  const [shortDetail, setShortDetail] = React.useState<unknown>(null);
  const [releaseOpen, setReleaseOpen] = React.useState(false);
  const [cancelReplacementOpen, setCancelReplacementOpen] = React.useState(false);
  const [returnOnlyOpen, setReturnOnlyOpen] = React.useState(false);
  const [closeRestOpen, setCloseRestOpen] = React.useState(false);
  // Desk check F6: an approval, change or re-issue refused because the
  // delivery site is not one the warehouse serves asks where it goes instead.
  const [siteChoiceFor, setSiteChoiceFor] = React.useState<
    | { kind: 'approve'; whenShort: 'refuse' | 'backorder' }
    | { kind: 'change'; body: ChangeBody }
    | null
  >(null);
  const [changeMode, setChangeMode] = React.useState<'change' | 'issue' | null>(null);
  // Review fix P7: the exchange line whose picker takes focus after a short
  // refusal's "Change replacement", with a token so a second press moves it again.
  const [focusPicker, setFocusPicker] = React.useState<{ lineId: string; token: number } | null>(
    null,
  );
  const [changeShort, setChangeShort] = React.useState<unknown>(null);
  // Fix round 1 (completeness C-3, pattern 20): the last refusal of the open
  // exchange dialog, shown inside it as well as in the toast.
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  // Fix round 1 (verification V1): after Cancel replacement, what to do with
  // what was picked or sent, from the database's answer, until dismissed.
  const [followUp, setFollowUp] = React.useState<string[] | null>(null);
  // Review fix P1: every returns manager reviews a requested exchange; without
  // order approval only the decline is open, and the review starts there
  // (core exchangeReviewOptions / defaultExchangeReviewState). Adding a
  // replacement creates an order, so it needs order approval.
  const reviewViewer = { canApproveOrders: wb.viewer.canApproveOrders };
  // RX-3 fix round 1 (M3): a note-only request starts at Change replacement…,
  // never at "Approve as requested" (off for it); core decides from the line.
  const reviewFor = (lineId: string): ExchangeReviewState => {
    const chosen = reviews[lineId];
    if (chosen) return chosen;
    const x = ex.lines.find((l) => l.id === lineId);
    const returned = x ? (wb.lines.find((l) => l.id === x.returnLineId)?.quantity ?? null) : null;
    return defaultExchangeReviewState(
      reviewViewer,
      x
        ? {
            requestedItemId: x.requestedItemId,
            requestedQuantity: x.requestedQuantity,
            returnedQuantity: returned,
          }
        : undefined,
    );
  };
  const exchangeByReturnLine = new Map(ex.lines.map((x) => [x.returnLineId, x]));
  const canDecideExchange = r.status === 'requested' && wb.viewer.canManageReturns;
  const canAddReplacement = canDecideExchange && wb.viewer.canApproveOrders;
  const loaderFor = (orderRequestLineId: string) => (q: string) =>
    returnExchangeCandidatesAction({ id: r.id, line: orderRequestLineId, q });
  const itemLabelById = (itemId: string): string => {
    for (const x of ex.lines) {
      if (x.approvedItemId === itemId && x.approvedItem)
        return returnLineLabel(x.approvedItem.name ?? 'Item', x.approvedItem.variant);
      if (x.requestedItemId === itemId && x.requestedItem)
        return returnLineLabel(x.requestedItem.name ?? 'Item', x.requestedItem.variant);
    }
    for (const a of Object.values(adds)) if (a?.itemId === itemId && a.label) return a.label;
    for (const v of Object.values(reviews))
      if (v.kind === 'change' && v.itemId === itemId && v.label) return v.label;
    return 'Item';
  };

  // A line with no destination answer (the read failed) has nothing chosen:
  // nothing is sent for it (review fix; never a silent Staging).
  const choiceFor = (l: ReturnWorkbenchLine): RestockChoice =>
    choices[l.id] ??
    (l.restock ? preselectedChoice(l.restock) : unreadDestinationChoice(l.disposition));

  const unappliedLines = wb.lines.filter((l) => !l.applied);
  const allOffered =
    !wb.destinationsUnavailable &&
    unappliedLines.every((l) => (l.restock ? isChoiceOffered(l.restock, choiceFor(l)) : false));
  const lineLabel = (l: ReturnWorkbenchLine): string =>
    returnLineLabel(l.item.name ?? 'Deleted item', l.item.variant);
  // Why the send buttons are disabled: one sentence per line that needs a
  // destination, naming it ("New Hire Shirt, M: Original rack is no longer
  // available: 31-C (archived). Choose a destination.").
  const choiceProblems = wb.destinationsUnavailable
    ? [RETURNS_COPY.destinationsUnavailable]
    : openLines.flatMap((l) => {
        const c = choiceFor(l);
        return c.needsChoice ? [choiceNeededSentence(lineLabel(l), c.needsChoice)] : [];
      });

  // RX-2: what the exchange review still needs before the approval can go.
  const exchangeProblems = canDecideExchange
    ? [
        ...ex.lines
          .filter((x) => x.status === 'requested')
          .map((x) => reviewProblem(x, reviewFor(x.id), reviewViewer))
          .filter((p): p is string => p !== null),
        ...Object.values(adds).flatMap((a) =>
          a && !a.itemId ? [RETURNS_COPY.chooseReplacement] : [],
        ),
      ]
    : [];

  function exchangeDecisions(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const x of ex.lines)
      if (x.status === 'requested') out.push(reviewDecision(x, reviewFor(x.id)));
    for (const [returnLineId, a] of Object.entries(adds)) {
      const d = a ? addReplacementDecision(returnLineId, a) : null;
      if (d) out.push(d);
    }
    return out;
  }

  function setChoice(lineId: string, next: RestockChoice) {
    setChoices((prev) => ({ ...prev, [lineId]: next }));
  }

  /**
   * Every workbench call runs through here (fix round 1, completeness C-2):
   * busy while it is in flight, and freed whatever happens. A call that
   * rejects (a network drop, a deploy's server-action skew) says so, in the
   * open dialog too, and the page redraws; the caller gets null.
   */
  async function guarded<T>(key: string, call: () => Promise<T>): Promise<T | null> {
    setBusy(key);
    setDialogError(null);
    setFollowUp(null);
    try {
      return await call();
    } catch {
      toast.error(RETURN_ERROR_WORDS.internal);
      setDialogError(RETURN_ERROR_WORDS.internal);
      router.refresh();
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function runSteps(
    steps: Array<'approve' | 'receive' | 'process'>,
    extra: Record<string, unknown>,
    key: string,
  ): Promise<Array<{ outcome: string; reason?: string | null }> | null> {
    const res = await guarded(key, () =>
      runReturnStepsAction({
        id: r.id,
        body: { steps, expectedRevision: wb.revision, expectedPlanSeq: wb.planSeq, ...extra },
      }),
    );
    if (!res) return null;
    if (!res.ok) {
      toast.error(res.error.message);
      router.refresh();
      return null;
    }
    const next = res.data.workbench as Workbench;
    adopt(next);
    for (const step of res.data.ran) {
      if (step.outcome === 'refused') {
        if (step.reason === 'replacement_unavailable') {
          // The numbers first (D19), then "Approve, replacement on backorder"
          // or "Change replacement" in the next-step bar.
          setShortDetail(step.detail ?? []);
        }
        toast.error(step.message ?? 'This step could not be completed.');
      } else if (step.outcome === 'already') {
        // "Already closed by Dana": the answer's workbench names who acted
        // (someone else did), never the screen's stale copy (review fix).
        toast.message(
          step.step === 'process'
            ? alreadyClosedSentence(next.return.closedByName, null)
            : step.step === 'receive'
              ? alreadyReceivedSentence(next.return.receivedByName, null)
              : 'Already approved.',
        );
      } else {
        toast.success(
          step.step === 'approve'
            ? // Review fix P23: what the approval created (core, the phone's words too).
              approvalOutcomeLine(
                {
                  status: step.approval?.status ?? null,
                  replacement: step.approval?.replacement ?? null,
                },
                { receiveNow: extra.receiveNow === true },
              )
            : step.step === 'receive'
              ? 'Return received.'
              : 'Return processed.',
        );
      }
    }
    router.refresh();
    return res.data.ran;
  }

  /**
   * Review fix P7: after a short refusal, "Change replacement" switches each
   * short line's review to Change replacement (its item to choose again) and
   * moves focus to the first one's picker; a short added replacement is
   * chosen again too. The numbers give way to the choice.
   */
  function changeShortLines() {
    const short = new Set(shortLines.map((s) => s.itemId));
    let first: string | null = null;
    const nextReviews = { ...reviews };
    for (const x of ex.lines) {
      if (x.status !== 'requested') continue;
      const v = reviewFor(x.id);
      const itemId =
        v.kind === 'change' ? v.itemId : v.kind === 'as_requested' ? x.requestedItemId : null;
      if (!itemId || !short.has(itemId)) continue;
      const rl = wb.lines.find((l) => l.id === x.returnLineId);
      const quantity =
        v.kind === 'change'
          ? v.quantity
          : Math.min(x.requestedQuantity, rl?.quantity ?? x.requestedQuantity);
      nextReviews[x.id] = {
        kind: 'change',
        itemId: null,
        label: null,
        free: null,
        quantity,
        reason: v.kind === 'change' ? v.reason : '',
      };
      first ??= x.id;
    }
    setReviews(nextReviews);
    setAdds((prev) => {
      const next = { ...prev };
      for (const [lineId, a] of Object.entries(prev)) {
        if (a?.itemId && short.has(a.itemId))
          next[lineId] = { ...a, itemId: null, label: null, free: null };
      }
      return next;
    });
    setShortDetail(null);
    if (first) setFocusPicker({ lineId: first, token: Date.now() });
  }

  async function approve(
    whenShort: 'refuse' | 'backorder' = 'refuse',
    site: ReplacementFulfilment | null = null,
  ) {
    if (!allOffered || exchangeProblems.length > 0) return;
    const lines = unappliedLines.map((l) => choiceToDecision(l.id, choiceFor(l)));
    const exchange = exchangeDecisions();
    setShortDetail(null);
    const ran = await runSteps(
      ['approve'],
      {
        approve: {
          lines,
          ...(exchange.length > 0 ? { exchange, replacement: { whenShort, ...(site ?? {}) } } : {}),
        },
        receiveNow: itemIsHere,
      },
      'approve',
    );
    // Desk check F6: the delivery site is not one the warehouse serves: ask
    // where the replacement goes, then send the same approval again with it.
    if (
      ran?.some((s) => s.outcome === 'refused' && s.reason === 'replacement_site_not_available')
    ) {
      setSiteChoiceFor({ kind: 'approve', whenShort });
    }
  }

  // ── RX-2: the replacement actions ──────────────────────────────────────

  function afterReplacement(
    res:
      { ok: true; data: { workbench: unknown } } | { ok: false; error: { message: string } } | null,
    done: string,
  ) {
    if (!res) return false;
    if (!res.ok) {
      toast.error(res.error.message);
      setDialogError(res.error.message);
      router.refresh();
      return false;
    }
    adopt(res.data.workbench as Workbench);
    toast.success(done);
    router.refresh();
    return true;
  }

  async function releaseEarly(reason: string) {
    // The live replacement the workbench shows (desk check F7): a newer one
    // since (a substitution or a re-issue) is return_changed, never released.
    const shownOrderId = ex.replacement?.live ? ex.replacement.orderId : null;
    if (!shownOrderId) {
      // The screen shows no live replacement (its read failed, or it changed):
      // nothing is sent; say so outside the dialog and redraw, never a
      // silent click (the phone's sheet says the same words).
      setReleaseOpen(false);
      toast.error(RETURN_ERROR_WORDS.returnChanged);
      router.refresh();
      return;
    }
    const res = await guarded('release', () =>
      releaseReturnReplacementAction({ id: r.id, orderId: shownOrderId, reason }),
    );
    if (res && res.ok && !res.data.answer.changed) {
      adopt(res.data.workbench as Workbench);
      toast.message(releaseOutcomeLine(res.data.answer));
      setReleaseOpen(false);
      return;
    }
    if (afterReplacement(res, RETURNS_COPY.releasedForPicking)) setReleaseOpen(false);
  }

  async function cancelReplacement(reason: string) {
    // Verification V1: the status the dialog's warnings came from; the
    // database refuses (return_changed) a replacement picked or sent since,
    // and the page redraws into its Staging and driver warnings.
    const shownStatus = replacementFacts.replacementStatus;
    const res = await guarded('cancel_replacement', () =>
      cancelReturnReplacementAction({
        id: r.id,
        body: { expectedRevision: wb.revision, reason, shownStatus },
      }),
    );
    if (res && res.ok) {
      const [done, ...after] = replacementCancelledLines(res.data.answer);
      if (afterReplacement(res, done ?? RETURNS_COPY.replacementCancelledDone))
        setCancelReplacementOpen(false);
      setFollowUp(after.length > 0 ? after : null);
      return;
    }
    afterReplacement(res, RETURNS_COPY.replacementCancelledDone);
  }

  // Desk check F9: after a replacement cancel the exchange ends for good.
  async function closeAsReturnOnly(reason: string) {
    const res = await guarded('close_as_return_only', () =>
      declineReturnReplacementAction({ id: r.id, body: { expectedRevision: wb.revision, reason } }),
    );
    if (afterReplacement(res, RETURNS_COPY.closedAsReturnOnly)) setReturnOnlyOpen(false);
  }

  // RX-4 (0397; RX-2 verification V3): "Close the rest" of a replacement
  // handed over in part, from the RMA, once the returned item is in. It names
  // the status the screen showed; a rest resumed or closed since is refused
  // (return_changed or replacement_not_backordered) and the page redraws.
  async function closeReplacementRest(reason: string) {
    const shownStatus = replacementFacts.replacementStatus;
    const res = await guarded('close_replacement_rest', () =>
      closeReturnReplacementRestAction({
        id: r.id,
        body: { expectedRevision: wb.revision, reason, shownStatus },
      }),
    );
    if (res && res.ok && !res.data.answer.changed) {
      adopt(res.data.workbench as Workbench);
      toast.message(RETURNS_COPY.closedReplacementRestAlready);
      setCloseRestOpen(false);
      return;
    }
    if (afterReplacement(res, RETURNS_COPY.closedReplacementRest)) setCloseRestOpen(false);
  }

  async function changeReplacement(body: ChangeBody, site: ReplacementFulfilment | null = null) {
    setChangeShort(null);
    const res = await guarded('change_replacement', () =>
      changeReturnReplacementAction({
        id: r.id,
        body: {
          expectedRevision: wb.revision,
          lines: body.lines,
          reason: body.reason,
          whenShort: body.whenShort,
          ...(site ? { replacement: site } : {}),
        },
      }),
    );
    if (!res) return;
    if (!res.ok && res.error.details?.reason === 'replacement_unavailable') {
      setChangeShort(res.error.details.detail ?? []);
      toast.error(res.error.message);
      return;
    }
    if (!res.ok && res.error.details?.reason === 'replacement_site_not_available') {
      // Desk check F6: ask where it goes, then send the same change again with it.
      toast.error(res.error.message);
      setSiteChoiceFor({ kind: 'change', body });
      return;
    }
    if (
      afterReplacement(
        res,
        changeMode === 'issue' ? 'New replacement issued.' : 'Replacement changed.',
      )
    )
      setChangeMode(null);
  }

  async function prepareReplacement() {
    const res = await guarded('prepare', () => prepareReturnReplacementAction({ id: r.id }));
    if (!res) return;
    if (!res.ok) {
      toast.error(res.error.message);
      router.refresh();
      return;
    }
    adopt(res.data.workbench as Workbench);
    const refused = res.data.answer.ran.find((s) => s.outcome === 'refused');
    if (refused) toast.error(refused.message ?? RETURNS_COPY.prepareStopped);
    else if (res.data.answer.status === 'staged_for_delivery')
      toast.success(RETURNS_COPY.prepareStagedDelivery);
    else if (res.data.answer.status === 'staged_for_pickup')
      toast.success(RETURNS_COPY.prepareStaged);
    else toast.message(RETURNS_COPY.prepareUnconfirmed);
    router.refresh();
  }

  async function receive() {
    await runSteps(['receive'], {}, 'receive');
  }

  async function processReturn() {
    if (!allOffered) return;
    // Only destinations changed at processing travel with the close (C-9).
    const changed = openLines
      .filter((l) => !planMatches(l, choiceFor(l)))
      .map((l) => choiceToDecision(l.id, choiceFor(l)));
    await runSteps(
      ['process'],
      { process: changed.length > 0 ? { lines: changed } : null },
      'process',
    );
  }

  async function saveDestinations() {
    if (!allOffered) return;
    const changed = openLines
      .filter((l) => !planMatches(l, choiceFor(l)))
      .map((l) => choiceToDecision(l.id, choiceFor(l)));
    if (changed.length === 0) {
      setMode('idle');
      return;
    }
    const res = await guarded('plan', () =>
      planReturnDispositionsAction({ id: r.id, lines: changed }),
    );
    if (!res) return;
    if (!res.ok) {
      toast.error(res.error.message);
      router.refresh();
      return;
    }
    toast.success('Destination saved.');
    setMode('idle');
    router.refresh();
  }

  async function deny() {
    const res = await guarded('deny', () => denyReturnAction({ id: r.id, reason: denyReason }));
    if (!res) return;
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(res.data.changed ? 'Return denied.' : 'Already denied.');
    setDenyOpen(false);
    setDenyReason('');
    router.refresh();
  }

  async function cancel() {
    const res = await guarded('cancel', () =>
      cancelReturnAction({
        id: r.id,
        expectedRevision: wb.revision,
        reason: cancelReason.trim() || null,
      }),
    );
    if (!res) return;
    if (!res.ok) {
      toast.error(res.error.message);
      // A stale screen (0396: the replacement was picked or left meanwhile,
      // or the return changed): its words, the confirm closes and the page
      // redraws from server truth.
      if (STALE_SCREEN_REASONS.has(String(res.error.details?.reason ?? ''))) {
        setCancelOpen(false);
        setCancelReason('');
      }
      router.refresh();
      return;
    }
    toast.success(res.data.changed ? 'Return cancelled.' : 'Already cancelled.');
    setCancelOpen(false);
    setCancelReason('');
    router.refresh();
  }

  async function buyLabel() {
    const res = await guarded('label', () => buyReturnLabelAction(r.id));
    if (!res) return;
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Return label purchased.');
    router.refresh();
  }

  function onAction(a: ReturnAction) {
    setDialogError(null);
    switch (a) {
      case 'approve':
      case 'approve_and_receive':
        void approve();
        return;
      case 'receive':
        void receive();
        return;
      case 'process':
        void processReturn();
        return;
      case 'deny':
        setDenyOpen(true);
        return;
      case 'cancel':
        setCancelOpen(true);
        return;
      case 'change_destination':
        setMode((m) => (m === 'change_destination' ? 'idle' : 'change_destination'));
        return;
      case 'release_early':
        setReleaseOpen(true);
        return;
      case 'cancel_replacement':
        setCancelReplacementOpen(true);
        return;
      case 'close_as_return_only':
        setReturnOnlyOpen(true);
        return;
      case 'close_replacement_rest':
        setCloseRestOpen(true);
        return;
      case 'change_replacement':
        setChangeShort(null);
        setChangeMode('change');
        return;
      case 'issue_replacement':
        setChangeShort(null);
        setChangeMode('issue');
        return;
      case 'get_replacement_ready':
        void prepareReplacement();
        return;
      case 'open_replacement':
        // The replacement's own page: its signature actions are the one
        // signature implementation.
        if (ex.replacement) router.push(`/dashboard/orders/${ex.replacement.orderId}`);
        return;
      case 'hand_over':
        // Review fix (counter taps): the replacement's page with the Physical
        // signature dialog ready; the page opens it once, only when the order
        // is ready for the hand-over and the viewer may confirm it.
        if (ex.replacement)
          router.push(`/dashboard/orders/${ex.replacement.orderId}?sign=physical`);
        return;
    }
  }

  // The lines a change (approved) or a re-issue (cancelled by a replacement
  // cancel) acts on.
  const changeLines: ChangeLineInput[] = ex.lines
    .filter((x) =>
      changeMode === 'issue'
        ? x.status === 'cancelled' && x.approvedItemId
        : x.status === 'approved',
    )
    .map((x) => {
      const rl = wb.lines.find((l) => l.id === x.returnLineId);
      return {
        exchangeLineId: x.id,
        orderRequestLineId: rl?.orderRequestLineId ?? '',
        returnedLabel: rl ? lineLabel(rl) : 'Item',
        returnedQty: rl?.quantity ?? x.requestedQuantity,
        currentItemId: x.approvedItemId ?? x.requestedItemId,
        currentQuantity: x.approvedQuantity ?? x.requestedQuantity,
      };
    });
  const shortLines = Array.isArray(shortDetail)
    ? replacementShortItems(shortDetail as Array<Record<string, unknown>>)
    : [];
  // Review fix P2: what happens to the live replacement, in core's words, for
  // the Cancel return and Cancel replacement confirms.
  const liveReplacement = ex.replacement?.live ? ex.replacement : null;
  const replacementFacts = {
    replacementStatus: liveReplacement?.status ?? null,
    anythingHandedOver: (liveReplacement?.lines ?? []).some((l) => l.fulfilled > 0),
    replacementOrderNumber: liveReplacement?.orderNumber ?? null,
    held: liveReplacement ? liveReplacement.held : null,
  };
  const cancelReturnWords = exchangeActionConsequences('cancel', replacementFacts).map(
    (c) => c.text,
  );

  const showPickers =
    r.status === 'requested' || r.status === 'received' || mode === 'change_destination';
  // "When processed, … goes back to 31-C." only while the return can still be
  // processed (RX-3 fix round 1, L8): never on a cancelled or denied RMA.
  const planCanHappen =
    r.status === 'requested' || r.status === 'approved' || r.status === 'received';
  const editable = wb.viewer.canManageReturns && busy === null;
  const processLabel =
    r.status === 'received' && openLines.length === 1 && openLines[0]!.restock
      ? processLabelFor(openLines[0]!.restock, choiceFor(openLines[0]!))
      : null;
  // Fix round 1 (verification L3): a viewer who can only decline the
  // exchange approves the return, so the button never says "& exchange".
  const labelOpts = { hasExchange, canApproveOrders: wb.viewer.canApproveOrders };
  const primaryLabel = (a: ReturnAction): string =>
    a === 'process' && processLabel ? processLabel.button : returnActionLabel(a, labelOpts);
  const primaryDisabled = (a: ReturnAction): boolean =>
    busy !== null ||
    ((a === 'process' || a === 'approve' || a === 'approve_and_receive') && !allOffered) ||
    ((a === 'approve' || a === 'approve_and_receive') && exchangeProblems.length > 0);
  const secondaryDisabled = (a: ReturnAction): boolean =>
    busy !== null || (a === 'change_destination' && wb.destinationsUnavailable);
  // Review fix P18: "Get replacement ready" draws stock and stages the order,
  // so what it does is said under it first (nothing prints).
  const readyHelpId = React.useId();
  const offersReady =
    actions.primary === 'get_replacement_ready' ||
    actions.secondary.includes('get_replacement_ready');
  // RX-2 review fix P17 (built in RX-3; plan 3.10, D28): from 14 days after
  // approval, while the returned item is still out and the replacement waits
  // for it, a viewer offered Cancel replacement is told how long it has waited
  // and what the two buttons that end the wait do (core stillWaitingPrompt:
  // nothing expires on its own). The days come from this browser's clock once
  // hydrated, so the server's render never disagrees with it (React #418).
  const hydrated = useHydrated();
  const stillWaitingId = React.useId();
  const stillWaiting = hydrated
    ? stillWaitingPrompt({
        status: r.status,
        exchangeStatus: ex.status,
        waitingDays: returnWaitingDays(r.status, r.approvedAt),
        offered: [actions.primary, ...actions.secondary],
        held: liveReplacement ? liveReplacement.held : null,
      })
    : null;
  const describedBy = (a: ReturnAction): string | undefined =>
    a === 'get_replacement_ready'
      ? readyHelpId
      : stillWaiting && (a === 'cancel_replacement' || a === 'cancel')
        ? stillWaitingId
        : undefined;

  // What the next-step bar holds: its controls row, and the notes under it.
  const itemIsHereId = React.useId();
  const showItemIsHere = r.status === 'requested' && wb.viewer.canManageReturns;
  const hasControls = Boolean(actions.primary) || actions.secondary.length > 0 || showItemIsHere;
  const noSteps = !actions.primary && !actions.readOnlyReason && actions.secondary.length === 0;
  const showChoiceProblems =
    wb.viewer.canManageReturns &&
    choiceProblems.length > 0 &&
    (Boolean(actions.primary) || actions.secondary.length > 0);
  const showShort = shortLines.length > 0 && r.status === 'requested';
  const hasNotes =
    offersReady ||
    Boolean(stillWaiting) ||
    followUp !== null ||
    Boolean(actions.readOnlyReason) ||
    noSteps ||
    showChoiceProblems ||
    exchangeProblems.length > 0 ||
    showShort;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        back={<PageHeaderBackLink href="/dashboard/returns">← Back to returns</PageHeaderBackLink>}
        title={r.returnNumber ?? 'Return'}
        titleAside={
          <div className="flex flex-wrap items-center gap-1.5">
            <ReturnStatusBadge status={r.status as never} />
            <Badge variant="outline">
              {hasExchange ? RETURNS_COPY.typeExchange : RETURNS_COPY.typeReturn}
            </Badge>
            <Badge variant="outline">
              {r.source === 'requester'
                ? RETURNS_COPY.requestedByRequester
                : RETURNS_COPY.createdByStaff}
            </Badge>
          </div>
        }
        subline={
          <p>
            Against order{' '}
            <Link
              href={`/dashboard/orders/${r.orderRequestId}`}
              className="text-foreground font-mono font-medium tabular-nums underline-offset-2 hover:underline"
            >
              {formatOrderNumber(r.orderNumber) ?? r.orderRequestId.slice(0, 8)}
            </Link>
            {r.requesterName || r.requesterEmail ? (
              <> · {r.requesterName ?? r.requesterEmail}</>
            ) : null}
            {r.warehouseName ? <> · {r.warehouseName}</> : null}
            {r.reasonCode ? <> · {returnReasonLabel(r.reasonCode)}</> : null}
          </p>
        }
      />

      {/* Next-step bar: the one card that commits the work in front of you
          (the Cycle counts "post" footer is its cue). Its controls on one
          wrapping row (the ink primary first, then the secondaries, "The
          item is here" at the end), then what the page has to say about
          them under a hairline. */}
      <section className={cn(cardClass, 'overflow-hidden')} aria-label="Next step">
        {hasControls ? (
          <div className="flex flex-wrap items-center gap-2 px-[18px] py-3.5">
            {actions.primary ? (
              <Button
                variant="default"
                onClick={() => onAction(actions.primary!)}
                disabled={primaryDisabled(actions.primary)}
                aria-describedby={describedBy(actions.primary)}
              >
                {busy && busy === stepKey(actions.primary) ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                {primaryLabel(actions.primary)}
              </Button>
            ) : null}
            {actions.secondary.map((a) => (
              <Button
                key={a}
                variant="outline"
                className={a === 'deny' ? 'text-destructive hover:text-destructive' : undefined}
                onClick={() => onAction(a)}
                disabled={secondaryDisabled(a)}
                aria-describedby={describedBy(a)}
              >
                {a === 'change_destination' && mode === 'change_destination'
                  ? 'Keep destination'
                  : RETURN_ACTION_LABELS[a]}
              </Button>
            ))}
            {showItemIsHere ? (
              <div className="flex min-w-0 items-start gap-2.5 sm:ml-auto">
                <Switch
                  id={itemIsHereId}
                  checked={itemIsHere}
                  onCheckedChange={setItemIsHere}
                  aria-labelledby={`${itemIsHereId}-label`}
                  aria-describedby={`${itemIsHereId}-help`}
                  className="mt-0.5"
                />
                <span className="min-w-0 text-[13px] leading-5">
                  <label
                    id={`${itemIsHereId}-label`}
                    htmlFor={itemIsHereId}
                    className="cursor-pointer font-medium"
                  >
                    {RETURNS_COPY.itemIsHere}
                  </label>
                  <span
                    id={`${itemIsHereId}-help`}
                    className="text-muted-foreground block max-w-xs text-[12px] leading-[18px]"
                  >
                    {RETURNS_COPY.itemIsHereHelp}
                  </span>
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
        {hasNotes ? (
          <div
            className={cn('space-y-2.5 px-[18px] py-3', hasControls && 'border-border border-t')}
          >
            {offersReady ? (
              <p id={readyHelpId} className="text-muted-foreground text-[12.5px]">
                {RETURNS_COPY.getReplacementReadyHelp}
              </p>
            ) : null}
            {stillWaiting ? (
              <p
                id={stillWaitingId}
                className="flex items-start gap-1.5 text-[13px]"
                data-testid="still-waiting"
              >
                <Clock className="text-warning mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>{stillWaiting}</span>
              </p>
            ) : null}
            {/* Verification V1: after Cancel replacement, what to do with what
                was picked or sent (the database's answer), until dismissed. */}
            {followUp ? (
              <div
                className="border-warning/40 bg-warning-wash space-y-2 rounded-md border p-3"
                role="alert"
                aria-label="After cancelling the replacement"
              >
                <ul className="space-y-0.5 text-[13px]">
                  {followUp.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <Button variant="outline" size="sm" onClick={() => setFollowUp(null)}>
                  Done
                </Button>
              </div>
            ) : null}
            {/* Why nothing, or less, is offered (RX-2: the replacement actions
                need order approval while the return actions stay). */}
            {actions.readOnlyReason ? (
              <p className="text-muted-foreground text-[13px]">{actions.readOnlyReason}</p>
            ) : null}
            {noSteps ? (
              <p className="text-muted-foreground text-[13px]">No further steps for this return.</p>
            ) : null}
            {showChoiceProblems ? (
              <ul
                className="text-destructive space-y-0.5 text-[13px]"
                role="status"
                aria-label="Choose a destination"
              >
                {choiceProblems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
            {exchangeProblems.length > 0 ? (
              <ul
                className="text-destructive space-y-0.5 text-[13px]"
                role="status"
                aria-label="Before approving the exchange"
              >
                {[...new Set(exchangeProblems)].map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
            {showShort ? (
              <div className="space-y-2" role="alert" aria-label="Not in stock">
                <ul className="text-destructive space-y-0.5 text-[13px]">
                  {shortLines.map((sItem) => (
                    <li key={sItem.itemId}>
                      {replacementShortLine(
                        itemLabelById(sItem.itemId),
                        sItem.available,
                        sItem.needed,
                      )}
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => void approve('backorder')}
                    disabled={busy !== null}
                  >
                    {RETURNS_COPY.approveReplacementOnBackorder}
                  </Button>
                  <Button variant="outline" onClick={changeShortLines} disabled={busy !== null}>
                    {RETURNS_COPY.changeReplacement}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {hasExchange ? (
        <ReplacementOrderSection
          exchange={ex}
          canReadDecisions={wb.viewer.canReadDecisions}
          returnStatus={r.status}
        />
      ) : null}

      {r.status === 'requested' && wb.viewer.canManageReturns ? (
        <DetailSection
          title="What happens when you approve"
          aria-label="What happens when you approve"
        >
          <ul className="list-disc space-y-1 pl-5 text-[13.5px] leading-5 marker:text-[var(--ed-ink-4)]">
            {approvalPreviewLines({
              lines: openLines.map((l) => ({
                returnedLabel: lineLabel(l),
                destination: processLabelFor(l.restock!, choiceFor(l)).destination,
              })),
              exchanges: [
                ...ex.lines
                  .filter((x) => x.status === 'requested')
                  .map((x) => {
                    const rl = wb.lines.find((l) => l.id === x.returnLineId);
                    const v = reviewFor(x.id);
                    const changed = v.kind === 'change';
                    return {
                      returnedLabel: rl ? lineLabel(rl) : 'Item',
                      decision:
                        v.kind === 'decline'
                          ? ('decline' as const)
                          : v.kind === 'change' && !v.itemId
                            ? ('pending' as const)
                            : ('approve' as const),
                      replacementLabel: changed
                        ? v.label
                        : x.requestedItem
                          ? returnLineLabel(x.requestedItem.name ?? 'Item', x.requestedItem.variant)
                          : null,
                      quantity: changed ? v.quantity : x.requestedQuantity,
                      available: changed ? v.free : x.requestedFree,
                    };
                  }),
                ...Object.entries(adds).flatMap(([lineId, a]) => {
                  const rl = wb.lines.find((l) => l.id === lineId);
                  return a?.itemId
                    ? [
                        {
                          returnedLabel: rl ? lineLabel(rl) : 'Item',
                          decision: 'add' as const,
                          replacementLabel: a.label,
                          quantity: a.quantity,
                          available: a.free,
                        },
                      ]
                    : [];
                }),
              ],
              itemIsHere,
            }).map((sentence) => (
              <li key={sentence}>{sentence}</li>
            ))}
          </ul>
        </DetailSection>
      ) : null}

      {/* RETURNING: each returned line's card, and its REPLACEMENT beside it
          from md up (the two-column pairing). */}
      <section aria-label={RETURNS_COPY.returning} className="space-y-2.5">
        <h2 className={cn(eyebrowClass, 'pt-1')}>{RETURNS_COPY.returning}</h2>
        {wb.lines.map((l) => {
          const name = l.item.name ?? 'Deleted item';
          const x = exchangeByReturnLine.get(l.id) ?? null;
          const add = adds[l.id] ?? null;
          const offerAdd = !x && canAddReplacement && ex.createEnabled;
          return (
            <div
              key={l.id}
              className={cn('grid items-start gap-3', x || add ? 'md:grid-cols-2' : '')}
            >
              <article
                className={cn(
                  cardClass,
                  'grid grid-cols-[64px_minmax(0,1fr)] gap-4 p-4 sm:grid-cols-[96px_minmax(0,1fr)]',
                )}
              >
                {/* The photo on white in a hairline frame (DESIGN-SPEC 6.14),
                    the hatch when there is none or it fails. */}
                <span className="border-border relative block size-16 overflow-hidden rounded-lg border bg-white sm:size-24">
                  <PatternPhoto src={l.item.thumbUrl ?? l.item.imageUrl ?? null} alt={name} />
                </span>
                <div className="min-w-0 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 space-y-0.5">
                      <Link
                        href={`/dashboard/inventory/${l.itemId}`}
                        className="text-foreground block truncate text-[14px] font-medium leading-5 underline-offset-2 hover:underline"
                      >
                        {name}
                      </Link>
                      <p className="text-muted-foreground text-[12.5px]">
                        {[l.item.variant, l.item.sku].filter(Boolean).join(' · ')}
                      </p>
                      <p className="text-[13px] tabular-nums">{qtyReturningLabel(l.quantity)}</p>
                    </div>
                    <Badge variant={l.applied ? 'success' : 'outline'}>{l.inboundState}</Badge>
                  </div>
                  {l.restock && showPickers ? (
                    <RestockDestinationPicker
                      line={l.restock}
                      choice={choiceFor(l)}
                      onChange={(next) => setChoice(l.id, next)}
                      disabled={!editable}
                      reasonCode={r.reasonCode}
                      itemLabel={name}
                    />
                  ) : l.restock && planCanHappen ? (
                    <p className="text-muted-foreground text-[13px]">
                      {plannedSentence(l.restock, lineLabel(l))}
                    </p>
                  ) : null}
                  {r.status === 'received' && l.restock ? (
                    <p className="text-muted-foreground text-[12.5px]">
                      {processingHint(l, choiceFor(l), lineLabel(l))}
                    </p>
                  ) : null}
                  {offerAdd && !add ? (
                    <AddReplacement
                      returnedLabel={lineLabel(l)}
                      returnedQty={l.quantity}
                      state={null}
                      onChange={(next) => setAdds((prev) => ({ ...prev, [l.id]: next }))}
                      load={loaderFor(l.orderRequestLineId)}
                      disabled={busy !== null}
                    />
                  ) : null}
                </div>
              </article>
              {x ? (
                <ReplacementSide
                  line={x}
                  replacement={ex.replacement}
                  returnedLabel={lineLabel(l)}
                  returnedQty={l.quantity}
                  review={
                    canDecideExchange && x.status === 'requested' ? reviewFor(x.id) : undefined
                  }
                  onReview={(next) => setReviews((prev) => ({ ...prev, [x.id]: next }))}
                  load={loaderFor(l.orderRequestLineId)}
                  disabled={busy !== null}
                  canApproveOrders={wb.viewer.canApproveOrders}
                  focusPickerToken={focusPicker?.lineId === x.id ? focusPicker.token : null}
                />
              ) : add ? (
                <AddReplacement
                  returnedLabel={lineLabel(l)}
                  returnedQty={l.quantity}
                  state={add}
                  onChange={(next) => setAdds((prev) => ({ ...prev, [l.id]: next }))}
                  load={loaderFor(l.orderRequestLineId)}
                  disabled={busy !== null}
                />
              ) : null}
            </div>
          );
        })}
        {mode === 'change_destination' ? (
          <div className="flex gap-2">
            <Button
              variant="default"
              onClick={saveDestinations}
              disabled={busy !== null || !allOffered}
            >
              {busy === 'plan' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Save destination
            </Button>
          </div>
        ) : null}
      </section>

      {r.notes ? (
        <DetailSection title="Notes">
          <p className="whitespace-pre-wrap text-[13.5px] leading-5">{r.notes}</p>
        </DetailSection>
      ) : null}

      {r.denialReason && r.status === 'denied' ? (
        <DetailSection
          title={<span className="text-destructive">Denied</span>}
          className="border-destructive/40"
        >
          <p className="whitespace-pre-wrap text-[13.5px] leading-5">{r.denialReason}</p>
        </DetailSection>
      ) : null}

      {canManageShipping && (r.status === 'approved' || r.status === 'received' || returnLabel) ? (
        <ReturnLabelSection
          returnLabel={returnLabel}
          canBuy={!returnLabel && (r.status === 'approved' || r.status === 'received')}
          busy={busy === 'label'}
          disabled={busy !== null}
          onBuy={buyLabel}
        />
      ) : null}

      {/* The chain, oldest first as the service sorts it: the activity-row
          recipe of the shared timeline (DESIGN-SPEC 6.16, the reference's
          Movement history card), what happened and who on the left, when on
          the right. A long decision sentence wraps, never cut. */}
      <DetailSection title="History" aria-label="History" flush>
        <Timeline variant="rows">
          {wb.chain.map((e, i) => (
            <li
              key={`${e.at}-${i}`}
              data-slot="timeline-row"
              className="border-border grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-4 border-b px-[18px] py-2.5 text-[13.5px] leading-5 last:border-b-0"
            >
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {e.label}
                {e.actorName ? (
                  <span className="text-muted-foreground"> · {e.actorName}</span>
                ) : null}
              </span>
              <time
                dateTime={e.at}
                className="text-muted-foreground whitespace-nowrap text-[12px] tabular-nums leading-5"
                title={e.at}
                // The server renders this before the browser hydrates it; a
                // minute between the two changes the words ("3 minutes ago"
                // to "4"). Tolerate it instead of React error #418.
                suppressHydrationWarning
              >
                {formatRelative(e.at)}
              </time>
            </li>
          ))}
          {wb.chain.length === 0 ? (
            <li className="text-muted-foreground px-[18px] py-3 text-[13.5px]">No history yet.</li>
          ) : null}
        </Timeline>
      </DetailSection>

      {/* Deny */}
      <Dialog
        open={denyOpen}
        onOpenChange={(v) => {
          if (busy === 'deny') return;
          setDenyOpen(v);
          if (!v) setDenyReason('');
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Deny this return?</DialogTitle>
            <DialogDescription>
              Nothing moves.{' '}
              {/* Only a requester's RMA tells anyone (review fix): a staff RMA notifies nobody. */}
              {r.source === 'requester'
                ? RETURNS_COPY.denyReasonHelp
                : RETURNS_COPY.denyReasonHelpInternal}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="return-deny-reason">{RETURNS_COPY.denyReasonLabel}</Label>
            <Textarea
              id="return-deny-reason"
              value={denyReason}
              onChange={(e) => setDenyReason(e.target.value)}
              rows={3}
              maxLength={RETURN_REASON_MAX}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDenyOpen(false)} disabled={busy === 'deny'}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              onClick={deny}
              disabled={busy === 'deny' || !denyReason.trim()}
            >
              {busy === 'deny' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {RETURNS_COPY.deny}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel */}
      <Dialog
        open={cancelOpen}
        onOpenChange={(v) => {
          if (busy === 'cancel') return;
          setCancelOpen(v);
          if (!v) setCancelReason('');
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel this return?</DialogTitle>
            <DialogDescription>
              {cancelReturnWords.length > 0
                ? cancelReturnWords.join(' ')
                : 'Nothing moves. The return closes as cancelled.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="return-cancel-reason">
              {ex.hasApprovedExchange
                ? RETURNS_COPY.cancelReturnReasonRequired
                : RETURNS_COPY.cancelReasonLabel}
            </Label>
            <Textarea
              id="return-cancel-reason"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              rows={3}
              maxLength={RETURN_REASON_MAX}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCancelOpen(false)}
              disabled={busy === 'cancel'}
            >
              Keep it
            </Button>
            <Button
              variant="destructive"
              onClick={cancel}
              disabled={busy === 'cancel' || (ex.hasApprovedExchange && !cancelReason.trim())}
            >
              {busy === 'cancel' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {RETURNS_COPY.cancelReturn}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {hasExchange ? (
        <>
          <ReleaseEarlyDialog
            open={releaseOpen}
            onOpenChange={(v) => {
              setReleaseOpen(v);
              setDialogError(null);
            }}
            busy={busy === 'release'}
            error={dialogError}
            onConfirm={releaseEarly}
          />
          <CancelReplacementDialog
            open={cancelReplacementOpen}
            onOpenChange={(v) => {
              setCancelReplacementOpen(v);
              setDialogError(null);
            }}
            busy={busy === 'cancel_replacement'}
            error={dialogError}
            consequences={exchangeActionConsequences('cancel_replacement', replacementFacts)}
            onConfirm={cancelReplacement}
          />
          {/* The two keyed dialogs are siblings: their keys must never be
              equal. They were ('change' while a change was open, 'closed'
              when idle), and React then left a closed site dialog on
              screen after a change refused for its site. */}
          <SiteChoiceDialog
            key={siteChoiceFor ? `site-choice-${siteChoiceFor.kind}` : 'site-choice-closed'}
            open={siteChoiceFor !== null}
            onOpenChange={(v) => {
              if (!v) setSiteChoiceFor(null);
            }}
            busy={busy === 'approve' || busy === 'change_replacement'}
            sites={ex.deliverySites ?? []}
            onChoose={(site) => {
              const pending = siteChoiceFor;
              setSiteChoiceFor(null);
              if (pending?.kind === 'approve') void approve(pending.whenShort, site);
              else if (pending?.kind === 'change') void changeReplacement(pending.body, site);
            }}
          />
          <CloseAsReturnOnlyDialog
            open={returnOnlyOpen}
            onOpenChange={(v) => {
              setReturnOnlyOpen(v);
              setDialogError(null);
            }}
            busy={busy === 'close_as_return_only'}
            error={dialogError}
            onConfirm={closeAsReturnOnly}
          />
          <CloseReplacementRestDialog
            open={closeRestOpen}
            onOpenChange={(v) => {
              setCloseRestOpen(v);
              setDialogError(null);
            }}
            busy={busy === 'close_replacement_rest'}
            error={dialogError}
            onConfirm={closeReplacementRest}
          />
          <ChangeReplacementDialog
            key={changeMode ? `change-replacement-${changeMode}` : 'change-replacement-closed'}
            open={changeMode !== null}
            onOpenChange={(v) => {
              if (!v) setChangeMode(null);
              setDialogError(null);
            }}
            busy={busy === 'change_replacement'}
            error={dialogError}
            mode={changeMode ?? 'change'}
            lines={changeLines}
            loaderFor={loaderFor}
            shortDetail={changeShort}
            itemLabel={itemLabelById}
            onConfirm={changeReplacement}
          />
        </>
      ) : null}
    </div>
  );
}

function stepKey(a: ReturnAction): string {
  if (a === 'approve_and_receive') return 'approve';
  if (a === 'get_replacement_ready') return 'prepare';
  return a;
}

function initialChoices(lines: ReturnWorkbenchLine[]): Record<string, RestockChoice> {
  const out: Record<string, RestockChoice> = {};
  for (const l of lines) if (l.restock) out[l.id] = preselectedChoice(l.restock);
  return out;
}

/** True when the choice equals the line's live plan (or its legacy default). */
function planMatches(l: ReturnWorkbenchLine, choice: RestockChoice): boolean {
  return sameChoice(liveChoice(l.restock ?? { plan: null, disposition: l.disposition }), choice);
}

function processingHint(l: ReturnWorkbenchLine, choice: RestockChoice, label: string): string {
  const p = processLabelFor(l.restock!, choice);
  if (p.destination.kind === 'rack') return RETURNS_COPY.processToRackHint(p.destination.rack);
  if (p.destination.kind === 'staging') return RETURNS_COPY.processToStagingHint;
  if (p.destination.kind === 'choose') return whenProcessedSentence(p.destination, label);
  return RETURNS_COPY.processScrapHint;
}

function ReturnLabelSection({
  returnLabel,
  canBuy,
  busy,
  disabled,
  onBuy,
}: {
  returnLabel: WorkbenchReturnLabel | null;
  canBuy: boolean;
  busy: boolean;
  disabled: boolean;
  onBuy: () => void;
}) {
  return (
    <DetailSection
      title="Return label"
      flush
      aside={
        canBuy ? (
          <Button variant="outline" size="sm" onClick={onBuy} disabled={disabled}>
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Truck className="h-3.5 w-3.5" />
            )}
            Buy return label
          </Button>
        ) : null
      }
    >
      <p className="text-muted-foreground px-[18px] py-3 text-[12.5px]">
        A reverse carrier label so the item ships back to your warehouse.
      </p>
      {returnLabel ? (
        <>
          <KeyValueList className="border-border border-t">
            <KeyValueRow label="Carrier">
              {returnLabel.carrier ?? '—'}
              {returnLabel.service ? (
                <span className="text-muted-foreground"> · {returnLabel.service}</span>
              ) : null}
            </KeyValueRow>
            <KeyValueRow label="Tracking #" valueClassName="font-mono text-[12.5px]">
              {returnLabel.tracking_url && returnLabel.tracking_code ? (
                <a
                  href={returnLabel.tracking_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                >
                  {returnLabel.tracking_code}
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                (returnLabel.tracking_code ?? '—')
              )}
            </KeyValueRow>
            {returnLabel.rate_cents != null ? (
              <KeyValueRow label="Cost">
                {formatCurrency(returnLabel.rate_cents / 100, returnLabel.currency ?? 'USD')}
              </KeyValueRow>
            ) : null}
          </KeyValueList>
          {returnLabel.label_url ? (
            <div className="border-border border-t px-[18px] py-3">
              <Button variant="outline" size="sm" asChild>
                <a href={returnLabel.label_url} target="_blank" rel="noopener noreferrer">
                  <FileDown className="h-3.5 w-3.5" />
                  Download return label
                </a>
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </DetailSection>
  );
}
