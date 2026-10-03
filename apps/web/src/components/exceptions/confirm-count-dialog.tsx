'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import {
  CONFIRM_COUNT_INSTEAD_LABEL,
  CONFIRM_COUNT_LABEL,
  confirmCountDialogCopy,
  confirmCountSuccessCopy,
  describeConfirmError,
  type CountConfirmBlock,
  type RecountAbility,
} from '@stockpilot/core';

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
import { confirmExceptionCountAction } from '@/server/actions/exceptions';

/**
 * CONFIRM THIS COUNT, on the web (count differences R2, migration 0386).
 *
 * A count difference (count_variance) closes at once when the person who
 * counted it, or a manager, confirms the counted number, without a second
 * count (the owner accepted that a mistyped count can then close). This
 * module is the web's whole confirm flow:
 *
 *   - ConfirmCountProvider wraps one exception's page. It holds the dialog,
 *     so both ways in open the same one: Confirm this count on the "What
 *     clears this" card, and Confirm this count instead in the Acknowledge
 *     step, which carries the note typed there. It stays mounted when the
 *     page refreshes after a confirm, so the success line survives the row
 *     turning resolved (the card and the buttons are gone by then).
 *   - `offered` is core countVarianceClearCopy's offerConfirm for this row
 *     and reader, the same value the card words itself by (pattern #26: one
 *     predicate). It is true only while the server's countConfirm block says
 *     this reader can confirm a confirmable row; the database
 *     (exception_confirm_count) re-checks all of it under the org's sync lock.
 *   - The dialog shows the numbers the server sent (core
 *     confirmCountDialogCopy) and sends back exactly the count and the
 *     counted number it showed, so a count posted in between is refused
 *     (count_changed), never confirmed unseen.
 *
 * SENT ONCE, EVEN WHEN PRESSED TWICE. A press while a send is in flight does
 * nothing (a ref, not only the disabled button: two clicks can land before
 * React re-renders). A lost answer keeps the dialog open with its payload, so
 * pressing again resends the same count, number and note, which the server
 * answers as a replay of the confirm that already landed.
 *
 * Refusals show inline with role="alert" (pattern #20), worded by core
 * describeConfirmError from the action's `reason`, never from message text.
 * A refusal that is not about the confirm itself (the app's act gate, the
 * rate limit, a note the server refused, a server problem) keeps the
 * action's words, the ones the page's other exception actions show. Closing
 * the dialog after a refusal or no answer refreshes the page, so it shows the
 * row as it now is instead of the Confirm that was just refused.
 *
 * Online only and never queued, like every other exception action.
 */

interface ConfirmCountContextValue {
  /** Confirm is offered to this reader on this row. */
  offered: boolean;
  /** Opens the dialog; `note` is carried over from the Acknowledge step, and
   *  `opener` is the button pressed (focus returns to it on Cancel). */
  openConfirm: (note?: string, opener?: HTMLElement | null) => void;
  /** "Count confirmed. EX-000059 is closed." once a confirm succeeded. */
  success: string | null;
  statusRef: React.RefObject<HTMLParagraphElement | null>;
}

const ConfirmCountContext = React.createContext<ConfirmCountContextValue | null>(null);

/** Reasons whose words are the action's own message: not refusals of the
 *  confirm itself but of the request (the rate limit, a note or a payload
 *  the server refused). No reason at all (not found, the app's act gate, a
 *  server problem) is the action's message too. The database's act gate
 *  (not_permitted) is core's, as on the phone. */
const ACTION_WORDED_REASONS: ReadonlySet<string> = new Set([
  'rate_limited',
  'note_too_long',
  'invalid_argument',
]);

/** When the action request itself failed (no answer): the web's words for it. */
const NO_ANSWER_COPY = 'Could not reach the server. Try again.';

