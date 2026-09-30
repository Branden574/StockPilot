'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  NEEDED_BY_CHANGE_ACCESSIBILITY_LABEL,
  NEEDED_BY_CHANGE_LABEL,
  NEEDED_BY_FIELD_LABEL,
  NEEDED_BY_IN_PAST_COPY,
  NEEDED_BY_NO_ANSWER_COPY,
  NEEDED_BY_REASON_HINT,
  NEEDED_BY_REASON_LABEL,
  NEEDED_BY_REASON_REQUIRED_COPY,
  NEEDED_BY_REVISE_TITLE,
  NEEDED_BY_SAVE_LABEL,
  neededByCurrentCopy,
  neededByEffectCopy,
  neededByRevisedCopy,
  neededByZoneNote,
  normalizeNeededByReason,
  type ActionResult,
  type NeededByRevisionOutcome,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  initialNeededByWallClock,
  maxNeededByWallClock,
  minNeededByWallClock,
  neededByExpectedToSend,
  readNeededByDraft,
  type NeededByChangeView,
} from '@/lib/orders/needed-by-change';
import { openNeededByChange, registerNeededByChangeOpener } from '@/lib/orders/needed-by-change-opener';
import { cn } from '@/lib/utils';
import { reviseOrderNeededByAction } from '@/server/actions/order-requests';

/** Refusals after which the order behind the dialog is read again: it moved
 *  (someone saved another date, it closed, it is gone). */
const REFRESH_ON: ReadonlySet<string> = new Set(['needed_by_changed', 'order_closed', 'not_found']);

/** Outcomes whose confirmation is a warning: the Schedule entry is not where
 *  the order is (left at another date, or not added). */
const WARN_ON: ReadonlySet<string> = new Set(['not_moved', 'not_added']);

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Date.parse(a) === Date.parse(b);
}

/**
 * "Change" beside the needed-by date on the order page (the readiness strip,
 * or the Dates card): opens the dialog the page mounted once
 * (ReviseNeededByDialog with `trigger={false}`), so the button can move or go
 * without taking the open dialog with it.
 */
export function NeededByChangeButton({ orderId, className }: { orderId: string; className?: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn('h-7 px-2 text-xs', className)}
      aria-label={NEEDED_BY_CHANGE_ACCESSIBILITY_LABEL}
      aria-haspopup="dialog"
      data-testid="needed-by-change"
      data-needed-by-change={orderId}
      onClick={(e) => openNeededByChange(orderId, e.currentTarget)}
    >
      {NEEDED_BY_CHANGE_LABEL}
    </Button>
  );
}

/**
 * CHANGE AN ORDER'S NEEDED-BY DATE (F2-4). "Change" beside the date (on the
 * readiness strip, or the Dates card where the strip is not shown) opens this
 * for an approver with write access to the order's warehouse (the page
 * decides: lib/orders/needed-by-change.ts neededByChangeView).
 *
 * The date and time are entered as a WALL CLOCK in the ORGANIZATION's zone,
 * which the dialog names ("Times are in America/Los_Angeles."), never the
 * browser's: a datetime-local value is sent as it is typed and the server
 * converts it in the org's zone. The preview ("New needed-by: Fri, Oct 3,
 * 2:00 PM") is read the same way (core wallClockToInstant, strict), so a time
 * that does not exist there, or one already past, is said before saving.
 *
 * SAVE calls reviseOrderNeededByAction with the needed-by the person SAW when
 * they opened the dialog (the stale check's expected value, exactly as the
 * page read it), never the page's latest value: a realtime refresh behind the
 * dialog must not turn someone else's date into the one this save replaces.
 * A refusal stays in the dialog as an inline alert, in the server's (core's)
 * words, with the typed date and reason kept (pattern #20: a toast alone
 * vanishes outside the dialog). When someone saved another date first
 * (needed_by_changed), the dialog loads that value as the current one, says
 * so, and reads the page again; saving again then replaces THAT date,
 * deliberately. The confirmation is core's sentence about what the server
 * did (the Schedule entry moved, was added, is closed, or could not be
 * updated), never what the dialog expected.
 *
 * Nothing here sends anything to anyone: a revision generates no email or
 * notification (the requester's delivery request draft is unchanged and opens
 * only when they choose it).
 *
 * THE PAGE MOUNTS IT ONCE (`trigger={false}`), at a spot no refresh moves,
 * and puts NeededByChangeButton on the strip or in the Dates card. A realtime
 * refresh can move that button (picking completes: strip to Dates card) or
 * take it away (the readiness read failed, the order closed), and the open
 * dialog stays, with what was typed: when the page stops handing a view
 * (`change` null), an open dialog keeps the last one until it is closed, and
 * then renders nothing. Closing returns focus to the Change button on the page
 * now. An order that is gone (not_found: the page is replaced) is also said
 * as a toast, since the dialog goes with the page.
 *
 * NO ANSWER: after a save that got no answer, the page is read again; when
 * the date on it moved (the save landed, or someone else's did), the dialog
 * starts from that date, as the phone sheet does, so saving again is not
 * refused as "Someone changed this date to <your own date>".
 */
