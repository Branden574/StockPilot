'use client';

import { Copy, Eye, Mail } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { capture } from '@/lib/analytics';
import { DELIVERY_REQUEST_CC_NOTICE, DELIVERY_REQUEST_EMAIL } from '@/lib/site';
import { recordDeliveryRequestDraftedAction } from '@/server/actions/delivery-request';

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

  // null = panel hidden. 'oversized' = the linkFits guard tripped (a
  // measured length problem, no popup was ever attempted). 'blocked' = the
  // window.open attempt itself came back empty-handed. The panel looks
  // almost identical either way — same testid, same two recipients, same
  // copy button — but the lead sentence must name the real cause, not
  // reflexively blame a popup blocker for a link-length problem.
  const [fallbackReason, setFallbackReason] = React.useState<'blocked' | 'oversized' | null>(null);
  const [manualText, setManualText] = React.useState<string | null>(null);
  /**
   * How many drafts we have opened for THIS order in this session.
   *
   * We cannot detect a send — no integration observes the mailbox — so a repeat
   * is warned about, not blocked. Blocking would strand an employee whose first
   * draft was closed by accident, which is the more common case; sending two
   * near-identical requests to DC4 is the less common but noisier one, so it
   * gets a visible warning.
   *
   * Only the branches that can actually produce a draft count: the successful
   * window.open AND the popup-blocked mailto: fallback (a mail client may still
   * open a compose window from that navigation). The linkFits-oversized early
   * return never opens anything — no window.open, no mailto: — so it is
   * deliberately excluded, or the warning would fire for an order that has
   * opened zero drafts.
   */
  const [draftCount, setDraftCount] = React.useState(0);
  /**
   * Fed to the always-mounted live region below, in lockstep with every
   * toast this component fires (same string, so a sighted user and a screen
   * reader user hear/see the same thing) — plus one case a toast never
   * covers: the repeat-draft warning first appearing at draftCount 1 -> 2.
   * That warning is a conditionally-mounted `role="status"` paragraph, and
   * conditionally-mounted live regions are unreliably announced (especially
   * VoiceOver/Safari, which only pick up nodes that were already in the tree
   * when the aria-live attribute was observed). The always-mounted region is
   * the reliable path; the visible warning paragraph itself is unchanged.
   */
  const [announcement, setAnnouncement] = React.useState('');
  // The preview dialog (addendum requirement 3): shows both recipients and
  // the composed message before anything opens. Independent of
  // fallbackReason/manualText — the preview can be opened and closed any
  // number of times regardless of whether a prior Outlook attempt failed.
  const [previewOpen, setPreviewOpen] = React.useState(false);
  // Guards the mailto: navigation, not the panel: the panel is allowed to
  // reappear on every blocked click, but re-navigating to mailto: on a
  // second, third, ... blocked click while the first mailto: tab/prompt is
  // still up would fire a second draft. One mailto: attempt per mount.
  const mailtoAttemptedRef = React.useRef(false);
  // The preview dialog's own restore target (Bug 2 fix). The button below is
  // a plain <button onClick>, not a <DialogTrigger> — it lives outside the
  // <Dialog> tree entirely (the Dialog element further down wraps only
  // DialogContent) — so Radix's own `context.triggerRef` (the ref its
  // default onCloseAutoFocus calls .focus() on when the dialog closes) is
  // never populated. Without this ref and the explicit onCloseAutoFocus
  // handler below, that default restore is a silent no-op and Escape (or any
  // other close) drops focus to <body> instead of back to this button.
  const previewTriggerRef = React.useRef<HTMLButtonElement>(null);

  // The repeat-draft warning (rendered below, gated on draftCount > 1) has no
  // toast of its own to piggyback the announcement on — it appears as a side
  // effect of a click that ALSO fires the success toast for that same click,
  // so its announcement is driven from draftCount directly rather than from
  // a call site. draftCount only ever increases by one, so this fires exactly
  // once, the moment it first crosses from 1 to 2 — the warning's first
  // appearance.
  React.useEffect(() => {
    if (draftCount === 2) {
      setAnnouncement(
        'You have already opened a draft for this order. Sending more than one creates duplicate requests for DC4.',
      );
    }
  }, [draftCount]);

  /**
   * Fire-and-forget bookkeeping. Called only AFTER window.open has already run,
   * because anything awaited before the open makes it asynchronous relative to
   * the click gesture and the browser blocks the popup.
   *
   * Analytics records the FACT of a CC, never the address — the addresses do
   * not go to a third-party processor.
   */
  function recordDraft() {
    recordDeliveryRequestDraftedAction({
      orderId: input.orderId,
      isCondensed: prepared.draft.condensed,
    }).catch(() => {
      // The RPC itself can reject (offline); bookkeeping is best-effort and
      // must never surface to the employee who already has their draft.
    });
    capture('delivery_request_drafted', {
      order_id: input.orderId,
      fulfillment_type: input.fulfillmentType,
      is_condensed: prepared.draft.condensed,
      included_cc_recipient: true,
      line_count: prepared.draft.lineCount,
    });
  }

  function handleOpen() {
    if (!prepared.linkFits) {
      // Even the condensed links exceed the safe URL length, so a mail client
      // would silently truncate the body. Do not open anything — the clipboard
      // path carries the complete message and is the only honest transport here.
      setFallbackReason('oversized');
      return;
    }

    // R3: nothing may precede this line beyond the linkFits guard above.
    let opened: Window | null = null;
    try {
      // No 'noopener' in the features string: with it, window.open returns
      // null EVEN ON SUCCESS (the spec severs the opener before returning),
      // which is indistinguishable from a blocked popup — the exact signal
      // this chain runs on. We take the handle, then sever the opener
      // ourselves so the OWA tab still cannot reach back into this page.
      opened = window.open(prepared.outlookUrl, '_blank');
      if (opened) {
        try {
          opened.opener = null;
        } catch {
          // Cross-origin handles can refuse; severing is best-effort.
        }
      }
    } catch {
      opened = null;
    }

    if (opened) {
      // Clears a stale failure panel left over from an earlier blocked click
      // on this same mount, now that a later click has actually succeeded.
      setFallbackReason(null);
      setDraftCount((n) => n + 1);
      // R3: the audit action + analytics capture fire here — always AFTER the
      // open attempt, never before it. Only real, countable draft attempts
      // are recorded, matching draftCount's own gating.
      recordDraft();
      const message = 'Delivery request draft opened in Outlook. Review it and press Send yourself.';
      toast.success(message);
      setAnnouncement(message);
      return;
    }

    // Popup blocked. Same-tab mailto: is the next best thing; it may still be
    // a silent no-op on Safari, so the copy path is surfaced regardless. The
    // panel reappears on every blocked click, but the mailto: navigation
    // itself only fires once per mount — otherwise a double-click (or a
    // second blocked attempt) opens a second draft. The count is gated on
    // that same one-shot guard: a second (or third, ...) blocked click cannot
    // produce a draft — mailtoAttemptedRef suppresses its navigation — so it
    // must not be counted as one.
    setFallbackReason('blocked');
    if (!mailtoAttemptedRef.current) {
      mailtoAttemptedRef.current = true;
      setDraftCount((n) => n + 1);
      // R3: same call as the success branch above, gated the same way — only
      // the FIRST blocked click (the one that actually navigates) counts as a
      // draft, so only it is recorded. Repeat blocked clicks record nothing.
      recordDraft();
      try {
        window.location.assign(prepared.mailtoUrl);
      } catch {
        // Ignored on purpose: the visible fallback below is the recovery.
      }
    }
  }

  async function handleCopy() {
    const text = prepared.clipboardText;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setManualText(null);
      const message = `Delivery request copied. Create a new email to ${DELIVERY_REQUEST_EMAIL.to}, CC ${DELIVERY_REQUEST_EMAIL.cc}, and paste the copied details.`;
      toast.success(message);
      setAnnouncement(message);
    } catch {
      // The selectable box is the terminal fallback: it always shows both
      // recipients, so the employee can always complete the task by hand.
      setManualText(text);
      const message = 'Could not copy automatically. Select the text below and copy it manually.';
      toast.error(message);
      setAnnouncement(message);
    }
  }

  return (
    <>
      <button type="button" className="sf-btn-ghost" onClick={handleOpen}>
        <Mail size={14} aria-hidden="true" />
        Email delivery request
      </button>

      <button
        type="button"
        ref={previewTriggerRef}
        className="sf-btn-ghost"
        onClick={() => setPreviewOpen(true)}
      >
        <Eye size={14} aria-hidden="true" />
        Preview
      </button>

      {/*
        The honesty affordances (addendum requirement: "this does not create a
        ticket"). Static, rendered before any click — not a toast, which
        disappears, and not folded into the fallback panel, which only shows
        after a failed open. There is no ui/alert.tsx in this repo (zero
        imports of @/components/ui/alert), so these reuse the house inline
        banner shape via the sf-note classes rather than importing Tailwind
        semantics into this hand-rolled CSS.
      */}
      <p className="sf-note" data-testid="delivery-request-notice">
        This opens a draft email. StockPilot does not send it and does not create a ticket. Review
        the message and press Send in your mail app.
      </p>

      {draftCount > 1 && (
        <p className="sf-note sf-note-warn" data-testid="delivery-request-repeat" role="status">
          {/*
            This is a conditionally-mounted role="status" node, which is
            unreliably announced (especially VoiceOver/Safari, which only
            reads live regions that already existed in the tree when the
            attribute was observed). The always-mounted live region below is
            the reliable path — it is set to this exact sentence the moment
            draftCount first crosses from 1 to 2. This visible paragraph is
            unchanged.
          */}
          You have already opened a draft for this order. Sending more than one creates duplicate
          requests for DC4.
        </p>
      )}

      {/*
        The reliable SR-announcement path (brief section 26 / Task 9). Every
        toast this component fires also lands here as the identical string,
        and the repeat-draft warning above — which has no toast of its own —
        is announced here too via the draftCount effect. Always mounted, so
        VoiceOver/Safari pick up the text-change rather than missing a node
        that only just appeared.
      */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sf-sr-only"
        data-testid="delivery-request-live"
      >
        {announcement}
      </div>

      {/*
        Two variants, same testid, chosen by linkFits so this static line
        never contradicts the oversized panel that can appear after a click
        (Finding 1). `draft.condensed` alone is not enough: it is true
        whenever the FULL draft didn't fit a compose link, regardless of
        whether the condensed links themselves fit. When they do fit
        (condensed && linkFits), the summary path really is available, so
        the original sentence stands. When even the condensed links are too
        long (!linkFits — which only happens when condensed is also true,
        see prepareDeliveryRequest), nothing can be prefilled safely, so
        this must say the same thing the oversized fallback panel says,
        before AND after any click.
      */}
      {prepared.draft.condensed && prepared.linkFits && (
        <p className="sf-note sf-note-warn" data-testid="delivery-request-condensed">
          This order is too large to fit in a compose link, so the draft carries a summary. Copy
          the details instead to include every line.
        </p>
      )}

      {!prepared.linkFits && (
        <p className="sf-note sf-note-warn" data-testid="delivery-request-condensed">
          This order is too large for a prefilled email link. Use Copy the details to include
          every line.
        </p>
      )}

      {fallbackReason !== null && (
        <div className="sf-fallback" data-testid="delivery-request-fallback">
          <p>
            {fallbackReason === 'oversized'
              ? "This order's details are too long to prefill into a mail link safely."
              : 'Outlook did not open — your browser may have blocked the popup.'}{' '}
            Copy the details and create the email yourself: To {DELIVERY_REQUEST_EMAIL.to}, CC{' '}
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

      {/*
        Built on the Radix Dialog rather than a second hand-rolled sf-modal:
        brief section 26 requires a focus trap and focus restore, and the
        storefront's own sf-modal has neither. Radix supplies both correctly.
        The BUTTONS inside still use sf-* classes so it reads as part of the
        storefront. The review modal's Escape listener is inert at the success
        stage (its `closable` guard requires stage === 'review'), so there is no
        conflict between the two Escape handlers.
      */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent
          // Bug 1 (visual, z-index): the review/success modal this preview
          // is opened FROM (.sf-modal-bk, storefront.css:1980-1983) is
          // `position: fixed; z-index: 90` in the ROOT stacking context —
          // `.sp-storefront` (storefront.css:15) declares only custom
          // properties, no transform/filter/opacity/isolation, so it creates
          // no stacking context of its own to contain that backdrop. The
          // shared ui/dialog.tsx DialogContent/DialogOverlay ship
          // `fixed ... z-50`, also portalled to document.body (root stacking
          // context). 90 > 50, so without this override the preview would
          // paint BEHIND the review/success modal's backdrop: still
          // operable (Radix's modal mode neutralizes outside pointer events)
          // but visually smothered by a 60%-opaque veil. z-[100] clears 90.
          // twMerge (via `cn`) drops the base "z-50" utility in favor of
          // this one since both target the same z-index property. The
          // overlay itself (rendered internally by DialogContent, not
          // classNameable from this call site) is NOT raised and stays at
          // z-50, under the storefront backdrop — that is fine, arguably
          // better: no double-dimming, and DO NOT restructure ui/dialog.tsx
          // to fix it, it serves every dialog in the app.
          className="sp-storefront max-w-2xl z-[100]"
          // Bug 2 (a11y, focus restore): the Preview button above is a plain
          // <button>, not a <DialogTrigger>, so Radix's own `context.triggerRef`
          // — the target its default onCloseAutoFocus focuses — is never
          // populated, and that default restore silently no-ops, dropping
          // focus to <body> on close (Escape included). Focus the actual
          // trigger explicitly instead.
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            previewTriggerRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Delivery request preview</DialogTitle>
            <DialogDescription>
              StockPilot will open this as a draft in your mail client. Nothing is sent until you
              press Send yourself, and no ticket exists yet.
            </DialogDescription>
          </DialogHeader>

          <div className="sf-recip">
            <div className="sf-recip-h">EMAIL RECIPIENTS</div>
            <dl>
              <div>
                <dt>To</dt>
                <dd>{DELIVERY_REQUEST_EMAIL.to}</dd>
              </div>
              <div>
                <dt>CC</dt>
                <dd>{DELIVERY_REQUEST_EMAIL.cc}</dd>
              </div>
            </dl>
            <p className="sf-recip-note">{DELIVERY_REQUEST_CC_NOTICE}</p>
          </div>

          <div className="sf-recip">
            <div className="sf-recip-h">SUBJECT</div>
            <p>{prepared.draft.subject}</p>
          </div>

          <textarea
            className="sf-fallback-text"
            readOnly
            rows={14}
            value={prepared.draft.body}
            aria-label="Delivery request message preview"
          />

          {/*
            Finding 1 (final review): the ONLY render site for the manual
            fallback textarea used to be nested inside the `fallbackReason
            !== null` panel below, which this dialog never triggers — the
            dialog's own Copy button calls the same `handleCopy`, but
            reaching a clipboard-denied/absent browser from here never runs
            `handleOpen`, so `fallbackReason` stays null and that panel never
            mounts. The error toast fired with no textarea anywhere in the
            document for the employee to read or select. This renders from
            the SAME `manualText` state as the panel's copy below — whichever
            surface the user is on when the clipboard call fails shows it.
          */}
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

          {/*
            Finding 2 (final review): Radix's modal mode sets
            aria-hidden="true" on every sibling of the portalled dialog
            content while it is open — including the always-mounted live
            region rendered in this component's own root fragment below. A
            copy triggered by THIS dialog's Copy button was therefore never
            announced to a screen-reader user with the preview open. This is
            a second live region, fed by the same `announcement` state,
            living inside DialogContent so it is never aria-hidden while the
            dialog is open.
          */}
          <div
            aria-live="polite"
            aria-atomic="true"
            className="sf-sr-only"
            data-testid="delivery-request-live-dialog"
          >
            {announcement}
          </div>

          <div className="sf-modal-foot">
            <button type="button" className="sf-btn-ghost" onClick={handleCopy}>
              <Copy size={14} aria-hidden="true" />
              Copy the details
            </button>
            <button
              type="button"
              className="sf-btn-go"
              onClick={() => {
                // R3 still applies inside the dialog: the open is the first
                // statement, and the dialog is closed afterwards.
                handleOpen();
                setPreviewOpen(false);
              }}
            >
              <Mail size={14} aria-hidden="true" />
              Open in Outlook
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
