'use client';

import { ArrowRight, ImageOff, Loader2, Minus, Plus, Undo2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  clampWhole,
  effectiveReplacementQuantity,
  initialRequesterDrafts,
  optionsForLine,
  reconcileDraftsWithOptions,
  reconcileRequesterDrafts,
  REQUESTER_REASON_OPTIONS,
  requesterLinesFromDrafts,
  restartRequesterDrafts,
  type RequesterLineDraft,
  type RequesterLineMode,
  type RequesterOptionsOutcome,
  type RequesterOptionsState,
  type RequesterSubmitBody,
  type RequesterSubmitOutcome,
} from '@/lib/returns/requester-sheet';
import { cn } from '@/lib/utils';

import {
  randomRequestUuid,
  REQUESTER_AVAILABILITY_WORDS,
  requesterRefusalRecovery,
  requesterReplacementQuantityLabel,
  RETURN_EXCHANGE_NOTE_MAX,
  RETURNS_COPY,
  returnLineLabel,
  type RequesterExchangeOption,
  type RequesterPhoto,
  type RequesterReturnableLine,
  type ReturnReasonCodeValue,
} from '@stockpilot/core';

/** What the form reports once the server accepted the request. */
export interface RequesterSubmitted {
  returnNumber: string | null;
  replay: boolean;
  /** Any line asked for a replacement (the confirmation's words). */
  hasExchange: boolean;
}

export interface RequesterReturnSheetFormProps {
  /** The order's returnable lines (core's requester sheet; never a SKU). */
  lines: readonly RequesterReturnableLine[];
  /** The kill switch as the sheet was served: false hides Exchange. */
  exchangesEnabled: boolean;
  /** The sizes, loaded once, on the first Exchange (token: a POST with the
   *  token in the body; portal: its action). */
  loadOptions: () => Promise<RequesterOptionsOutcome>;
  submit: (body: RequesterSubmitBody) => Promise<RequesterSubmitOutcome>;
  onSubmitted: (result: RequesterSubmitted) => void;
  /**
   * The server said the form is behind (core requesterRefusalRecovery): read
   * the lines again (the token page refreshes, the portal reads its sheet
   * again). The form checks its drafts against the lines it is given.
   */
  onStale?: () => void;
  onCancel?: () => void;
  /** The token page's honeypot (an off-screen field real people never fill). */
  honeypot?: { value: string; onChange: (value: string) => void };
  /** Keeps element ids unique when a page shows more than one form. */
  idPrefix?: string;
  /** 'page': the token page's cards; 'inline': inside a portal order. */
  density?: 'page' | 'inline';
  submitLabel?: string;
}

const LOADING_SIZES = RETURNS_COPY.requesterLoadingSizes;
const NETWORK_FAILED = 'Could not submit your request. Check your connection and try again.';

/**
 * The requester's "Return or exchange" form (returns RX-3, plan RX-3 Web UI):
 * one implementation for the token page and the B2B portal. Per line: the
 * RETURNING card (photo, name, size, quantity), "What would you like to
 * do?" (Return only, or Exchange for another size), and the REPLACEMENT card
 * with the line's own sizes in size order, each with its photo and
 * "Available" or "Not in stock right now", or, for a line with no sizes to
 * offer, "warehouse will review" with a note. The two cards differ by an
 * accent border, an arrow and their text labels, never by colour alone.
 *
 * The sizes are loaded ONCE, on the first Exchange (brief 44). The
 * idempotency key is minted when the form opens and resent as it is, so a
 * lost answer and a resend replay the same RMA. Every refusal is said in the
 * form beside the button (pattern 20) and moves focus to what to fix.
 * The server re-checks every value (brief 6); the form only keeps the common
 * path off a refusal.
 */
