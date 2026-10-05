'use client';

import { ExternalLink, FileDown, Loader2, Truck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  AddReplacement,
  CancelReplacementDialog,
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
import { ReturnStatusBadge } from '@/components/returns/return-status-badge';
import { RestockDestinationPicker } from '@/components/returns/restock-destination-picker';
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
import { Textarea } from '@/components/ui/textarea';
import { cn, formatCurrency, formatRelative } from '@/lib/utils';
import {
  buyReturnLabelAction,
  cancelReturnAction,
  cancelReturnReplacementAction,
  changeReturnReplacementAction,
  denyReturnAction,
  planReturnDispositionsAction,
  prepareReturnReplacementAction,
  releaseReturnReplacementAction,
  returnExchangeCandidatesAction,
  runReturnStepsAction,
} from '@/server/actions/returns';
import type { ReturnWorkbenchExchange } from '@/server/services/returns-exchange-workbench';
import type { ReturnWorkbench as Workbench, ReturnWorkbenchLine } from '@/server/services/returns-workbench';

import {
  addReplacementDecision,
  alreadyClosedSentence,
  alreadyReceivedSentence,
  approvalPreviewLines,
  availableReturnActions,
  choiceNeededSentence,
  choiceToDecision,
  formatOrderNumber,
  isChoiceOffered,
  liveChoice,
  plannedSentence,
  preselectedChoice,
  processLabelFor,
  qtyReturningLabel,
  releaseOutcomeLine,
  returnActionLabel,
  returnLineLabel,
  replacementShortItems,
  replacementShortLine,
  RETURN_ACTION_LABELS,
  RETURN_REASON_MAX,
  RETURNS_COPY,
  returnReasonLabel,
  sameChoice,
  unreadDestinationChoice,
  whenProcessedSentence,
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
  const [choices, setChoices] = React.useState<Record<string, RestockChoice>>(() => initialChoices(workbench.lines));
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
  const [changeMode, setChangeMode] = React.useState<'change' | 'issue' | null>(null);
  const [changeShort, setChangeShort] = React.useState<unknown>(null);
  const reviewFor = (lineId: string): ExchangeReviewState => reviews[lineId] ?? { kind: 'as_requested' };
  const exchangeByReturnLine = new Map(ex.lines.map((x) => [x.returnLineId, x]));
  const canDecideExchange = r.status === 'requested' && wb.viewer.canManageReturns && wb.viewer.canApproveOrders;
  const loaderFor = (orderRequestLineId: string) => (q: string) =>
    returnExchangeCandidatesAction({ id: r.id, line: orderRequestLineId, q });
  const itemLabelById = (itemId: string): string => {
    for (const x of ex.lines) {
      if (x.approvedItemId === itemId && x.approvedItem) return returnLineLabel(x.approvedItem.name ?? 'Item', x.approvedItem.variant);
      if (x.requestedItemId === itemId && x.requestedItem) return returnLineLabel(x.requestedItem.name ?? 'Item', x.requestedItem.variant);
    }
    for (const a of Object.values(adds)) if (a?.itemId === itemId && a.label) return a.label;
    for (const v of Object.values(reviews)) if (v.kind === 'change' && v.itemId === itemId && v.label) return v.label;
    return 'Item';
  };

  // A line with no destination answer (the read failed) has nothing chosen:
  // nothing is sent for it (review fix; never a silent Staging).
  const choiceFor = (l: ReturnWorkbenchLine): RestockChoice =>
    choices[l.id] ?? (l.restock ? preselectedChoice(l.restock) : unreadDestinationChoice(l.disposition));

  const unappliedLines = wb.lines.filter((l) => !l.applied);
  const allOffered =
    !wb.destinationsUnavailable && unappliedLines.every((l) => (l.restock ? isChoiceOffered(l.restock, choiceFor(l)) : false));
  const lineLabel = (l: ReturnWorkbenchLine): string => returnLineLabel(l.item.name ?? 'Deleted item', l.item.variant);
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
          .map((x) => reviewProblem(x, reviewFor(x.id)))
          .filter((p): p is string => p !== null),
        ...Object.values(adds).flatMap((a) => (a && !a.itemId ? [RETURNS_COPY.chooseReplacement] : [])),
      ]
    : [];

  function exchangeDecisions(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const x of ex.lines) if (x.status === 'requested') out.push(reviewDecision(x, reviewFor(x.id)));
    for (const [returnLineId, a] of Object.entries(adds)) {
      const d = a ? addReplacementDecision(returnLineId, a) : null;
      if (d) out.push(d);
    }
    return out;
  }

  function setChoice(lineId: string, next: RestockChoice) {
    setChoices((prev) => ({ ...prev, [lineId]: next }));
  }

  async function runSteps(steps: Array<'approve' | 'receive' | 'process'>, extra: Record<string, unknown>, key: string) {
    setBusy(key);
    const res = await runReturnStepsAction({
      id: r.id,
      body: { steps, expectedRevision: wb.revision, expectedPlanSeq: wb.planSeq, ...extra },
    });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      router.refresh();
      return;
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
            ? extra.receiveNow
              ? 'Approved and received.'
              : 'Return approved.'
            : step.step === 'receive'
              ? 'Return received.'
              : 'Return processed.',
        );
      }
    }
    router.refresh();
  }

  async function approve(whenShort: 'refuse' | 'backorder' = 'refuse') {
    if (!allOffered || exchangeProblems.length > 0) return;
    const lines = unappliedLines.map((l) => choiceToDecision(l.id, choiceFor(l)));
    const exchange = exchangeDecisions();
    setShortDetail(null);
    await runSteps(
      ['approve'],
      {
        approve: { lines, ...(exchange.length > 0 ? { exchange, replacement: { whenShort } } : {}) },
        receiveNow: itemIsHere,
      },
      'approve',
    );
  }

  // ── RX-2: the replacement actions ──────────────────────────────────────

  function afterReplacement(res: { ok: true; data: { workbench: unknown } } | { ok: false; error: { message: string } }, done: string) {
    if (!res.ok) {
      toast.error(res.error.message);
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
    if (!shownOrderId) return;
    setBusy('release');
    const res = await releaseReturnReplacementAction({ id: r.id, orderId: shownOrderId, reason });
    setBusy(null);
    if (res.ok && !res.data.answer.changed) {
      adopt(res.data.workbench as Workbench);
      toast.message(releaseOutcomeLine(res.data.answer));
      setReleaseOpen(false);
      return;
    }
    if (afterReplacement(res, RETURNS_COPY.releasedForPicking)) setReleaseOpen(false);
  }

  async function cancelReplacement(reason: string) {
    setBusy('cancel_replacement');
    const res = await cancelReturnReplacementAction({ id: r.id, body: { expectedRevision: wb.revision, reason } });
    setBusy(null);
    if (afterReplacement(res, 'Replacement cancelled.')) setCancelReplacementOpen(false);
  }

  async function changeReplacement(body: {
    lines: Array<{ exchangeLineId: string; itemId: string | null; quantity: number }>;
    reason: string;
    whenShort: 'refuse' | 'backorder';
  }) {
    setBusy('change_replacement');
    setChangeShort(null);
    const res = await changeReturnReplacementAction({
      id: r.id,
      body: { expectedRevision: wb.revision, lines: body.lines, reason: body.reason, whenShort: body.whenShort },
    });
    setBusy(null);
    if (!res.ok && res.error.details?.reason === 'replacement_unavailable') {
      setChangeShort(res.error.details.detail ?? []);
      toast.error(res.error.message);
      return;
    }
    if (afterReplacement(res, changeMode === 'issue' ? 'New replacement issued.' : 'Replacement changed.')) setChangeMode(null);
  }

  async function prepareReplacement() {
    setBusy('prepare');
    const res = await prepareReturnReplacementAction({ id: r.id });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      router.refresh();
      return;
    }
    adopt(res.data.workbench as Workbench);
    const refused = res.data.answer.ran.find((s) => s.outcome === 'refused');
    if (refused) toast.error(refused.message ?? RETURNS_COPY.prepareStopped);
    else if (res.data.answer.status === 'staged_for_delivery') toast.success(RETURNS_COPY.prepareStagedDelivery);
    else if (res.data.answer.status === 'staged_for_pickup') toast.success(RETURNS_COPY.prepareStaged);
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
    await runSteps(['process'], { process: changed.length > 0 ? { lines: changed } : null }, 'process');
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
    setBusy('plan');
    const res = await planReturnDispositionsAction({ id: r.id, lines: changed });
    setBusy(null);
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
    setBusy('deny');
    const res = await denyReturnAction({ id: r.id, reason: denyReason });
    setBusy(null);
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
    setBusy('cancel');
    const res = await cancelReturnAction({ id: r.id, expectedRevision: wb.revision, reason: cancelReason.trim() || null });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      router.refresh();
      return;
    }
    toast.success(res.data.changed ? 'Return cancelled.' : 'Already cancelled.');
    setCancelOpen(false);
    setCancelReason('');
    router.refresh();
  }

  async function buyLabel() {
    setBusy('label');
    const res = await buyReturnLabelAction(r.id);
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Return label purchased.');
    router.refresh();
  }

  function onAction(a: ReturnAction) {
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
      case 'hand_over':
        // The replacement's own page: its signature actions are the one
        // signature implementation.
        if (ex.replacement) router.push(`/dashboard/orders/${ex.replacement.orderId}`);
        return;
    }
  }

  // The lines a change (approved) or a re-issue (cancelled by a replacement
  // cancel) acts on.
  const changeLines: ChangeLineInput[] = ex.lines
    .filter((x) => (changeMode === 'issue' ? x.status === 'cancelled' && x.approvedItemId : x.status === 'approved'))
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
  const shortLines = Array.isArray(shortDetail) ? replacementShortItems(shortDetail as Array<Record<string, unknown>>) : [];

  const showPickers = r.status === 'requested' || r.status === 'received' || mode === 'change_destination';
  const editable = wb.viewer.canManageReturns && busy === null;
  const processLabel =
    r.status === 'received' && openLines.length === 1 && openLines[0]!.restock
      ? processLabelFor(openLines[0]!.restock, choiceFor(openLines[0]!))
      : null;
  const primaryLabel = (a: ReturnAction): string =>
    a === 'process' && processLabel ? processLabel.button : returnActionLabel(a, { hasExchange });
  const primaryDisabled = (a: ReturnAction): boolean =>
    busy !== null ||
    ((a === 'process' || a === 'approve' || a === 'approve_and_receive') && !allOffered) ||
    ((a === 'approve' || a === 'approve_and_receive') && exchangeProblems.length > 0);
  const secondaryDisabled = (a: ReturnAction): boolean =>
    busy !== null || (a === 'change_destination' && wb.destinationsUnavailable);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Link href="/dashboard/returns" className="text-muted-foreground hover:text-foreground text-sm">
          ← Back to returns
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{r.returnNumber ?? 'Return'}</h1>
          <ReturnStatusBadge status={r.status as never} />
          <Badge variant="outline">{hasExchange ? RETURNS_COPY.typeExchange : RETURNS_COPY.typeReturn}</Badge>
          <Badge variant="outline">
            {r.source === 'requester' ? RETURNS_COPY.requestedByRequester : RETURNS_COPY.createdByStaff}
          </Badge>
        </div>
        <p className="text-muted-foreground mt-1 text-sm">
          Against order{' '}
          <Link href={`/dashboard/orders/${r.orderRequestId}`} className="text-foreground font-medium hover:underline">
            {formatOrderNumber(r.orderNumber) ?? r.orderRequestId.slice(0, 8)}
          </Link>
          {r.requesterName || r.requesterEmail ? <> · {r.requesterName ?? r.requesterEmail}</> : null}
          {r.warehouseName ? <> · {r.warehouseName}</> : null}
          {r.reasonCode ? <> · {returnReasonLabel(r.reasonCode)}</> : null}
        </p>
      </div>

      {/* Next-step bar */}
      <section className="bg-card flex flex-wrap items-center gap-2 rounded-xl border p-3" aria-label="Next step">
        {actions.primary ? (
          <Button variant="gradient" onClick={() => onAction(actions.primary!)} disabled={primaryDisabled(actions.primary)}>
            {busy && busy === stepKey(actions.primary) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {primaryLabel(actions.primary)}
          </Button>
        ) : null}
        {actions.secondary.map((a) => (
          <Button key={a} variant={a === 'deny' ? 'destructive' : 'outline'} onClick={() => onAction(a)} disabled={secondaryDisabled(a)}>
            {a === 'change_destination' && mode === 'change_destination' ? 'Keep destination' : RETURN_ACTION_LABELS[a]}
          </Button>
        ))}
        {r.status === 'requested' && wb.viewer.canManageReturns ? (
          <label className="ml-auto inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              role="switch"
              aria-checked={itemIsHere}
              checked={itemIsHere}
              onChange={(e) => setItemIsHere(e.target.checked)}
              className="h-4 w-4"
            />
            <span>
              {RETURNS_COPY.itemIsHere}
              <span className="text-muted-foreground block text-xs">{RETURNS_COPY.itemIsHereHelp}</span>
            </span>
          </label>
        ) : null}
        {/* Why nothing, or less, is offered (RX-2: the replacement actions
            need order approval while the return actions stay). */}
        {actions.readOnlyReason ? <p className="text-muted-foreground text-sm">{actions.readOnlyReason}</p> : null}
        {!actions.primary && !actions.readOnlyReason && actions.secondary.length === 0 ? (
          <p className="text-muted-foreground text-sm">No further steps for this return.</p>
        ) : null}
        {wb.viewer.canManageReturns && choiceProblems.length > 0 && (actions.primary || actions.secondary.length > 0) ? (
          <ul className="text-destructive basis-full space-y-0.5 text-sm" role="status" aria-label="Choose a destination">
            {choiceProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}
        {exchangeProblems.length > 0 ? (
          <ul className="text-destructive basis-full space-y-0.5 text-sm" role="status" aria-label="Before approving the exchange">
            {[...new Set(exchangeProblems)].map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}
        {shortLines.length > 0 && r.status === 'requested' ? (
          <div className="basis-full space-y-2" role="alert" aria-label="Not in stock">
            <ul className="text-destructive space-y-0.5 text-sm">
              {shortLines.map((sItem) => (
                <li key={sItem.itemId}>{replacementShortLine(itemLabelById(sItem.itemId), sItem.available, sItem.needed)}</li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void approve('backorder')} disabled={busy !== null}>
                {RETURNS_COPY.approveReplacementOnBackorder}
              </Button>
              <Button variant="outline" onClick={() => setShortDetail(null)} disabled={busy !== null}>
                {RETURNS_COPY.changeReplacement}
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      {hasExchange ? <ReplacementOrderSection exchange={ex} canReadDecisions={wb.viewer.canReadDecisions} /> : null}

      {r.status === 'requested' && wb.viewer.canManageReturns ? (
        <section className="bg-card rounded-xl border p-4 text-sm" aria-label="What happens when you approve">
          <h2 className="text-muted-foreground font-mono text-[10.5px] uppercase tracking-[0.12em]">What happens when you approve</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">
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
                      decision: v.kind === 'decline' ? ('decline' as const) : v.kind === 'change' && !v.itemId ? ('pending' as const) : ('approve' as const),
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
                    ? [{ returnedLabel: rl ? lineLabel(rl) : 'Item', decision: 'add' as const, replacementLabel: a.label, quantity: a.quantity, available: a.free }]
                    : [];
                }),
              ],
              itemIsHere,
            }).map((sentence) => (
              <li key={sentence}>{sentence}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* RETURNING */}
      <section aria-label={RETURNS_COPY.returning} className="space-y-3">
        <h2 className="text-muted-foreground font-mono text-[10.5px] uppercase tracking-[0.12em]">{RETURNS_COPY.returning}</h2>
        {wb.lines.map((l) => {
          const name = l.item.name ?? 'Deleted item';
          const x = exchangeByReturnLine.get(l.id) ?? null;
          const add = adds[l.id] ?? null;
          const offerAdd = !x && canDecideExchange && ex.createEnabled;
          return (
            <div key={l.id} className={cn('grid gap-3', x || add ? 'md:grid-cols-2' : '')}>
            <article className="bg-card grid grid-cols-[64px_1fr] gap-4 rounded-xl border p-4 sm:grid-cols-[96px_1fr]">
              <div className="bg-muted relative h-16 w-16 overflow-hidden rounded-lg sm:h-24 sm:w-24">
                {l.item.thumbUrl || l.item.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- signed storage URL, sized box
                  <img src={l.item.thumbUrl ?? l.item.imageUrl ?? ''} alt={name} className="h-full w-full object-cover" />
                ) : null}
              </div>
              <div className="min-w-0 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link href={`/dashboard/inventory/${l.itemId}`} className="block truncate font-medium hover:underline">
                      {name}
                    </Link>
                    <p className="text-muted-foreground text-xs">
                      {[l.item.variant, l.item.sku].filter(Boolean).join(' · ')}
                    </p>
                    <p className="text-sm tabular-nums">{qtyReturningLabel(l.quantity)}</p>
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
                ) : l.restock ? (
                  <p className="text-muted-foreground text-sm">{plannedSentence(l.restock, lineLabel(l))}</p>
                ) : null}
                {r.status === 'received' && l.restock ? (
                  <p className="text-muted-foreground text-xs">{processingHint(l, choiceFor(l), lineLabel(l))}</p>
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
                returnedLabel={lineLabel(l)}
                returnedQty={l.quantity}
                review={canDecideExchange && x.status === 'requested' ? reviewFor(x.id) : undefined}
                onReview={(next) => setReviews((prev) => ({ ...prev, [x.id]: next }))}
                load={loaderFor(l.orderRequestLineId)}
                disabled={busy !== null}
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
            <Button variant="gradient" onClick={saveDestinations} disabled={busy !== null || !allOffered}>
              {busy === 'plan' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Save destination
            </Button>
          </div>
        ) : null}
      </section>

      {r.notes ? (
        <section className="bg-card rounded-xl border p-4">
          <h2 className="text-muted-foreground font-mono text-[10.5px] uppercase tracking-[0.12em]">Notes</h2>
          <p className="mt-1.5 whitespace-pre-wrap text-sm">{r.notes}</p>
        </section>
      ) : null}

      {r.denialReason && r.status === 'denied' ? (
        <section className="bg-card border-destructive/40 rounded-xl border p-4">
          <h2 className="text-destructive text-sm font-medium">Denied</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm">{r.denialReason}</p>
        </section>
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

      {/* The chain */}
      <section className="bg-card rounded-xl border p-4" aria-label="History">
        <h2 className="text-muted-foreground font-mono text-[10.5px] uppercase tracking-[0.12em]">History</h2>
        <ol className="mt-3 space-y-2">
          {wb.chain.map((e, i) => (
            <li key={`${e.at}-${i}`} className="grid grid-cols-[1fr_auto] gap-3 text-sm">
              <span>
                {e.label}
                {e.actorName ? <span className="text-muted-foreground"> · {e.actorName}</span> : null}
              </span>
              <time
                dateTime={e.at}
                className="text-muted-foreground text-xs tabular-nums"
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
          {wb.chain.length === 0 ? <li className="text-muted-foreground text-sm">No history yet.</li> : null}
        </ol>
      </section>

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
              {r.source === 'requester' ? RETURNS_COPY.denyReasonHelp : RETURNS_COPY.denyReasonHelpInternal}
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
            <Button variant="destructive" onClick={deny} disabled={busy === 'deny' || !denyReason.trim()}>
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
              {ex.hasApprovedExchange
                ? 'The return closes as cancelled. A replacement not yet handed over is cancelled with it.'
                : 'Nothing moves. The return closes as cancelled.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="return-cancel-reason">
              {ex.hasApprovedExchange ? RETURNS_COPY.cancelReturnReasonRequired : RETURNS_COPY.cancelReasonLabel}
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
            <Button variant="outline" onClick={() => setCancelOpen(false)} disabled={busy === 'cancel'}>
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
          <ReleaseEarlyDialog open={releaseOpen} onOpenChange={setReleaseOpen} busy={busy === 'release'} onConfirm={releaseEarly} />
          <CancelReplacementDialog
            open={cancelReplacementOpen}
            onOpenChange={setCancelReplacementOpen}
            busy={busy === 'cancel_replacement'}
            drawn={ex.replacement?.class === 'drawn'}
            inTransit={ex.replacement?.status === 'in_transit'}
            onConfirm={cancelReplacement}
          />
          <ChangeReplacementDialog
            key={changeMode ?? 'closed'}
            open={changeMode !== null}
            onOpenChange={(v) => {
              if (!v) setChangeMode(null);
            }}
            busy={busy === 'change_replacement'}
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
    <section className="bg-card space-y-3 rounded-xl border p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium">Return label</h2>
          <p className="text-muted-foreground mt-0.5 text-[11.5px]">A reverse carrier label so the item ships back to your warehouse.</p>
        </div>
        {canBuy ? (
          <Button variant="outline" size="sm" onClick={onBuy} disabled={disabled}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Truck className="h-3.5 w-3.5" />}
            Buy return label
          </Button>
        ) : null}
      </div>
      {returnLabel ? (
        <dl className="space-y-2 text-[12px]">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">Carrier</dt>
            <dd className="text-right">
              {returnLabel.carrier ?? '—'}
              {returnLabel.service ? <span className="text-muted-foreground"> · {returnLabel.service}</span> : null}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">Tracking #</dt>
            <dd className={cn('text-right font-mono')}>
              {returnLabel.tracking_url && returnLabel.tracking_code ? (
                <a href={returnLabel.tracking_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline">
                  {returnLabel.tracking_code}
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                (returnLabel.tracking_code ?? '—')
              )}
            </dd>
          </div>
          {returnLabel.rate_cents != null ? (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Cost</dt>
              <dd className="text-right tabular-nums">{formatCurrency(returnLabel.rate_cents / 100, returnLabel.currency ?? 'USD')}</dd>
            </div>
          ) : null}
          {returnLabel.label_url ? (
            <div className="pt-1">
              <Button variant="outline" size="sm" asChild>
                <a href={returnLabel.label_url} target="_blank" rel="noopener noreferrer">
                  <FileDown className="h-3.5 w-3.5" />
                  Download return label
                </a>
              </Button>
            </div>
          ) : null}
        </dl>
      ) : null}
    </section>
  );
}
