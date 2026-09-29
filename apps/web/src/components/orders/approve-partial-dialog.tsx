'use client';

import { Loader2, PackageCheck, RotateCcw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  describePartialPreview,
  describePartialResult,
  PARTIAL_ACTION_TITLE,
  PARTIAL_CLOSE_LABEL,
  PARTIAL_COMMIT_UNANSWERED_COPY,
  readinessCheckedAtCopy,
  type ActionResult,
  type OrderReadinessResult,
  type PartialPreview,
  type PartialResultCopy,
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
import { cn } from '@/lib/utils';
import { readOrderReadinessAction } from '@/server/actions/order-readiness';
import { approveOrderPartialAction, resumeFulfillmentAction } from '@/server/actions/order-requests';

import { READINESS_TONE_STYLES } from './readiness-view';

type Step =
  | { step: 'preview'; error: string | null }
  | { step: 'committing' }
  | { step: 'done'; result: PartialResultCopy };

/**
 * APPROVE PARTIAL AND RESUME, WITH A PREVIEW (F2-3). Opened by the order
 * page's existing "Approve partial" (pending_approval) and "Resume fulfillment"
 * (backordered) buttons, instead of committing on the first click.
 *
 * BEFORE: what the action would hold now, per ITEM (core
 * previewPartialFulfilment, the frozen RPCs' twin: duplicate lines are
 * combined, never split), the total that ships when it arrives, and "Picking
 * takes what's on the shelf; the rest ships when it arrives.", with when the
 * stock was checked. `preview` is the page's own readiness read (the strip's
 * "Checked at"), computed on the server; the panel hands over a snapshot taken
 * when the dialog opened, so the page refreshing after the commit cannot change
 * what the result is compared with.
 *
 * CONFIRM calls the EXISTING action, unchanged (approveOrderPartialAction /
 * resumeFulfillmentAction: approve_partial and resume_fulfillment re-check
 * stock inside their own transactions). Then it reads readiness AGAIN
 * (readOrderReadinessAction) and says what was held from THAT read, the order's
 * own holds (core describePartialResult), never from the preview: "Approved.
 * Holding 34 of 40 units, 2 fewer than shown because stock changed after you
 * looked." A re-read that fails claims no number.
 *
 * A refusal stays in the dialog as an inline alert (pattern #20: a toast
 * alone disappears outside the dialog) and nothing is re-read. The dialog
 * cannot be dismissed while the commit and the re-read are in flight.
 *
 * An unavailable preview (a failed read, an item the viewer cannot see, an
 * item that moved warehouse, nothing free to resume: the page's stock gates
 * already disable the button for each) shows core's reason and offers no
 * confirm.
 */
export function ApprovePartialDialog({
  orderId,
  preview,
  timeZone,
  open,
  onOpenChange,
}: {
  orderId: string;
  /** The preview as it was when the dialog opened (core previewPartialFulfilment). */
  preview: PartialPreview;
  /** The org's zone, for "Checked at" (the strip's zone). */
  timeZone: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [state, setState] = React.useState<Step>({ step: 'preview', error: null });
  const copy = describePartialPreview(preview);
  const committing = state.step === 'committing';
  const ConfirmIcon = preview.action === 'resume' ? RotateCcw : PackageCheck;

  async function confirm() {
    if (preview.state !== 'ok' || committing) return;
    setState({ step: 'committing' });
    let res: ActionResult<void>;
    try {
      res =
        preview.action === 'approve_partial'
          ? await approveOrderPartialAction({ id: orderId })
          : await resumeFulfillmentAction({ id: orderId });
    } catch {
      // A server action that never answered (the network dropped, the
      // deploy changed under the tab): whether it committed is unknown, so
      // core's sentence says to look before trying again.
      res = { ok: false, error: { code: 'internal_error', message: PARTIAL_COMMIT_UNANSWERED_COPY } };
    }
    if (!res.ok) {
      toast.error(res.error.message);
      setState({ step: 'preview', error: res.error.message });
      return;
    }
    // Committed. What was held is READ, never echoed from the preview.
    let reread: OrderReadinessResult | null;
    try {
      reread = await readOrderReadinessAction({ id: orderId });
    } catch {
      reread = null;
    }
    setState({ step: 'done', result: describePartialResult({ action: preview.action, preview, reread }) });
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (committing) return;
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-lg" data-testid="approve-partial-dialog" data-action={preview.action}>
        <DialogHeader>
          <DialogTitle>{copy?.title ?? PARTIAL_ACTION_TITLE[preview.action]}</DialogTitle>
          {state.step === 'done' ? null : copy ? (
            <DialogDescription data-testid="approve-partial-summary">{copy.summary}</DialogDescription>
          ) : (
            <DialogDescription data-testid="approve-partial-unavailable">
              {preview.state === 'unavailable' ? preview.message : null}
            </DialogDescription>
          )}
        </DialogHeader>

        {/* The result's live region is mounted from the start (empty until
            the re-read answers), so a screen reader announces the result
            when it is filled in; a region inserted with its text already in
            it is not reliably announced. */}
        <div role="status" aria-live="polite" data-testid="approve-partial-status">
          {state.step === 'done' && (
            <DialogDescription asChild>
              <p
                className={cn(
                  'rounded-lg px-3 py-2 text-sm font-medium',
                  READINESS_TONE_STYLES[state.result.tone].band,
                  READINESS_TONE_STYLES[state.result.tone].text,
                )}
                data-testid="approve-partial-result"
                data-tone={state.result.tone}
              >
                {state.result.text}
              </p>
            </DialogDescription>
          )}
        </div>

        {state.step !== 'done' && copy && preview.state === 'ok' && (
          <div className="space-y-3">
            <ul
              className="border-border divide-border max-h-72 divide-y overflow-y-auto rounded-lg border text-sm"
              data-testid="approve-partial-items"
            >
              {copy.items.map((it) => (
                <li
                  key={it.itemId}
                  className="flex items-baseline justify-between gap-3 px-3 py-2"
                  data-testid="approve-partial-item"
                >
                  <span className="sr-only">{it.accessibilityLabel}</span>
                  <span aria-hidden className="min-w-0 break-words font-medium">
                    {it.label}
                  </span>
                  <span aria-hidden className="text-muted-foreground shrink-0 tabular-nums">
                    {it.detail}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-xs" data-testid="approve-partial-note">
              {copy.note}
            </p>
            <p className="text-muted-foreground text-[11px]" data-testid="approve-partial-checked-at">
              {readinessCheckedAtCopy(preview.observedAt, { timeZone })}
            </p>
          </div>
        )}

        {state.step === 'preview' && state.error && (
          <p
            role="alert"
            className="text-destructive text-sm"
            data-testid="approve-partial-error"
          >
            {state.error}
          </p>
        )}

        <DialogFooter>
          {state.step === 'done' || !copy ? (
            <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="approve-partial-close">
              {PARTIAL_CLOSE_LABEL}
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={committing}>
                {copy.cancelLabel}
              </Button>
              <Button
                variant="gradient"
                onClick={() => void confirm()}
                disabled={committing}
                data-testid="approve-partial-confirm"
              >
                {committing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <ConfirmIcon className="h-3.5 w-3.5" aria-hidden />
                )}
                {copy.confirmLabel}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
