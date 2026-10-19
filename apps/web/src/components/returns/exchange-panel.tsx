'use client';

import { ArrowRight, Loader2 } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { DetailSection } from '@/components/patterns/detail-section';
import { Thumb } from '@/components/patterns/thumb';
import { ReplacementPicker } from '@/components/returns/replacement-picker';
import {
  choiceRowClass,
  eyebrowClass,
  nativeRadioClass,
  replacementCardClass,
} from '@/components/returns/returns-ui';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type {
  ReturnWorkbenchExchange,
  ReturnWorkbenchExchangeLine,
} from '@/server/services/returns-exchange-workbench';

import {
  availableLabel,
  earlierReplacementEntries,
  exchangeActionConsequences,
  exchangeReviewDecision,
  exchangeReviewOptions,
  exchangeReviewProblem,
  formatOrderNumber,
  noReplacementLine,
  RAIL_STEP_STATE_WORDS,
  releasedBeforeReturnLine,
  replacementCardQuantityLabel,
  replacementCardStatusLabel,
  replacementLineSummary,
  replacementShortItems,
  replacementShortLine,
  replacementSiteOptions,
  returnLineLabel,
  RETURN_REASON_MAX,
  RETURN_RELEASE_REASON_MAX,
  RETURNS_COPY,
  shortLabel,
  type ActionResult,
  type ExchangeCandidatesAnswer,
  type ExchangeConsequenceKey,
  type ExchangeReviewState,
  type RailStep,
  type ReplacementDeliverySite,
  type ReplacementFulfilment,
} from '@stockpilot/core';

/**
 * The exchange half of the RMA workbench (returns RX-2): the outbound rail,
 * the REPLACEMENT side of each returned line (requested, approved, the
 * review choices at approval), the replacement order, and the dialogs for
 * releasing, changing, issuing and cancelling a replacement. Words from
 * core's returns copy; state is never shown by colour alone (each rail step
 * says its state, the REPLACEMENT side carries a text label and an arrow).
 */

// ── The rail ─────────────────────────────────────────────────────────────────

// Each step's state in core's words (done, now, next, stopped, not reached,
// not started), the phone's too: after a stop nothing reads "next".
export function ExchangeRail({ rail }: { rail: RailStep[] }) {
  if (rail.length === 0) return null;
  return (
    <ol
      className="flex flex-wrap items-center gap-x-1.5 gap-y-2 text-[12px]"
      aria-label={RETURNS_COPY.railProgress}
    >
      {rail.map((s, i) => (
        <li
          key={s.id}
          className="inline-flex items-center gap-1.5"
          aria-current={s.state === 'current' ? 'step' : undefined}
        >
          {/* The stage-strip pill (DESIGN-SPEC 6.10 tones): each state is
              also said in words, so no state rests on colour or a dash. */}
          <span
            className={cn(
              'inline-flex h-6 items-center whitespace-nowrap rounded-full border px-2.5 leading-none',
              s.state === 'done' && 'bg-sunk text-ink-2 border-line-strong',
              s.state === 'current' && 'border-foreground text-foreground bg-card font-medium',
              s.state === 'stopped' &&
                'bg-destructive-wash text-destructive border-transparent font-medium',
              s.state === 'upcoming' && 'text-muted-foreground border-line-strong border-dashed',
              (s.state === 'skipped' || s.state === 'not_started') &&
                'text-muted-foreground border-border border-dashed',
            )}
          >
            {s.label}
            <span
              className={cn(
                s.state === 'stopped' ? 'text-destructive' : 'text-muted-foreground',
                'font-normal',
              )}
            >
              {' '}
              · {RAIL_STEP_STATE_WORDS[s.state]}
            </span>
          </span>
          {i < rail.length - 1 ? <ArrowRight className="text-ink-4 h-3 w-3" aria-hidden /> : null}
        </li>
      ))}
    </ol>
  );
}

// ── The review state per exchange line (approval): core's, shared with the phone ──

export type { ExchangeReviewState };

export interface AddReplacementState {
  itemId: string | null;
  label: string | null;
  free: number | null;
  quantity: number;
  reason: string;
}

/** Why the approval cannot be sent yet for this line, or null (core). */
export const reviewProblem = exchangeReviewProblem;

/** The decision the approval sends for one exchange line (core). */
export const reviewDecision = exchangeReviewDecision;