export function ConfirmCountProvider({
  occurrenceId,
  reference,
  confirm,
  offered,
  recountAbility,
  recountNumber,
  children,
}: {
  occurrenceId: string;
  reference: string | null;
  /** The server's countConfirm block; null when the feature is off or the
   *  row is not an open count difference. */
  confirm: CountConfirmBlock | null;
  /** The card's offerConfirm for this row and reader (countVarianceClearCopyFor). */
  offered: boolean;
  /** Whether this reader can start a recount (for the refusal words). */
  recountAbility: RecountAbility;
  /** The linked recount's number, for the recount_in_progress refusal. */
  recountNumber: number | null;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [initialNote, setInitialNote] = React.useState('');
  const [success, setSuccess] = React.useState<string | null>(null);
  const statusRef = React.useRef<HTMLParagraphElement | null>(null);
  // Written by the dialog body: a send is in flight, so nothing closes it.
  const busyRef = React.useRef(false);
  // Set on success, read once when the dialog hands focus back.
  const succeededRef = React.useRef(false);
  // The button that opened the dialog: focus goes back to it on Cancel (the
  // dialog has no Radix trigger to return to). Passed in by the button: Safari
  // and Firefox on macOS do not focus a button on a mouse click, so the
  // focused element is then the page itself.
  const openerRef = React.useRef<HTMLElement | null>(null);
  // A send was refused or got no answer: the page behind the dialog may be
  // stale (the row resolved, a newer count, the stock moved, or the confirm
  // landed), so closing the dialog refreshes it. Not on the refusal itself:
  // a refresh that turns the block null would close the dialog and take its
  // words with it.
  const staleRef = React.useRef(false);

  const canOpen = offered && confirm !== null;
  const openConfirm = React.useCallback(
    (note?: string, opener?: HTMLElement | null) => {
      if (!canOpen) return;
      openerRef.current =
        opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      setInitialNote(note ?? '');
      setOpen(true);
    },
    [canOpen],
  );
  const value = React.useMemo(
    () => ({ offered: canOpen, openConfirm, success, statusRef }),
    [canOpen, openConfirm, success],
  );

  function onOpenChange(next: boolean) {
    if (!next && busyRef.current) return;
    setOpen(next);
    if (!next && staleRef.current) {
      staleRef.current = false;
      router.refresh();
    }
  }

  function onFailed() {
    staleRef.current = true;
  }

  function onConfirmed(message: string) {
    staleRef.current = false;
    succeededRef.current = true;
    setSuccess(message);
    setOpen(false);
    router.refresh();
  }

  return (
    <ConfirmCountContext.Provider value={value}>
      {children}
      <Dialog open={open && confirm !== null} onOpenChange={onOpenChange}>
        {open && confirm !== null ? (
          <ConfirmCountDialogBody
            occurrenceId={occurrenceId}
            reference={reference}
            confirm={confirm}
            initialNote={initialNote}
            recountAbility={recountAbility}
            recountNumber={recountNumber}
            busyRef={busyRef}
            onCancel={() => onOpenChange(false)}
            onFailed={onFailed}
            onConfirmed={onConfirmed}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              if (succeededRef.current) {
                // After a confirm the button that opened this is gone (the
                // row is resolved): the reader lands on the success line.
                succeededRef.current = false;
                statusRef.current?.focus();
                return;
              }
              const opener = openerRef.current;
              if (opener?.isConnected) opener.focus();
            }}
          />
        ) : null}
      </Dialog>
    </ConfirmCountContext.Provider>
  );
}