export function ReviseNeededByDialog({
  change,
  trigger = true,
  triggerClassName,
}: {
  /** Null when the page offers no Change (an open dialog keeps its last view). */
  change: NeededByChangeView | null;
  /** Its own Change button (true), or opened by NeededByChangeButton (false). */
  trigger?: boolean;
  triggerClassName?: string;
}) {
  const router = useRouter();
  const ids = React.useId();
  const fieldId = `${ids}-needed-by`;
  const zoneId = `${ids}-zone`;
  const previewId = `${ids}-preview`;
  const reasonId = `${ids}-reason`;
  const reasonHintId = `${ids}-reason-hint`;

  const [open, setOpen] = React.useState(false);
  // The last view the page handed over, kept for an open dialog when the page
  // stops offering Change (adjusted while rendering, as React recommends for
  // state that follows a prop).
  const [lastView, setLastView] = React.useState<NeededByChangeView | null>(change);
  if (change !== null && change !== lastView) setLastView(change);
  const live = change ?? (open ? lastView : null);
  const [value, setValue] = React.useState('');
  const [reason, setReason] = React.useState('');
  // The needed-by this edit started from: the page's value when the dialog
  // opened, then the server's current value after a stale refusal.
  const [seen, setSeen] = React.useState<string | null>(change?.neededBy ?? null);
  // After a save that got no answer: the page's date then. When the page, read
  // again, shows another date, the dialog starts from it.
  const [adoptFrom, setAdoptFrom] = React.useState<{ from: string | null } | null>(null);
  if (adoptFrom !== null && change !== null && !sameInstant(change.neededBy, adoptFrom.from)) {
    setAdoptFrom(null);
    setSeen(change.neededBy);
  }
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [minValue, setMinValue] = React.useState('');
  const [maxValue, setMaxValue] = React.useState('');
  // The Change button that opened it (NeededByChangeButton), for focus.
  const openedBy = React.useRef<HTMLElement | null>(null);

  const zone = live?.timeZone ?? '';
  const orderId = live?.orderId ?? null;
  // Read on every render: "still to come" is judged against the clock now.
  const draft = readNeededByDraft(value, zone, Date.now());

  function onOpenChange(next: boolean) {
    // Never dismissed while a save is in flight: its answer is still to come.
    if (saving) return;
    if (next) {
      if (!live) return;
      // A fresh start each time: the date may have changed since last time.
      const now = Date.now();
      setValue(initialNeededByWallClock(live.neededBy, live.timeZone, now));
      setMinValue(minNeededByWallClock(live.timeZone, now));
      setMaxValue(maxNeededByWallClock(live.timeZone, now));
      setReason('');
      setSeen(live.neededBy);
      setAdoptFrom(null);
      setError(null);
    }
    setOpen(next);
  }

  // Opened by NeededByChangeButton, wherever the page puts it.
  const openFromButton = React.useEffectEvent((button: HTMLElement | null) => {
    openedBy.current = button;
    onOpenChange(true);
  });
  React.useEffect(() => {
    if (trigger || orderId === null) return;
    return registerNeededByChangeOpener(orderId, (button) => openFromButton(button));
  }, [trigger, orderId]);

  function returnFocus(e: Event) {
    // Its own trigger: Radix returns focus to it.
    if (trigger) return;
    e.preventDefault();
    const opener = openedBy.current;
    const target =
      opener && opener.isConnected
        ? opener
        : orderId
          ? document.querySelector<HTMLElement>(`[data-needed-by-change="${orderId}"]`)
          : null;
    target?.focus();
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving || !live) return;
    const now = Date.now();
    const checked = readNeededByDraft(value, zone, now);
    if (checked.kind === 'empty') {
      setError(NEEDED_BY_IN_PAST_COPY);
      return;
    }
    if (checked.kind !== 'ok') {
      setError(checked.message);
      return;
    }
    if (normalizeNeededByReason(reason) === null) {
      setError(NEEDED_BY_REASON_REQUIRED_COPY);
      return;
    }
    setError(null);
    setAdoptFrom(null);
    setSaving(true);
    // null: the action never answered.
    let res: ActionResult<NeededByRevisionOutcome> | null;
    try {
      res = await reviseOrderNeededByAction({
        id: live.orderId,
        neededByLocal: value,
        expectedNeededBy: neededByExpectedToSend(seen, live.neededBy),
        reason,
      });
    } catch {
      res = null;
    }
    setSaving(false);
    if (!res) {
      // Whether it was saved is unknown: say so, and show the order as it is.
      // When the page read again shows another date, the dialog starts from it.
      setError(NEEDED_BY_NO_ANSWER_COPY);
      setAdoptFrom({ from: live.neededBy });
      router.refresh();
      return;
    }
    if (!res.ok) {
      const details = res.error.details ?? {};
      const why = typeof details.reason === 'string' ? details.reason : '';
      if (why === 'needed_by_changed') {
        // Someone else's date is now the one this edit replaces (the
        // function's exact text: it goes back as the next expected value).
        setSeen(typeof details.current === 'string' ? details.current : null);
      }
      setError(res.error.message);
      // The page it sits on is replaced by "not found", and the dialog with it.
      if (why === 'not_found') toast.error(res.error.message);
      if (REFRESH_ON.has(why)) router.refresh();
      return;
    }
    const outcome = res.data;
    const sentence = neededByRevisedCopy(outcome);
    if (WARN_ON.has(outcome.schedule)) toast.warning(sentence, { duration: 8000 });
    else if (outcome.schedule === 'unchanged') toast.info(sentence);
    else toast.success(sentence);
    setOpen(false);
    router.refresh();
  }

  const describedBy = [zoneId, previewId].join(' ');
  const fieldInvalid = draft.kind === 'invalid' || draft.kind === 'past';

  if (!live) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && (
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn('h-7 px-2 text-xs', triggerClassName)}
            aria-label={NEEDED_BY_CHANGE_ACCESSIBILITY_LABEL}
            data-testid="needed-by-change"
          >
            {NEEDED_BY_CHANGE_LABEL}
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="max-w-md" data-testid="revise-needed-by-dialog" onCloseAutoFocus={returnFocus}>
        <form onSubmit={(e) => void save(e)} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{NEEDED_BY_REVISE_TITLE}</DialogTitle>
            <DialogDescription data-testid="revise-needed-by-current">
              {neededByCurrentCopy(seen, zone)}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label htmlFor={fieldId}>{NEEDED_BY_FIELD_LABEL}</Label>
            <Input
              id={fieldId}
              type="datetime-local"
              value={value}
              min={minValue || undefined}
              max={maxValue || undefined}
              onChange={(e) => setValue(e.target.value)}
              aria-describedby={describedBy}
              aria-invalid={fieldInvalid || undefined}
              disabled={saving}
              data-testid="revise-needed-by-input"
            />
            <p id={zoneId} className="text-muted-foreground text-xs" data-testid="revise-needed-by-zone">
              {neededByZoneNote(zone)}
            </p>
            {/* What the field reads as, in the org's zone, as it is typed.
                Mounted from the start so a screen reader announces changes. */}
            <p
              id={previewId}
              aria-live="polite"
              className={cn(
                'min-h-5 text-sm',
                draft.kind === 'ok' ? 'font-medium' : 'text-amber-800 dark:text-amber-300',
              )}
              data-testid="revise-needed-by-preview"
              data-kind={draft.kind}
            >
              {draft.kind === 'ok' ? draft.preview : draft.kind === 'empty' ? '' : draft.message}
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor={reasonId}>{NEEDED_BY_REASON_LABEL}</Label>
            <Textarea
              id={reasonId}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-describedby={reasonHintId}
              aria-required
              rows={3}
              disabled={saving}
              data-testid="revise-needed-by-reason"
            />
            <p id={reasonHintId} className="text-muted-foreground text-xs">
              {NEEDED_BY_REASON_HINT}
            </p>
          </div>

          <p className="text-muted-foreground text-xs" data-testid="revise-needed-by-effect">
            {neededByEffectCopy(live.status)}
          </p>

          {error && (
            <p role="alert" className="text-destructive text-sm" data-testid="revise-needed-by-error">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving} data-testid="revise-needed-by-save">
              {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              {NEEDED_BY_SAVE_LABEL}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
