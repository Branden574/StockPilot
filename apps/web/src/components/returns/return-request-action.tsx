'use client';

import { Copy, Mail, MailOpen } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import {
  brandDeliveryRecipients,
  ccNotice,
  prepareReturnRequestEmail,
  RETURN_REQUEST_COPY,
  returnRequestCopiedMessage,
  type DeliveryRequestRecipients,
  type OrgEmailRoutingRecipientsDto,
  type ReturnRequestEmailContent,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { isControlFlow } from '@/lib/control-flow';
// The isomorphic reporter: this module is in a browser bundle.
import { reportError } from '@/lib/error-reporter-core';
import { recordReturnRequestDraftedAction } from '@/server/actions/return-request';

/**
 * The return request email (F14): one return, as a prefilled draft to the
 * organization's saved delivery-request mailboxes.
 *
 * What it does: opens a draft. What it never does: send anything, create a
 * ticket, or say that either happened. StockPilot has no channel back from
 * the mail client, so "opened" is the only thing it reports.
 *
 * It follows the maintenance request's component
 * (components/maintenance/maintenance-email-action.tsx) step for step, and
 * that file explains each rule at length:
 *
 *  - window.open is the first thing the click does after the length check
 *    (anything awaited first and the browser blocks the pop-up);
 *  - no 'noopener' in the features string (window.open would answer null on
 *    success too); the opener is cut by hand afterwards;
 *  - a blocked pop-up falls back to ONE mailto: navigation per visit and a
 *    recovery panel;
 *  - only an open the browser confirmed is recorded on the server;
 *  - a draft too long for a link opens nothing; Copy details is always whole.
 *
 * One thing differs. A second draft is warned about in place (the order
 * assistant's way) and not behind a confirmation dialog, because this
 * component already lives inside a dialog. The warning shows as soon as one
 * draft was opened, so it is read before the second press, not after it.
 *
 * The words are core's RETURN_REQUEST_COPY, shared with the phone.
 */
export interface ReturnRequestActionProps {
  /** The order the return is on: the record is keyed to it. A hint only; the
   *  server checks it against the caller's organization. */
  orderId: string;
  /** Which screen this is on (stored with the record). */
  surface: 'order' | 'return';
  /** What the draft says: only what this viewer's page already shows. */
  content: ReturnRequestEmailContent;
  /** The organization's resolved delivery-request routing, as plain strings.
   *  Re-validated here; a value the factory refuses renders nothing. */
  recipients: OrgEmailRoutingRecipientsDto;
}

export function ReturnRequestAction({ recipients, ...rest }: ReturnRequestActionProps) {
  // Fail closed on a value the factory refuses: render nothing and report it,
  // never fall back to another mailbox.
  const branded = React.useMemo<DeliveryRequestRecipients | null>(() => {
    try {
      return brandDeliveryRecipients(recipients);
    } catch (e) {
      void reportError(e, { tag: 'returns.return-request.brand' });
      return null;
    }
  }, [recipients]);
  if (!branded) return null;
  return <ReturnRequestActionInner {...rest} branded={branded} />;
}

function ReturnRequestActionInner({
  orderId,
  surface,
  content,
  branded,
}: Omit<ReturnRequestActionProps, 'recipients'> & { branded: DeliveryRequestRecipients }) {
  // Pure and deterministic; no options, so it is measured against the web
  // link this component opens.
  const prepared = React.useMemo(
    () => prepareReturnRequestEmail({ ...content, recipients: branded }),
    [content, branded],
  );

  const [blocked, setBlocked] = React.useState(false);
  const [manualText, setManualText] = React.useState<string | null>(null);
  const [announcement, setAnnouncement] = React.useState('');
  // Drafts opened for this return in this visit. A send cannot be seen, so a
  // repeat is warned about, never refused.
  const [draftCount, setDraftCount] = React.useState(0);
  // One automatic mailto: navigation per visit (a second would open a second
  // draft while the first prompt is still up).
  const mailtoAttemptedRef = React.useRef(false);

  function openDraft() {
    if (!prepared.linkFits) return; // The oversized note below is the answer.

    let opened: Window | null = null;
    try {
      opened = window.open(prepared.outlookUrl, '_blank');
      if (opened) {
        try {
          opened.opener = null;
        } catch {
          // A cross-origin handle can refuse; cutting the opener is best-effort.
        }
      }
    } catch {
      opened = null;
    }

    if (opened) {
      setBlocked(false);
      setDraftCount((n) => n + 1);
      // After the open, never before it. Best-effort: the person already has
      // their draft, so a failed record is a breadcrumb and nothing more.
      void recordReturnRequestDraftedAction({
        orderId,
        returnNumber: content.returnNumber,
        isCondensed: prepared.draft.condensed,
        surface,
      }).catch((e: unknown) => {
        if (isControlFlow(e)) return;
        void reportError(e, { tag: 'returns.return-request.record', level: 'warning' });
      });
      toast.success(RETURN_REQUEST_COPY.success);
      setAnnouncement(RETURN_REQUEST_COPY.success);
      return;
    }

    // Blocked. Not recorded: nothing confirmed that a mail app opened. The
    // local count still goes up, since the mailto: below may have opened one.
    setBlocked(true);
    setAnnouncement(RETURN_REQUEST_COPY.blocked);
    if (!mailtoAttemptedRef.current) {
      mailtoAttemptedRef.current = true;
      setDraftCount((n) => n + 1);
      try {
        window.location.assign(prepared.mailtoUrl);
      } catch {
        // The panel below is the recovery.
      }
    }
  }

  function openDefaultEmailApp() {
    try {
      window.location.assign(prepared.mailtoUrl);
    } catch {
      // Copy details remains.
    }
  }

  async function handleCopy() {
    const text = prepared.clipboardText;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setManualText(null);
      const message = returnRequestCopiedMessage(prepared.draft);
      toast.success(message);
      setAnnouncement(message);
    } catch {
      setManualText(text);
      toast.error(RETURN_REQUEST_COPY.copyFailure);
      setAnnouncement(RETURN_REQUEST_COPY.copyFailure);
    }
  }

  const noteClass = 'rounded-md border px-3 py-2 text-[13px] leading-[19.5px]';

  return (
    <div className="space-y-3" data-testid="return-request-action">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={openDraft} disabled={!prepared.linkFits}>
          <Mail className="h-4 w-4" aria-hidden="true" />
          {RETURN_REQUEST_COPY.primary}
        </Button>
        <Button type="button" variant="outline" onClick={() => void handleCopy()}>
          <Copy className="h-4 w-4" aria-hidden="true" />
          {RETURN_REQUEST_COPY.copy}
        </Button>
        {prepared.linkFits ? (
          <Button type="button" variant="outline" onClick={openDefaultEmailApp}>
            <MailOpen className="h-4 w-4" aria-hidden="true" />
            {RETURN_REQUEST_COPY.defaultApp}
          </Button>
        ) : null}
      </div>

      {/* Always visible, before any press: what this does and does not do. */}
      <p className={`border-border bg-sunk text-muted-foreground ${noteClass}`} data-testid="return-request-notice">
        {RETURN_REQUEST_COPY.honesty}
      </p>
      <p className="text-muted-foreground text-[13px] leading-[19.5px]" data-testid="return-request-recipients">
        {ccNotice(prepared.draft)}
      </p>

      {draftCount > 0 ? (
        <p
          className={`border-warning/30 bg-warning-wash text-foreground ${noteClass}`}
          data-testid="return-request-repeat"
        >
          {RETURN_REQUEST_COPY.duplicate}
        </p>
      ) : null}

      {prepared.draft.condensed && prepared.linkFits ? (
        <p className={`border-border bg-sunk text-muted-foreground ${noteClass}`}>
          {RETURN_REQUEST_COPY.condensed}
        </p>
      ) : null}

      {!prepared.linkFits ? (
        <p className={`border-warning/30 bg-warning-wash text-foreground ${noteClass}`}>
          {RETURN_REQUEST_COPY.oversized}
        </p>
      ) : null}

      {blocked ? (
        <div className={`border-warning/30 bg-warning-wash space-y-2 ${noteClass}`}>
          <p className="text-foreground font-medium">{RETURN_REQUEST_COPY.blocked}</p>
          <p className="text-muted-foreground">{RETURN_REQUEST_COPY.blockedRetry}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={openDraft}>
              <Mail className="h-4 w-4" aria-hidden="true" />
              {RETURN_REQUEST_COPY.retry}
            </Button>
          </div>
        </div>
      ) : null}

      {/* The message as it will open, so both mailboxes and every line can be
          read before anything opens. */}
      <div className="space-y-1">
        <p className="text-muted-foreground text-[12px] font-medium">{prepared.draft.subject}</p>
        <pre
          className="border-border bg-sunk text-foreground max-h-56 overflow-auto whitespace-pre-wrap rounded-md border px-3 py-2 font-sans text-[13px] leading-[19.5px] [overflow-wrap:anywhere]"
          data-testid="return-request-preview"
          tabIndex={0}
          aria-label="Return request message"
        >
          {prepared.draft.body}
        </pre>
      </div>

      {manualText !== null ? (
        <Textarea
          readOnly
          rows={8}
          value={manualText}
          aria-label={RETURN_REQUEST_COPY.manualLabel}
          onFocus={(e) => e.currentTarget.select()}
        />
      ) : null}

      {/* Always mounted, so a screen reader hears each change. */}
      <div aria-live="polite" aria-atomic="true" className="sr-only" data-testid="return-request-live">
        {announcement}
      </div>
    </div>
  );
}