export function RequesterReturnSheetForm({
  lines,
  exchangesEnabled,
  loadOptions,
  submit,
  onSubmitted,
  onStale,
  onCancel,
  honeypot,
  idPrefix = 'requester-return',
  density = 'page',
  submitLabel = RETURNS_COPY.requesterSubmit,
}: RequesterReturnSheetFormProps) {
  const p = idPrefix;
  const [drafts, setDrafts] = React.useState<Record<string, RequesterLineDraft>>(() => initialRequesterDrafts(lines));
  // Lines read again (after a refusal, or a refresh): the drafts are checked
  // against them during render, never in an effect (RX-3 fix round 1, M4).
  const linesKey = lines.map((l) => `${l.orderRequestLineId}:${l.quantityRemaining}`).join('|');
  const [seenLinesKey, setSeenLinesKey] = React.useState(linesKey);
  if (seenLinesKey !== linesKey) {
    setSeenLinesKey(linesKey);
    setDrafts((prev) => reconcileRequesterDrafts(prev, lines));
  }
  const [options, setOptions] = React.useState<RequesterOptionsState>({ status: 'idle' });
  // A refusal in the kill switch's words turns Exchange off for this form.
  const [switchedOff, setSwitchedOff] = React.useState(false);
  const [reasonCode, setReasonCode] = React.useState<ReturnReasonCodeValue | ''>('');
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<{ message: string; lineId: string | null } | null>(null);
  const loadingRef = React.useRef(false);
  // Minted when the form opens (plan RX-3), never per press.
  const keyRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    keyRef.current ??= randomRequestUuid();
  }, []);

  const exchangesOn =
    exchangesEnabled && !switchedOff && !(options.status === 'loaded' && !options.answer.exchangesEnabled);
  const errorId = `${p}-error`;

  async function ensureOptions(force = false) {
    if (loadingRef.current) return;
    if (!force && options.status !== 'idle') return;
    loadingRef.current = true;
    setOptions({ status: 'loading' });
    let outcome: RequesterOptionsOutcome;
    try {
      outcome = await loadOptions();
    } catch {
      outcome = { ok: false, message: RETURNS_COPY.requesterOptionsUnavailable };
    }
    loadingRef.current = false;
    setOptions(outcome.ok ? { status: 'loaded', answer: outcome.answer } : { status: 'failed', message: outcome.message });
    // A size no longer offered is unchosen (the person picks again).
    if (outcome.ok) {
      const answer = outcome.answer;
      setDrafts((prev) => reconcileDraftsWithOptions(prev, answer));
    }
  }

  function update(lineId: string, patch: Partial<RequesterLineDraft>) {
    setDrafts((prev) => {
      const base = prev[lineId];
      return base ? { ...prev, [lineId]: { ...base, ...patch } } : prev;
    });
    if (problem?.lineId === lineId || problem?.lineId === null) setProblem(null);
  }

  function setMode(lineId: string, mode: RequesterLineMode) {
    update(lineId, { mode });
    if (mode === 'exchange') void ensureOptions();
  }

  /** The control to fix for a refusal on this line (or the first box). */
  function targetIdFor(lineId: string | null): string | null {
    if (lineId === null) return lines[0] ? `${p}-sel-${lines[0].orderRequestLineId}` : null;
    const d = drafts[lineId];
    if (!d) return null;
    if (d.mode !== 'exchange') return `${p}-qty-${lineId}`;
    const opts = optionsForLine(options, lineId);
    if (!exchangesOn || opts === null) return `${p}-mode-${lineId}-exchange`;
    if (opts.length > 0) return `${p}-opt-${lineId}-${opts[0]!.itemId}`;
    return `${p}-note-${lineId}`;
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const built = requesterLinesFromDrafts(lines, drafts, { exchangesEnabled: exchangesOn, options });
    if (!built.ok) {
      setProblem({ message: built.message, lineId: built.lineId });
      const target = targetIdFor(built.lineId);
      if (target) document.getElementById(target)?.focus();
      return;
    }
    setProblem(null);
    keyRef.current ??= randomRequestUuid();
    setBusy(true);
    let outcome: RequesterSubmitOutcome;
    try {
      outcome = await submit({
        ...(reasonCode ? { reasonCode } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        lines: built.lines,
        idempotencyKey: keyRef.current,
      });
    } catch {
      outcome = { ok: false, message: NETWORK_FAILED, reason: null };
    }
    setBusy(false);
    if (!outcome.ok) {
      if (outcome.reason === 'exchange_not_available') setSwitchedOff(true);
      // RX-3 fix round 1 (M4, F3, F4): one rule with the phone.
      const recovery = requesterRefusalRecovery(outcome.reason);
      if (recovery === 'restart') {
        // The earlier send with this key went through: start over with
        // nothing chosen and a new key, and read the page again.
        keyRef.current = randomRequestUuid();
        setDrafts(restartRequesterDrafts(lines));
        setOptions({ status: 'idle' });
        setProblem({ message: RETURNS_COPY.requesterEarlierRequestSent, lineId: null });
        onStale?.();
        return;
      }
      setProblem({ message: outcome.message, lineId: null });
      if (recovery === 'reload') {
        // Behind the server: the lines and the sizes again; the key stays
        // (the refused transaction rolled its key row back).
        onStale?.();
        const wantsSizes = Object.values(drafts).some((d) => d.selected && d.mode === 'exchange');
        if (outcome.reason !== 'exchange_not_available' && wantsSizes) void ensureOptions(true);
        else setOptions({ status: 'idle' });
      }
      return;
    }
    onSubmitted({ returnNumber: outcome.returnNumber, replay: outcome.replay, hasExchange: built.hasExchange });
  }

  const page = density === 'page';
  const card = page ? 'bg-card rounded-2xl border p-4 sm:p-5' : 'bg-background rounded-xl border p-3';

  return (
    <form onSubmit={onSubmit} className={page ? 'space-y-6' : 'space-y-3'} noValidate aria-describedby={problem ? errorId : undefined}>
      {honeypot ? (
        // Off-screen; real people never see or fill it (a filled one is answered
        // with a fake success and writes nothing).
        <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', top: 'auto', width: 1, height: 1, overflow: 'hidden' }}>
          <label htmlFor={`${p}-hp`}>Website</label>
          <input
            type="text"
            id={`${p}-hp`}
            name="website"
            tabIndex={-1}
            autoComplete="off"
            value={honeypot.value}
            onChange={(e) => honeypot.onChange(e.target.value)}
          />
        </div>
      ) : null}

      <ul className={page ? 'space-y-4' : 'space-y-3'} aria-label="Items on this order">
        {lines.map((l) => {
          const d = drafts[l.orderRequestLineId];
          if (!d) return null;
          const id = l.orderRequestLineId;
          const label = returnLineLabel(l.name, l.sizeLabel);
          const showReplacement = d.selected && d.mode === 'exchange';
          const problemHere = problem !== null && problem.lineId === id;
          return (
            <li key={id}>
              <div className={cn('grid gap-3', showReplacement && 'md:grid-cols-2')}>
                <article className={cn(card, 'space-y-3')} aria-label={d.selected ? `${RETURNS_COPY.returning}: ${label}` : label}>
                  {d.selected ? (
                    <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
                      <Undo2 className="h-3.5 w-3.5" aria-hidden />
                      <span className="font-mono uppercase tracking-[0.12em]">{RETURNS_COPY.returning}</span>
                    </p>
                  ) : null}
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      id={`${p}-sel-${id}`}
                      checked={d.selected}
                      disabled={busy || l.quantityRemaining < 1}
                      onChange={(e) => update(id, { selected: e.target.checked })}
                      className="mt-1 h-4 w-4 shrink-0"
                    />
                    <label htmlFor={`${p}-sel-${id}`} className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
                      <PhotoBox photo={l.photo} className={page ? 'h-16 w-16 sm:h-20 sm:w-20' : 'h-12 w-12'} />
                      <span className="min-w-0">
                        <span className="block font-medium leading-snug">{l.name}</span>
                        {l.sizeLabel ? <span className="text-muted-foreground block text-sm">{l.sizeLabel}</span> : null}
                        <span className="text-muted-foreground block text-xs tabular-nums">
                          {l.quantityRemaining} of {l.quantityFulfilled} returnable
                        </span>
                      </span>
                    </label>
                  </div>
                  {d.selected ? (
                    <QuantityStepper
                      id={`${p}-qty-${id}`}
                      label="Quantity to return"
                      context={label}
                      value={d.quantity}
                      min={1}
                      max={Math.max(1, l.quantityRemaining)}
                      disabled={busy}
                      invalid={problemHere && targetIdFor(id) === `${p}-qty-${id}`}
                      errorId={errorId}
                      onChange={(quantity) => update(id, { quantity })}
                    />
                  ) : null}
                  {d.selected && exchangesEnabled ? (
                    <fieldset className="space-y-2" disabled={busy}>
                      <legend className="text-sm font-medium">
                        {RETURNS_COPY.whatWouldYouLikeToDo}
                        <span className="sr-only"> ({label})</span>
                      </legend>
                      <div className="flex flex-wrap gap-2">
                        {(
                          [
                            ['return', RETURNS_COPY.returnOnly],
                            ['exchange', RETURNS_COPY.exchangeRequester],
                          ] as const
                        ).map(([mode, words]) => (
                          <label
                            key={mode}
                            htmlFor={`${p}-mode-${id}-${mode}`}
                            className={cn(
                              'inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm',
                              'has-[:checked]:border-primary has-[:checked]:bg-primary/5 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-2',
                              mode === 'exchange' && !exchangesOn && 'cursor-not-allowed opacity-60',
                            )}
                          >
                            <input
                              type="radio"
                              id={`${p}-mode-${id}-${mode}`}
                              name={`${p}-mode-${id}`}
                              value={mode}
                              checked={d.mode === mode}
                              disabled={mode === 'exchange' && !exchangesOn && d.mode !== 'exchange'}
                              onChange={() => setMode(id, mode)}
                              aria-invalid={mode === 'exchange' && problemHere && targetIdFor(id) === `${p}-mode-${id}-exchange` ? true : undefined}
                              aria-describedby={mode === 'exchange' && problemHere ? errorId : undefined}
                              className="h-4 w-4"
                            />
                            {words}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ) : null}
                </article>

                {showReplacement ? (
                  <ReplacementCard
                    p={p}
                    line={l}
                    label={label}
                    draft={d}
                    options={options}
                    exchangesOn={exchangesOn}
                    busy={busy}
                    cardClass={card}
                    problemHere={problemHere}
                    errorId={errorId}
                    onRetry={() => void ensureOptions(true)}
                    onChoose={(itemId) => update(id, { itemId })}
                    onReplacementQuantity={(replacementQuantity) => update(id, { replacementQuantity })}
                    onNote={(note) => update(id, { note })}
                  />
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      <div className={cn(card, 'space-y-4')}>
        <div className="space-y-1.5">
          <Label htmlFor={`${p}-reason`}>Reason (optional)</Label>
          <select
            id={`${p}-reason`}
            value={reasonCode}
            disabled={busy}
            onChange={(e) => setReasonCode(e.target.value as ReturnReasonCodeValue | '')}
            className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
          >
            <option value="">Pick a reason</option>
            {REQUESTER_REASON_OPTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${p}-notes`}>Notes (optional)</Label>
          <Textarea
            id={`${p}-notes`}
            value={notes}
            disabled={busy}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={RETURNS_COPY.requesterNotesPlaceholder}
            rows={3}
            maxLength={2000}
            className="resize-none text-sm"
          />
        </div>
      </div>

      {problem ? (
        <p id={errorId} role="alert" className="text-destructive text-sm">
          {problem.message}
        </p>
      ) : null}

      <div className={cn('flex gap-2', page ? 'flex-col' : 'flex-wrap items-center')}>
        <Button type="submit" disabled={busy || options.status === 'loading'} className={page ? 'w-full' : undefined} size={page ? 'default' : 'sm'}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {busy ? RETURNS_COPY.requesterSending : submitLabel}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" size={page ? 'default' : 'sm'} onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** The REPLACEMENT side of one line: its sizes, or the warehouse-review note. */
function ReplacementCard({
  p,
  line,
  label,
  draft,
  options,
  exchangesOn,
  busy,
  cardClass,
  problemHere,
  errorId,
  onRetry,
  onChoose,
  onReplacementQuantity,
  onNote,
}: {
  p: string;
  line: RequesterReturnableLine;
  label: string;
  draft: RequesterLineDraft;
  options: RequesterOptionsState;
  exchangesOn: boolean;
  busy: boolean;
  cardClass: string;
  problemHere: boolean;
  errorId: string;
  onRetry: () => void;
  onChoose: (itemId: string) => void;
  onReplacementQuantity: (quantity: number) => void;
  onNote: (note: string) => void;
}) {
  const id = line.orderRequestLineId;
  const headingId = `${p}-rep-${id}`;
  const opts = optionsForLine(options, id);
  const quantity = effectiveReplacementQuantity(draft);

  let body: React.ReactNode;
  if (!exchangesOn) {
    body = <p className="text-sm">{RETURNS_COPY.exchangeKillSwitch}</p>;
  } else if (options.status === 'failed') {
    body = (
      <div className="space-y-2" role="alert">
        <p className="text-destructive text-sm">{options.message}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={busy}>
          Try again
        </Button>
      </div>
    );
  } else if (opts === null) {
    body = (
      <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status" aria-live="polite">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        {LOADING_SIZES}
      </p>
    );
  } else if (opts.length > 0) {
    body = (
      <div
        role="radiogroup"
        aria-labelledby={headingId}
        aria-invalid={problemHere ? true : undefined}
        aria-describedby={problemHere ? errorId : undefined}
        className="grid grid-cols-2 gap-2 sm:grid-cols-3"
      >
        {opts.map((o) => (
          <OptionCard key={o.itemId} p={p} lineId={id} option={o} checked={draft.itemId === o.itemId} disabled={busy} onChoose={onChoose} />
        ))}
      </div>
    );
  } else {
    body = (
      <div className="space-y-2">
        <p className="text-sm font-medium">{RETURNS_COPY.warehouseReview}</p>
        <Label htmlFor={`${p}-note-${id}`} className="text-sm font-normal leading-snug">
          {RETURNS_COPY.warehouseReviewNote}
        </Label>
        <Textarea
          id={`${p}-note-${id}`}
          value={draft.note}
          disabled={busy}
          maxLength={RETURN_EXCHANGE_NOTE_MAX}
          rows={3}
          onChange={(e) => onNote(e.target.value)}
          aria-invalid={problemHere ? true : undefined}
          aria-describedby={problemHere ? `${errorId} ${p}-note-count-${id}` : `${p}-note-count-${id}`}
          className="resize-none text-sm"
        />
        <p id={`${p}-note-count-${id}`} className="text-muted-foreground text-right text-xs tabular-nums">
          {draft.note.length}/{RETURN_EXCHANGE_NOTE_MAX}
        </p>
      </div>
    );
  }

  const ready = exchangesOn && opts !== null && options.status === 'loaded';
  return (
    <article className={cn(cardClass, 'border-l-primary space-y-3 border-l-4')} aria-labelledby={headingId}>
      {/* The card's name, not a heading (RX-3 fix round 1, L5: the token page
          went from its h1 straight to an h3 here). */}
      <p id={headingId} className="flex items-center gap-1.5 text-xs font-medium">
        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        <span className="font-mono uppercase tracking-[0.12em]">{RETURNS_COPY.replacement}</span>
        <span className="sr-only"> for {label}</span>
      </p>
      {body}
      {ready ? (
        draft.quantity > 1 ? (
          <QuantityStepper
            id={`${p}-rq-${id}`}
            label={RETURNS_COPY.replacementQuantity}
            context={`replacement for ${label}`}
            value={quantity}
            min={1}
            max={draft.quantity}
            disabled={busy}
            onChange={onReplacementQuantity}
          />
        ) : (
          <p className="text-sm tabular-nums">
            {requesterReplacementQuantityLabel(quantity)}
          </p>
        )
      ) : null}
    </article>
  );
}

/** One size a requester may choose: photo, size, name, availability word. */
function OptionCard({
  p,
  lineId,
  option,
  checked,
  disabled,
  onChoose,
}: {
  p: string;
  lineId: string;
  option: RequesterExchangeOption;
  checked: boolean;
  disabled: boolean;
  onChoose: (itemId: string) => void;
}) {
  const inputId = `${p}-opt-${lineId}-${option.itemId}`;
  const available = option.availability === 'available';
  return (
    <label
      htmlFor={inputId}
      className={cn(
        'flex cursor-pointer flex-col gap-2 rounded-xl border p-2',
        'has-[:checked]:border-primary has-[:checked]:bg-primary/5 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-2',
      )}
    >
      <PhotoBox photo={option.photo} className="aspect-square w-full" />
      <span className="flex items-start gap-2">
        <input
          type="radio"
          id={inputId}
          name={`${p}-opt-${lineId}`}
          value={option.itemId}
          checked={checked}
          disabled={disabled}
          onChange={() => onChoose(option.itemId)}
          className="mt-0.5 h-4 w-4 shrink-0"
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium leading-snug">{option.sizeLabel ?? option.name}</span>
          {option.sizeLabel ? <span className="text-muted-foreground block truncate text-xs">{option.name}</span> : null}
          <span className="mt-0.5 flex items-center gap-1.5 text-xs">
            <span
              aria-hidden
              className={cn('inline-block h-2 w-2 shrink-0 rounded-full', available ? 'bg-success' : 'bg-warning')}
            />
            {REQUESTER_AVAILABILITY_WORDS[option.availability]}
          </span>
        </span>
      </span>
    </label>
  );
}

/** A whole-number stepper (− field +), labelled with the item it is for. */
function QuantityStepper({
  id,
  label,
  context,
  value,
  min,
  max,
  disabled,
  invalid,
  errorId,
  onChange,
}: {
  id: string;
  label: string;
  context: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  invalid?: boolean;
  errorId?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
        <span className="sr-only"> for {context}</span>
      </Label>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => onChange(clampWhole(value - 1, min, max))}
          disabled={disabled || value <= min}
          aria-label={`One fewer: ${label.toLowerCase()} for ${context}`}
        >
          <Minus aria-hidden />
        </Button>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(clampWhole(e.target.value, min, max))}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={invalid ? errorId : undefined}
          className="border-input bg-background h-9 w-16 rounded-md border px-2 text-center text-sm tabular-nums"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => onChange(clampWhole(value + 1, min, max))}
          disabled={disabled || value >= max}
          aria-label={`One more: ${label.toLowerCase()} for ${context}`}
        >
          <Plus aria-hidden />
        </Button>
      </div>
    </div>
  );
}

/**
 * An item's photo, signed for this item only: the stored thumbnail first,
 * then the master, then a placeholder. A photo that fails to load never
 * blocks anything (brief 27). Decorative: the item's words sit beside it.
 */
function PhotoBox({ photo, className }: { photo: RequesterPhoto | null; className?: string }) {
  const sources = React.useMemo(
    () => (photo ? [photo.thumbUrl, photo.url].filter((s): s is string => typeof s === 'string' && s.length > 0) : []),
    [photo],
  );
  const [failed, setFailed] = React.useState(0);
  const src = sources[failed] ?? null;
  return (
    <span
      aria-hidden
      className={cn('bg-muted text-muted-foreground relative flex shrink-0 items-center justify-center overflow-hidden rounded-lg', className)}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- signed storage URL for this item only, sized box
        <img src={src} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" onError={() => setFailed((n) => n + 1)} />
      ) : (
        <ImageOff className="h-5 w-5" />
      )}
    </span>
  );
}