function ConfirmCountDialogBody({
  occurrenceId,
  reference,
  confirm,
  initialNote,
  recountAbility,
  recountNumber,
  busyRef,
  onCancel,
  onFailed,
  onConfirmed,
  onCloseAutoFocus,
}: {
  occurrenceId: string;
  reference: string | null;
  confirm: CountConfirmBlock;
  initialNote: string;
  recountAbility: RecountAbility;
  recountNumber: number | null;
  busyRef: React.RefObject<boolean>;
  onCancel: () => void;
  /** A send was refused or got no answer. */
  onFailed: () => void;
  onConfirmed: (message: string) => void;
  onCloseAutoFocus: (e: Event) => void;
}) {
  const copy = confirmCountDialogCopy({ reference, confirm });
  const [note, setNote] = React.useState(initialNote);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const noteRef = React.useRef<HTMLTextAreaElement | null>(null);
  const noteId = React.useId();
  const counterId = React.useId();

  const trimmed = note.trim();
  const length = Array.from(trimmed).length;
  const tooLong = length > copy.noteMax;

  async function submit() {
    // The ref, not `pending`: a second click can land before the re-render
    // that disables the button.
    if (busyRef.current || tooLong) return;
    busyRef.current = true;
    setPending(true);
    setError(null);
    let res: Awaited<ReturnType<typeof confirmExceptionCountAction>>;
    try {
      // Exactly the count and the number this dialog showed.
      res = await confirmExceptionCountAction(occurrenceId, {
        cycleCountId: confirm.cycleCountId,
        countedQuantity: confirm.counted,
        note: trimmed === '' ? null : trimmed,
      });
    } catch {
      // No answer: it may have landed. The payload is kept, so pressing again
      // resends it and the server answers the replay.
      setError(NO_ANSWER_COPY);
      onFailed();
      return;
    } finally {
      busyRef.current = false;
      setPending(false);
    }
    if ('error' in res) {
      onFailed();
      const reason = res.error.reason;
      setError(
        reason === null || ACTION_WORDED_REASONS.has(reason)
          ? res.error.message
          : describeConfirmError(reason, {
              surface: 'web',
              recount: recountAbility,
              recountNumber,
              counterLabel: confirm.countedBy?.label ?? null,
            }),
      );
      return;
    }
    onConfirmed(confirmCountSuccessCopy(res.reference ?? reference));
  }

  return (
    <DialogContent
      className="max-w-lg"
      data-testid="confirm-count-dialog"
      onOpenAutoFocus={(e) => {
        // The note, never Confirm and close: nothing closes by a stray Enter.
        e.preventDefault();
        noteRef.current?.focus();
      }}
      onCloseAutoFocus={onCloseAutoFocus}
      onEscapeKeyDown={(e) => {
        if (busyRef.current) e.preventDefault();
      }}
      onInteractOutside={(e) => {
        if (busyRef.current) e.preventDefault();
      }}
    >
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
      </DialogHeader>

      <div className="space-y-4 text-sm">
        {/* The numbers and the consequence are the dialog's description, so a
            screen reader says what is being confirmed as the dialog opens. */}
        <DialogDescription asChild className="text-foreground">
          <div className="space-y-4" data-testid="confirm-count-description">
            <div className="bg-muted/40 space-y-1.5 rounded-md border p-3" data-testid="confirm-count-numbers">
              <ul className="space-y-0.5">
                {copy.numbers.map((line) => (
                  <li key={line} className="tabular-nums">
                    {line}
                  </li>
                ))}
              </ul>
              {copy.who ? <p className="text-muted-foreground">{copy.who}</p> : null}
            </div>
            <p>{copy.consequence}</p>
          </div>
        </DialogDescription>

        <div className="space-y-1.5">
          <Label htmlFor={noteId}>{copy.noteLabel}</Label>
          <Textarea
            id={noteId}
            ref={noteRef}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              setError(null);
            }}
            rows={3}
            placeholder={copy.notePlaceholder}
            disabled={pending}
            aria-describedby={counterId}
            aria-invalid={tooLong || undefined}
          />
          <p id={counterId} className={tooLong ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
            {length.toLocaleString('en-US')} / {copy.noteMax.toLocaleString('en-US')}
          </p>
        </div>

        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      <DialogFooter className="gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending} className="pointer-coarse:min-h-11">
          {copy.cancelLabel}
        </Button>
        <Button
          type="button"
          onClick={() => void submit()}
          disabled={pending || tooLong}
          aria-busy={pending || undefined}
          className="pointer-coarse:min-h-11"
          data-testid="confirm-count-submit"
        >
          {pending ? copy.pendingLabel : copy.confirmLabel}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** Confirm this count, the filled button on the "What clears this" card.
 *  Nothing when this reader is not offered Confirm. */
export function ConfirmCountButton() {
  const ctx = React.useContext(ConfirmCountContext);
  if (!ctx?.offered) return null;
  return (
    <Button
      type="button"
      variant="default"
      size="default"
      className="pointer-coarse:min-h-11"
      onClick={(e) => ctx.openConfirm(undefined, e.currentTarget)}
      data-testid="confirm-count-button"
    >
      {CONFIRM_COUNT_LABEL}
    </Button>
  );
}

/** Confirm this count instead, in the Acknowledge step: opens the same dialog
 *  with the note typed there. Nothing when this reader is not offered
 *  Confirm. */
export function ConfirmCountInsteadButton({ note, disabled = false }: { note: string; disabled?: boolean }) {
  const ctx = React.useContext(ConfirmCountContext);
  if (!ctx?.offered) return null;
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto px-0 py-1 text-sm pointer-coarse:min-h-11"
      disabled={disabled}
      onClick={(e) => ctx.openConfirm(note, e.currentTarget)}
      data-testid="confirm-count-instead"
    >
      {CONFIRM_COUNT_INSTEAD_LABEL}
    </Button>
  );
}

/** The line a successful confirm leaves at the top of the page (role
 *  "status", so it is announced), and where focus lands after the dialog. */
export function ConfirmCountStatus() {
  const ctx = React.useContext(ConfirmCountContext);
  const message = ctx?.success ?? null;
  return (
    <p
      ref={ctx?.statusRef}
      role="status"
      tabIndex={-1}
      data-testid="confirm-count-status"
      className={
        message
          ? 'border-success/40 bg-success/10 rounded-md border px-3 py-2 text-sm font-medium outline-none'
          : 'sr-only'
      }
    >
      {message}
    </p>
  );
}
