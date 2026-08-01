'use client';

import { Copy, Mail } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { DELIVERY_REQUEST_EMAIL } from '@/lib/site';

import { prepareDeliveryRequest, type DeliveryRequestInput } from './storefront-logic';

/**
 * The delivery-request assistant's entry point, rendered in the success
 * screen's `.acts` row.
 *
 * What it does: composes a plain-text delivery-request message and OPENS it in
 * the employee's mail client, prefilled. What it never does: send anything,
 * create anything, or claim that a ticket exists. The employee keeps final
 * review-and-send control inside Outlook.
 *
 * The fallback chain, in order, and why each step exists:
 *
 *   0. linkFits guard — `prepareDeliveryRequest` already tried the full body
 *      and, if that didn't fit a compose link, a condensed one. When even the
 *      condensed link still exceeds the safe URL length (a pathological
 *      warehouse/site/requester name — those are unbounded database strings
 *      condensing does not shorten), `linkFits` is false and NEITHER url is
 *      opened: a mail client would truncate the body silently, invisible to
 *      us and to the employee. The clipboard path always carries the
 *      complete, untruncated body, so it is the only honest transport left.
 *   1. window.open(OWA compose) — the primary path. It is the FIRST
 *      side-effecting statement in the click handler after the linkFits
 *      guard: an await, a setState or an analytics call before it makes the
 *      open asynchronous relative to the gesture and Chrome and Safari
 *      return null. There is no prior popup-blocked pattern in this repo to
 *      copy; both existing window.open call sites ignore the return.
 *   2. location.assign(mailto:) — when the open returns null or throws.
 *   3. Clipboard, offered as a VISIBLE control — because Safari treats a
 *      mailto: navigation with no registered handler as a silent no-op, so
 *      step 2 can fail with no signal at all. Hiding this behind another
 *      failure detection we cannot perform would strand the employee.
 *   4. A selectable textarea — when the clipboard API is absent or denied.
 *
 * Recipients are never props and never state. They come from
 * DELIVERY_REQUEST_EMAIL via the pure builder, so nothing a user typed can
 * redirect them.
 */
export default function DeliveryRequestAction({ input }: { input: DeliveryRequestInput }) {
  // Prepared once per render of the success screen. Doing this in a memo rather
  // than inside the handler keeps the handler's first statement the open call.
  const prepared = React.useMemo(() => prepareDeliveryRequest(input), [input]);

  const [showFallback, setShowFallback] = React.useState(false);
  const [manualText, setManualText] = React.useState<string | null>(null);

  function handleOpen() {
    if (!prepared.linkFits) {
      // Even the condensed links exceed the safe URL length, so a mail client
      // would silently truncate the body. Do not open anything — the clipboard
      // path carries the complete message and is the only honest transport here.
      setShowFallback(true);
      return;
    }

    // R3: nothing may precede this line beyond the linkFits guard above.
    let opened: Window | null = null;
    try {
      opened = window.open(prepared.outlookUrl, '_blank', 'noopener,noreferrer');
    } catch {
      opened = null;
    }

    if (opened) {
      toast.success('Delivery request draft opened in Outlook. Review it and press Send yourself.');
      return;
    }

    // Popup blocked. Same-tab mailto: is the next best thing; it may still be
    // a silent no-op on Safari, so the copy path is surfaced regardless.
    setShowFallback(true);
    try {
      window.location.assign(prepared.mailtoUrl);
    } catch {
      // Ignored on purpose: the visible fallback below is the recovery.
    }
  }

  async function handleCopy() {
    const text = prepared.clipboardText;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setManualText(null);
      toast.success(
        `Delivery request copied. Create a new email to ${DELIVERY_REQUEST_EMAIL.to}, CC ${DELIVERY_REQUEST_EMAIL.cc}, and paste the copied details.`,
      );
    } catch {
      // The selectable box is the terminal fallback: it always shows both
      // recipients, so the employee can always complete the task by hand.
      setManualText(text);
      toast.error('Could not copy automatically. Select the text below and copy it manually.');
    }
  }

  return (
    <>
      <button type="button" className="sf-btn-ghost" onClick={handleOpen}>
        <Mail size={14} aria-hidden="true" />
        Email delivery request
      </button>

      {showFallback && (
        <div className="sf-fallback" data-testid="delivery-request-fallback">
          <p>
            Outlook did not open — your browser may have blocked the popup. Copy the details and
            create the email yourself: To {DELIVERY_REQUEST_EMAIL.to}, CC{' '}
            {DELIVERY_REQUEST_EMAIL.cc}.
          </p>
          <button type="button" className="sf-btn-ghost" onClick={handleCopy}>
            <Copy size={14} aria-hidden="true" />
            Copy the details
          </button>
          {manualText !== null && (
            <textarea
              className="sf-fallback-text"
              readOnly
              rows={8}
              value={manualText}
              aria-label="Delivery request text to copy manually"
              onFocus={(e) => e.currentTarget.select()}
            />
          )}
        </div>
      )}
    </>
  );
}