type CandidateLoader = (q: string) => Promise<ActionResult<ExchangeCandidatesAnswer>>;

/** The replacement's photo in the 56 px frame (DESIGN-SPEC 6.14). */
function ItemThumb({ url, alt }: { url: string | null; alt: string }) {
  return <Thumb size={56} src={url} alt={alt} />;
}

/**
 * The REPLACEMENT side of one returned line: what was asked, what was
 * approved (and "Changed by the warehouse" when it differs), availability,
 * and, while the RMA waits for approval, the review choices. Once the
 * replacement was handed over, its pill and quantity say so (core's rule,
 * read from the replacement block; returns RX-3 PR stage, polish (a)).
 */
export function ReplacementSide({
  line,
  replacement = null,
  returnedLabel,
  returnedQty,
  review,
  onReview,
  load,
  disabled,
  canApproveOrders = true,
  focusPickerToken = null,
}: {
  line: ReturnWorkbenchExchangeLine;
  /** The replacement shown on the RMA (the workbench's block): what was handed over. */
  replacement?: ReturnWorkbenchExchange['replacement'];
  returnedLabel: string;
  returnedQty: number;
  /** Present while the RMA is requested and the viewer may manage returns. */
  review?: ExchangeReviewState;
  onReview?: (next: ExchangeReviewState) => void;
  load: CandidateLoader;
  disabled?: boolean;
  /** Review fix P1: without order approval only the decline is open (core exchangeReviewOptions). */
  canApproveOrders?: boolean;
  /** Review fix P7: a new value moves focus to this line's picker (after a short refusal's Change replacement). */
  focusPickerToken?: number | null;
}) {
  const groupId = React.useId();
  const pickerBox = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (focusPickerToken !== null) pickerBox.current?.focus();
  }, [focusPickerToken]);
  const requested = line.requestedItem;
  const requestedLabel = requested
    ? returnLineLabel(requested.name ?? 'Item', requested.variant)
    : null;
  const approved = line.approvedItem;
  const approvedLabel = approved
    ? returnLineLabel(approved.name ?? 'Item', approved.variant)
    : null;
  const status = replacementCardStatusLabel(line, replacement);

  return (
    <article
      className={cn(replacementCardClass, 'space-y-3 p-4')}
      aria-label={`${RETURNS_COPY.replacement} for ${returnedLabel}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <ArrowRight className="text-accent h-3.5 w-3.5" aria-hidden />
        <span className={eyebrowClass}>{RETURNS_COPY.replacement}</span>
        <Badge variant="outline" className="ml-auto">
          {status}
        </Badge>
      </div>

      <div className="flex gap-3">
        <ItemThumb
          url={(approved ?? requested)?.thumbUrl ?? (approved ?? requested)?.imageUrl ?? null}
          alt={approvedLabel ?? requestedLabel ?? 'Replacement'}
        />
        <div className="min-w-0 space-y-1 text-[13px]">
          {requestedLabel ? (
            <p
              className={cn(
                approvedLabel && line.changedByWarehouse
                  ? 'text-muted-foreground line-through'
                  : 'font-medium',
              )}
            >
              {requestedLabel}
            </p>
          ) : (
            <p className="font-medium">{RETURNS_COPY.replacementWarehouseReview}</p>
          )}
          {line.requestNote ? (
            <p className="text-muted-foreground text-[12px]">
              {RETURNS_COPY.replacementNoteFromRequester}: {line.requestNote}
            </p>
          ) : null}
          {approvedLabel && line.changedByWarehouse ? (
            <p className="font-medium">
              {approvedLabel}{' '}
              <span className="text-muted-foreground text-[12px] font-normal">
                ({RETURNS_COPY.replacementChangedByWarehouse})
              </span>
            </p>
          ) : null}
          <p className="tabular-nums">{replacementCardQuantityLabel(line, replacement)}</p>
          {line.status === 'requested' && line.requestedFree !== null ? (
            <p
              className={cn(
                'text-[12px] tabular-nums',
                line.requestedFree < line.requestedQuantity
                  ? 'text-destructive'
                  : 'text-muted-foreground',
              )}
            >
              {line.requestedFree < line.requestedQuantity
                ? shortLabel(line.requestedFree, line.requestedQuantity)
                : availableLabel(line.requestedFree)}
            </p>
          ) : null}
        </div>
      </div>

      {review && onReview ? (
        <fieldset disabled={disabled} className="space-y-2">
          <legend className="sr-only">Decision for the replacement of {returnedLabel}</legend>
          <div
            role="radiogroup"
            aria-label={`Decision for the replacement of ${returnedLabel}`}
            className="space-y-1.5"
          >
            {exchangeReviewOptions(line, { canApproveOrders }).map(
              ({ kind, label: words, disabled: off }) => (
                <label
                  key={kind}
                  className={cn(
                    choiceRowClass({ checked: review.kind === kind, disabled: off }),
                    'flex min-h-9 items-center gap-2.5 px-3 py-1.5',
                    off && 'text-muted-foreground',
                  )}
                >
                  <input
                    type="radio"
                    name={`${groupId}-decision`}
                    value={kind}
                    checked={review.kind === kind}
                    disabled={off}
                    onChange={() =>
                      onReview(
                        kind === 'as_requested'
                          ? { kind }
                          : kind === 'decline'
                            ? { kind, reason: '' }
                            : {
                                kind,
                                itemId: null,
                                label: null,
                                free: null,
                                quantity: Math.min(line.requestedQuantity, returnedQty),
                                reason: '',
                              },
                      )
                    }
                    className={nativeRadioClass}
                  />
                  {words}
                </label>
              ),
            )}
          </div>
          {review.kind === 'change' ? (
            <div
              ref={pickerBox}
              tabIndex={-1}
              role="group"
              aria-label={`${RETURNS_COPY.chooseReplacement} for ${returnedLabel}`}
              className="space-y-2 outline-none"
            >
              <ReplacementPicker
                load={load}
                needed={review.quantity}
                selectedItemId={review.itemId}
                onSelect={(row, label) =>
                  onReview({ ...review, itemId: row.itemId, label, free: row.free })
                }
                label={returnedLabel}
                disabled={disabled}
              />
              <QuantityField
                id={`${groupId}-qty`}
                value={review.quantity}
                max={returnedQty}
                onChange={(quantity) => onReview({ ...review, quantity })}
              />
              <ReasonField
                id={`${groupId}-reason`}
                label={RETURNS_COPY.replacementReasonLabel}
                help={RETURNS_COPY.replacementReasonHelp}
                value={review.reason}
                onChange={(reason) => onReview({ ...review, reason })}
              />
            </div>
          ) : null}
          {review.kind === 'decline' ? (
            <ReasonField
              id={`${groupId}-decline`}
              label={RETURNS_COPY.declineReasonLabel}
              help={RETURNS_COPY.replacementReasonHelp}
              value={review.reason}
              onChange={(reason) => onReview({ kind: 'decline', reason })}
            />
          ) : null}
        </fieldset>
      ) : null}
    </article>
  );
}

/** "Add a replacement" on a return-only line at approval (G9). */
export function AddReplacement({
  returnedLabel,
  returnedQty,
  state,
  onChange,
  load,
  disabled,
}: {
  returnedLabel: string;
  returnedQty: number;
  state: AddReplacementState | null;
  onChange: (next: AddReplacementState | null) => void;
  load: CandidateLoader;
  disabled?: boolean;
}) {
  const id = React.useId();
  if (!state) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() =>
          onChange({ itemId: null, label: null, free: null, quantity: returnedQty, reason: '' })
        }
      >
        {RETURNS_COPY.addReplacement}
      </Button>
    );
  }
  return (
    <article
      className={cn(replacementCardClass, 'space-y-3 p-4')}
      aria-label={`${RETURNS_COPY.addReplacement} for ${returnedLabel}`}
    >
      <div className="flex items-center gap-1.5">
        <ArrowRight className="text-accent h-3.5 w-3.5" aria-hidden />
        <span className={eyebrowClass}>{RETURNS_COPY.replacement}</span>
        {/* Review fix P27: the undo reads as the action it is. */}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => onChange(null)}
          disabled={disabled}
        >
          {RETURNS_COPY.keepAsReturnOnly}
        </Button>
      </div>
      <ReplacementPicker
        load={load}
        needed={state.quantity}
        selectedItemId={state.itemId}
        onSelect={(row, label) => onChange({ ...state, itemId: row.itemId, label, free: row.free })}
        label={returnedLabel}
        disabled={disabled}
      />
      <QuantityField
        id={`${id}-qty`}
        value={state.quantity}
        max={returnedQty}
        onChange={(quantity) => onChange({ ...state, quantity })}
      />
    </article>
  );
}

function QuantityField({
  id,
  value,
  max,
  onChange,
}: {
  id: string;
  value: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={id} className="text-[12.5px] font-normal">
        {RETURNS_COPY.replacementQuantity}
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={1}
        max={max}
        step={1}
        value={value}
        onChange={(e) => {
          const n = Math.trunc(Number(e.target.value));
          onChange(Number.isFinite(n) ? Math.min(Math.max(n, 1), max) : 1);
        }}
        className="h-8 w-20 text-right font-mono tabular-nums"
      />
    </div>
  );
}

function ReasonField({
  id,
  label,
  help,
  value,
  onChange,
  max = RETURN_REASON_MAX,
}: {
  id: string;
  label: string;
  help?: string;
  value: string;
  onChange: (v: string) => void;
  max?: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-[12.5px]">
        {label}
      </Label>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        maxLength={max}
      />
      {help ? <p className="text-muted-foreground text-[12px]">{help}</p> : null}
    </div>
  );
}

// ── The replacement order ────────────────────────────────────────────────────

export function ReplacementOrderSection({
  exchange,
  canReadDecisions,
  returnStatus = null,
}: {
  exchange: ReturnWorkbenchExchange;
  canReadDecisions: boolean;
  /** The RMA's own status: a denied return's exchange reads declined. */
  returnStatus?: string | null;
}) {
  const repl = exchange.replacement;
  return (
    <DetailSection
      aria-label={RETURNS_COPY.replacementOrderHeading}
      title={RETURNS_COPY.exchangeStatusHeading}
      aside={<Badge variant="outline">{exchange.statusLabel}</Badge>}
      bodyClassName="space-y-3"
    >
      <ExchangeRail rail={exchange.rail} />
      {repl ? (
        <div className="space-y-2 text-[13.5px]">
          <p>
            {RETURNS_COPY.replacementOrderHeading}{' '}
            <Link
              href={`/dashboard/orders/${repl.orderId}`}
              className="font-mono font-medium tabular-nums underline-offset-2 hover:underline"
            >
              {formatOrderNumber(repl.orderNumber) ?? repl.orderId.slice(0, 8)}
            </Link>
            {!repl.live ? <span className="text-muted-foreground"> (cancelled)</span> : null}
          </p>
          {repl.lines.length > 0 ? (
            <ul className="space-y-1">
              {repl.lines.map((l) => {
                // Review fix P19: picked or staged, or part handed over, never
                // "reserved 0" (core replacementLineSummary, the phone's too).
                const summary = replacementLineSummary({
                  label: l.label,
                  requested: l.requested,
                  fulfilled: l.fulfilled,
                  held: l.held,
                  status: repl.status,
                });
                return (
                  <li key={l.orderLineId} className="text-[13.5px]">
                    <span className="font-medium">{l.label}</span>
                    {summary.slice(l.label.length)}
                    {l.take ? (
                      <span className="text-muted-foreground block text-[12px]">{l.take}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {repl.short ? (
            <p className="text-destructive text-[12.5px]" role="status">
              {RETURNS_COPY.notInStock}
            </p>
          ) : null}
          {exchange.releasedEarly ? (
            <p className="text-muted-foreground text-[12.5px]">
              {releasedBeforeReturnLine(
                exchange.release?.byName ?? null,
                canReadDecisions ? (exchange.release?.reason ?? null) : null,
              )}
            </p>
          ) : null}
          {exchange.history.length > 0 ? (
            // Review fix P22: the order status words (core), never a raw code.
            <p className="text-muted-foreground text-[12.5px]">
              {RETURNS_COPY.earlierReplacements}:{' '}
              {earlierReplacementEntries(exchange.history).map((h, i) => (
                <React.Fragment key={h.orderId}>
                  {i > 0 ? ', ' : null}
                  <Link
                    href={`/dashboard/orders/${h.orderId}`}
                    className="underline-offset-2 hover:underline"
                  >
                    {h.orderLabel}
                  </Link>
                  {h.statusWords ? ` (${h.statusWords})` : null}
                </React.Fragment>
              ))}
            </p>
          ) : null}
        </div>
      ) : (
        // Why there is no replacement order: not yet approved, declined, or
        // cancelled with the return (review fix P4, core noReplacementLine).
        <p className="text-muted-foreground text-[13.5px]">
          {noReplacementLine(exchange.status, { returnStatus })}
        </p>
      )}
    </DetailSection>
  );
}

// ── Dialogs ─────────────────────────────────────────────────────────────────

/** A refusal kept inside the open dialog, announced (pattern 20; fix round 1, completeness C-3). */
function DialogError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="text-destructive text-[13px]" role="alert">
      {error}
    </p>
  );
}

export function ReleaseEarlyDialog({
  open,
  onOpenChange,
  busy,
  error = null,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  busy: boolean;
  /** The last refusal, kept inside the dialog (pattern 20; fix round 1, completeness C-3). */
  error?: string | null;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = React.useState('');
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (busy) return;
        onOpenChange(v);
        if (!v) setReason('');
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{RETURNS_COPY.releaseEarly}</DialogTitle>
          <DialogDescription>{RETURNS_COPY.releaseEarlyConfirm}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          {[RETURNS_COPY.releasePresetInPerson, RETURNS_COPY.releasePresetDeliverySwap].map((p) => (
            <Button
              key={p}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setReason(p)}
              aria-pressed={reason === p}
            >
              {p}
            </Button>
          ))}
        </div>
        <ReasonField
          id="release-early-reason"
          label={RETURNS_COPY.releaseEarlyReasonLabel}
          value={reason}
          onChange={setReason}
          max={RETURN_RELEASE_REASON_MAX}
        />
        <DialogError error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Keep waiting
          </Button>
          <Button
            variant="gradient"
            onClick={() => onConfirm(reason.trim())}
            disabled={busy || !reason.trim()}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {RETURNS_COPY.releaseBeforeReturn}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CancelReplacementDialog({
  open,
  onOpenChange,
  busy,
  error = null,
  consequences,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  busy: boolean;
  /** The last refusal, kept inside the dialog (pattern 20; fix round 1, completeness C-3). */
  error?: string | null;
  /**
   * What happens (core exchangeActionConsequences 'cancel_replacement'):
   * picked, the items go back to Staging on record (X-1); in transit, ask the
   * driver; then that the order is cancelled and the return itself does not
   * change (review fix P2: never "The return stays open.").
   */
  consequences: ReadonlyArray<{ key: ExchangeConsequenceKey; text: string }>;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = React.useState('');
  const effect = consequences.find((c) => c.key === 'effect')?.text ?? null;
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (busy) return;
        onOpenChange(v);
        if (!v) setReason('');
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{RETURNS_COPY.cancelReplacement}?</DialogTitle>
          {/* What to do with what was picked comes first, then the effect. */}
          {consequences
            .filter((c) => c.key !== 'effect')
            .map((c) => (
              <p key={c.key} className="text-destructive text-[13px]" role="alert">
                {c.text}
              </p>
            ))}
          {effect ? <DialogDescription>{effect}</DialogDescription> : null}
        </DialogHeader>
        <ReasonField
          id="cancel-replacement-reason"
          label={RETURNS_COPY.cancelReplacementReasonLabel}
          help={RETURNS_COPY.replacementReasonHelp}
          value={reason}
          onChange={setReason}
        />
        <DialogError error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Keep it
          </Button>
          <Button
            variant="destructive"
            onClick={() => onConfirm(reason.trim())}
            disabled={busy || !reason.trim()}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {RETURNS_COPY.cancelReplacement}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Where the replacement goes (desk check F6): shown when an approval, a
 * change or a re-issue is refused replacement_site_not_available (the
 * original delivery site is missing, closed or not served by the warehouse).
 * Every active site the warehouse serves, then "Pickup instead"; the choice is
 * sent again as the request's replacement and the database checks it.
 */
export function SiteChoiceDialog({
  open,
  onOpenChange,
  busy,
  sites,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  busy: boolean;
  sites: readonly ReplacementDeliverySite[];
  onChoose: (value: ReplacementFulfilment) => void;
}) {
  const options = replacementSiteOptions(sites);
  const [key, setKey] = React.useState<string | null>(null);
  const chosen = options.find((o) => o.key === key) ?? null;
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (busy) return;
        onOpenChange(v);
        if (!v) setKey(null);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{RETURNS_COPY.siteChoiceTitle}</DialogTitle>
          <DialogDescription>{RETURNS_COPY.siteChoiceHelp}</DialogDescription>
        </DialogHeader>
        <div role="radiogroup" aria-label={RETURNS_COPY.siteChoiceTitle} className="space-y-1.5">
          {options.map((o) => (
            <label
              key={o.key}
              className={cn(
                choiceRowClass({ checked: key === o.key, disabled: busy }),
                'flex min-h-[44px] items-center gap-2.5 px-3',
              )}
            >
              <input
                type="radio"
                name="replacement-site"
                value={o.key}
                checked={key === o.key}
                onChange={() => setKey(o.key)}
                disabled={busy}
                className={nativeRadioClass}
              />
              {o.label}
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Back
          </Button>
          <Button onClick={() => chosen && onChoose(chosen.value)} disabled={busy || !chosen}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Send again
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Close as return only" after a replacement cancel (desk check F9): the
 * exchange ends for good and the return goes on as a return only. A reason
 * is required (kept on the return, never shown to the requester).
 */
export function CloseAsReturnOnlyDialog({
  open,
  onOpenChange,
  busy,
  error = null,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  busy: boolean;
  /** The last refusal, kept inside the dialog (pattern 20; fix round 1, completeness C-3). */
  error?: string | null;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = React.useState('');
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (busy) return;
        onOpenChange(v);
        if (!v) setReason('');
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{RETURNS_COPY.closeAsReturnOnly}?</DialogTitle>
          <DialogDescription>{RETURNS_COPY.closeAsReturnOnlyHelp}</DialogDescription>
        </DialogHeader>
        <ReasonField
          id="close-as-return-only-reason"
          label={RETURNS_COPY.closeAsReturnOnlyReasonLabel}
          help={RETURNS_COPY.replacementReasonHelp}
          value={reason}
          onChange={setReason}
        />
        <DialogError error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Keep it open
          </Button>
          <Button onClick={() => onConfirm(reason.trim())} disabled={busy || !reason.trim()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {RETURNS_COPY.closeAsReturnOnly}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Close the rest" (returns RX-4, 0397; RX-2 verification V3): a replacement
 * handed over in part whose rest is on backorder is closed from its RMA once
 * the returned item is in. The rest is never sent; what was handed over
 * stays. A reason is required (kept on the return, never shown to the
 * requester).
 */
export function CloseReplacementRestDialog({
  open,
  onOpenChange,
  busy,
  error = null,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  busy: boolean;
  /** The last refusal, kept inside the dialog (pattern 20). */
  error?: string | null;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = React.useState('');
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (busy) return;
        onOpenChange(v);
        if (!v) setReason('');
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{RETURNS_COPY.closeReplacementRest}?</DialogTitle>
          <DialogDescription>{RETURNS_COPY.closeReplacementRestHelp}</DialogDescription>
        </DialogHeader>
        <ReasonField
          id="close-replacement-rest-reason"
          label={RETURNS_COPY.closeReplacementRestReasonLabel}
          help={RETURNS_COPY.replacementReasonHelp}
          value={reason}
          onChange={setReason}
        />
        <DialogError error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Keep it open
          </Button>
          <Button onClick={() => onConfirm(reason.trim())} disabled={busy || !reason.trim()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {RETURNS_COPY.closeReplacementRest}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface ChangeLineInput {
  exchangeLineId: string;
  orderRequestLineId: string;
  returnedLabel: string;
  returnedQty: number;
  currentItemId: string | null;
  currentQuantity: number;
}

/**
 * Change the replacement (substitution) or issue a new one after a cancel
 * (C-1): per exchange line a picker and a quantity, one reason, and, when
 * the approval refused for stock, the numbers and "Approve, replacement on
 * backorder".
 */
export function ChangeReplacementDialog({
  open,
  onOpenChange,
  busy,
  error = null,
  mode,
  lines,
  loaderFor,
  shortDetail,
  itemLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  busy: boolean;
  /** The last refusal, kept inside the dialog (pattern 20; fix round 1, completeness C-3). */
  error?: string | null;
  mode: 'change' | 'issue';
  lines: ChangeLineInput[];
  loaderFor: (orderRequestLineId: string) => CandidateLoader;
  /** replacement_unavailable's detail from the last try, when it refused. */
  shortDetail: unknown;
  itemLabel: (itemId: string) => string;
  onConfirm: (body: {
    lines: Array<{ exchangeLineId: string; itemId: string | null; quantity: number }>;
    reason: string;
    whenShort: 'refuse' | 'backorder';
  }) => void;
}) {
  // Fix round 1 (verification L1): a pick keeps the picked row's own label,
  // so a short refusal names it ("Walk Exchange Tee - 2XL: 0 available, 1
  // needed."), never "Item".
  const [picks, setPicks] = React.useState<
    Record<string, { itemId: string | null; quantity: number; label?: string }>
  >({});
  const [reason, setReason] = React.useState('');
  // The short numbers belong to the picks they refused: a new pick hides them
  // (and the backorder button) until the next refusal (fix round 1, L1).
  const [shortSeen, setShortSeen] = React.useState<unknown>(null);
  const pick = (l: ChangeLineInput) =>
    picks[l.exchangeLineId] ?? { itemId: l.currentItemId, quantity: l.currentQuantity };
  const short =
    Array.isArray(shortDetail) && shortDetail !== shortSeen
      ? replacementShortItems(shortDetail as Array<Record<string, unknown>>)
      : [];
  const labelOf = (itemId: string): string => {
    for (const p of Object.values(picks)) if (p.itemId === itemId && p.label) return p.label;
    return itemLabel(itemId);
  };
  const send = (whenShort: 'refuse' | 'backorder') =>
    onConfirm({
      lines: lines.map((l) => ({
        exchangeLineId: l.exchangeLineId,
        itemId: pick(l).itemId,
        quantity: pick(l).quantity,
      })),
      reason: reason.trim(),
      whenShort,
    });
  const ready = !busy && reason.trim().length > 0 && lines.every((l) => pick(l).itemId);
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (busy) return;
        onOpenChange(v);
        if (!v) {
          setPicks({});
          setReason('');
          setShortSeen(null);
        }
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {mode === 'issue' ? RETURNS_COPY.issueNewReplacement : RETURNS_COPY.changeReplacement}
          </DialogTitle>
          <DialogDescription>
            {/* Review fix P2: core's words for what is created. */}
            {exchangeActionConsequences(
              mode === 'issue' ? 'issue_replacement' : 'change_replacement',
              { replacementStatus: null },
            )
              .map((c) => c.text)
              .join(' ')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {lines.map((l) => (
            <div key={l.exchangeLineId} className="space-y-2">
              <p className="text-[13.5px] font-medium">{l.returnedLabel}</p>
              <ReplacementPicker
                load={loaderFor(l.orderRequestLineId)}
                needed={pick(l).quantity}
                selectedItemId={pick(l).itemId}
                onSelect={(row, rowLabel) => {
                  setShortSeen(shortDetail);
                  setPicks((p) => ({
                    ...p,
                    [l.exchangeLineId]: { ...pick(l), itemId: row.itemId, label: rowLabel },
                  }));
                }}
                label={l.returnedLabel}
                disabled={busy}
              />
              <QuantityField
                id={`change-qty-${l.exchangeLineId}`}
                value={pick(l).quantity}
                max={l.returnedQty}
                onChange={(quantity) =>
                  setPicks((p) => ({ ...p, [l.exchangeLineId]: { ...pick(l), quantity } }))
                }
              />
            </div>
          ))}
          <ReasonField
            id="change-replacement-reason"
            label={RETURNS_COPY.replacementReasonLabel}
            help={RETURNS_COPY.replacementReasonHelp}
            value={reason}
            onChange={setReason}
          />
          {short.length > 0 ? (
            <ul
              className="text-destructive space-y-0.5 text-[13px]"
              role="alert"
              aria-label="Not in stock"
            >
              {short.map((s) => (
                <li key={s.itemId}>
                  {replacementShortLine(labelOf(s.itemId), s.available, s.needed)}
                </li>
              ))}
            </ul>
          ) : null}
          <DialogError error={error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Keep it
          </Button>
          {short.length > 0 ? (
            <Button variant="outline" onClick={() => send('backorder')} disabled={!ready}>
              {mode === 'issue'
                ? RETURNS_COPY.issueReplacementOnBackorder
                : RETURNS_COPY.changeReplacementOnBackorder}
            </Button>
          ) : null}
          <Button variant="gradient" onClick={() => send('refuse')} disabled={!ready}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {mode === 'issue' ? RETURNS_COPY.issueNewReplacement : RETURNS_COPY.changeReplacement}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
