'use client';

import { Copy, Download, Mail, MailOpen } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { prepareMaintenanceEmail, type MaintenanceEmailInput } from '@stockpilot/core';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { reportError } from '@/lib/error-reporter';
import { recordMaintenanceDraftOpenedAction } from '@/server/actions/maintenance-requests';

import { useMaintenanceShareLink } from './share-link-context';

/**
 * The heart of the maintenance-request feature: turns a SAVED request into a
 * prefilled Outlook draft addressed to real people (dc4@learn4life.org,
 * CC arosas@cvwest.org — see packages/core/src/maintenance/constants.ts).
 *
 * What it does: opens a draft. What it NEVER does: send anything, create a
 * ticket, or claim StockPilot can observe either happening. Every string
 * this component renders is checked by the honesty sweep below — StockPilot
 * has no channel back from Zendesk/Outlook, so "opened" is the only verb it
 * is ever allowed to use.
 *
 * Ported from the delivery-request assistant's owner-tested component
 * (apps/web/src/components/orders/storefront/delivery-request-action.tsx),
 * the one prior place in this repo that has actually been hand-verified
 * against real popup-blocking, real clipboard denial, and a real Outlook
 * tenant. Every fallback branch below mirrors that component's reasoning;
 * see its own doc comment for the full "why" on each step, R3 ordering, and
 * the noopener landmine.
 */
export interface MaintenancePhotoDownload {
  url: string;
  filename: string;
}

interface Props {
  requestId: string;
  emailInput: MaintenanceEmailInput;
  initialOpenCount: number;
  /** Signed download links for the request's uploaded photos — Outlook
   *  cannot pre-attach them (brief section 10), so this is the manual
   *  "download, then attach yourself" escape hatch. Undefined/empty hides
   *  the whole group. */
  photoDownloads?: MaintenancePhotoDownload[];
}

const SUCCESS_MESSAGE =
  'Outlook opened with your maintenance request. Review the information, attach any downloaded photos you want included directly, and click Send.';

const DUPLICATE_WARNING =
  'A maintenance email draft was already opened for this request. Sending multiple copies may create duplicate Zendesk tickets.';

const BLOCKED_HEADLINE = 'Outlook could not be opened automatically.';

const OVERSIZED_MESSAGE =
  'This request is too long for an email link, even shortened. Use Copy Email Details below — it always includes the full text.';

const COPY_FAILURE_MESSAGE = 'Could not copy the request automatically. Select the text below and copy it manually.';

export function MaintenanceEmailAction({ requestId, emailInput, initialOpenCount, photoDownloads }: Props) {
  // Mig 0330: the share-link token is hashed at rest, so the server can no
  // longer fold an existing link's URL into emailInput at render time. If
  // the user generated a link THIS session (ShareLinkPanel, via the shared
  // context), fold that fresh URL into the draft; otherwise compose without
  // one — the same body the builder already produces for orgs with share
  // links disabled. Without the provider (post-create review screen) the
  // context defaults to null and this is a no-op.
  const { generatedUrl } = useMaintenanceShareLink();
  const effectiveEmailInput = React.useMemo(
    () => (generatedUrl ? { ...emailInput, shareUrl: generatedUrl } : emailInput),
    [emailInput, generatedUrl],
  );

  // Prepared once per render — a pure, deterministic function of emailInput
  // (no clock, no DOM). Recomputing on every emailInput change (e.g. a photo
  // was added/removed on the same page) keeps the compose links honest.
  const prepared = React.useMemo(
    () => prepareMaintenanceEmail(effectiveEmailInput),
    [effectiveEmailInput],
  );

  // null = no fallback panel showing. 'oversized' = the linkFits guard
  // tripped before anything was attempted (a measured length problem, no
  // popup was ever opened). 'blocked' = window.open itself came back
  // empty-handed. The lead sentence must name the real cause — never blame
  // a popup blocker for a link-length problem, and never blame link length
  // for an actual blocked popup.
  const [fallbackReason, setFallbackReason] = React.useState<'blocked' | 'oversized' | null>(null);
  const [manualText, setManualText] = React.useState<string | null>(null);
  const [announcement, setAnnouncement] = React.useState('');
  // How many drafts have been opened for THIS request in this session,
  // seeded from the persisted count (Task 8's recordDraftOpened). Gates the
  // duplicate-draft confirmation (brief section 21) — never permanently
  // blocks reopening, only warns.
  const [openCount, setOpenCount] = React.useState(initialOpenCount);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  // Guards the automatic mailto: navigation, not the panel: the panel is
  // allowed to reappear on every blocked click, but re-navigating to
  // mailto: on a second, third, ... blocked click while the first mailto:
  // tab/prompt is still up would fire a second draft. One automatic mailto:
  // attempt per mount — "Try Outlook Again" retries the Outlook Web compose
  // only, never a second mailto: navigation.
  const mailtoAttemptedRef = React.useRef(false);

  /**
   * R3: the ONLY side-effecting statement before `window.open` is the
   * `linkFits` guard above it. No await, no setState, no analytics may run
   * first — any of those makes the open asynchronous relative to the click
   * gesture, and the browser treats it exactly like a blocked popup.
   */
  function openDraft() {
    if (!prepared.linkFits) {
      // Even the condensed links exceed the safe URL length (a pathological
      // requester/site name — condensing does not shorten those). A mail
      // client would silently truncate the body, so nothing opens here —
      // not the Outlook link, not mailto: either. The clipboard path always
      // carries the complete body and is the only honest transport left.
      setFallbackReason('oversized');
      return;
    }

    let opened: Window | null = null;
    try {
      // No 'noopener' in the features string: with it, window.open returns
      // null EVEN ON SUCCESS (the spec severs the opener before returning),
      // indistinguishable from a blocked popup — the exact signal this
      // chain runs on. Take the handle, then sever the opener ourselves so
      // the Outlook tab still cannot reach back into this page.
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
      // Clears a stale failure panel left over from an earlier blocked
      // click on this same mount, now that a later click actually succeeded.
      setFallbackReason(null);
      setOpenCount((n) => n + 1);
      // R3: the audit action fires here — always AFTER the open attempt,
      // never before it. Rate/permission failures resolve to `{ error }`,
      // never claimed as success (ActionResult drops the ServiceError CODE,
      // message only) — this UI already shows the real, local success state
      // from the open itself, so a failed record() only means the SERVER'S
      // open-count can drift from this component's local count, not that
      // the employee's draft silently vanished. A rejected PROMISE (network
      // failure, not a resolved `{ error }`) is a different failure mode —
      // without a `.catch()` it becomes an unhandled rejection, which in dev
      // paints Next's error overlay directly over the honest success toast
      // below. Mirrors delivery-request-action.tsx:141-148's identical
      // precedent: bookkeeping is best-effort and must never surface to the
      // employee who already has their draft.
      void recordMaintenanceDraftOpenedAction(requestId)
        .then((r) => {
          if ('ok' in r) setOpenCount(r.openCount);
        })
        .catch((e: unknown) => {
          // Best-effort breadcrumb only: a lost draft-opened row means the
          // server's open-count silently undercounts (the duplicate-draft
          // dialog in handlePrimaryClick may under-warn next time), which is
          // otherwise unobservable.
          void reportError(e, { tag: 'maintenance.draft-opened.record', level: 'warning' });
        });
      toast.success(SUCCESS_MESSAGE);
      setAnnouncement(SUCCESS_MESSAGE);
      return;
    }

    // Popup blocked. Same-tab mailto: is the next best thing; it may still
    // be a silent no-op (no registered handler), so the recovery panel
    // (Copy Email Details, Download Photos, manual Open in Default Email
    // App) is surfaced regardless. The panel reappears on every blocked
    // click, but the automatic mailto: navigation itself fires only once
    // per mount.
    setFallbackReason('blocked');
    if (!mailtoAttemptedRef.current) {
      mailtoAttemptedRef.current = true;
      setOpenCount((n) => n + 1);
      // Same best-effort .catch() as the success-path call above — a
      // rejected promise here is otherwise an unhandled rejection.
      void recordMaintenanceDraftOpenedAction(requestId).catch((e: unknown) => {
        void reportError(e, { tag: 'maintenance.draft-opened.record', level: 'warning' });
      });
      try {
        window.location.assign(prepared.mailtoUrl);
      } catch {
        // Ignored on purpose: the visible fallback below is the recovery.
      }
    }
  }

  function handlePrimaryClick() {
    if (openCount > 0) {
      setConfirmOpen(true);
      return;
    }
    openDraft();
  }

  /** Manual mailto: escape hatch — distinct from the automatic fallback
   *  above. Never offered when `!prepared.linkFits` (rendered conditionally
   *  below): the mailto: URL is exactly as oversized as the Outlook one. */
  function openDefaultEmailApp() {
    try {
      window.location.assign(prepared.mailtoUrl);
    } catch {
      // Nothing further to do — the employee already sees Copy Email
      // Details and Download Photos as recovery options.
    }
  }

  async function handleCopy() {
    const text = prepared.clipboardText;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setManualText(null);
      const message = `Maintenance request copied. Create a new email to ${prepared.draft.to}, CC ${prepared.draft.cc}, and paste the copied details.`;
      toast.success(message);
      setAnnouncement(message);
    } catch {
      // The selectable box is the terminal fallback: it always carries the
      // complete, uncondensed body, so the employee can always finish this
      // by hand.
      setManualText(text);
      toast.error(COPY_FAILURE_MESSAGE);
      setAnnouncement(COPY_FAILURE_MESSAGE);
    }
  }

  const hasPhotoDownloads = Boolean(photoDownloads && photoDownloads.length > 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={handlePrimaryClick}>
          <Mail className="h-4 w-4" aria-hidden="true" />
          Open in Outlook
        </Button>
        <Button type="button" variant="outline" onClick={() => void handleCopy()}>
          <Copy className="h-4 w-4" aria-hidden="true" />
          Copy Email Details
        </Button>
        {prepared.linkFits ? (
          <Button type="button" variant="outline" onClick={openDefaultEmailApp}>
            <MailOpen className="h-4 w-4" aria-hidden="true" />
            Open in Default Email App
          </Button>
        ) : null}
      </div>

      {hasPhotoDownloads ? (
        <div className="space-y-1.5 rounded-md border border-dashed p-3 text-sm">
          <p className="flex items-center gap-1.5 font-medium">
            <Download className="h-4 w-4" aria-hidden="true" />
            Download Photos for Outlook
          </p>
          <p className="text-muted-foreground">
            Outlook cannot add StockPilot photos automatically. Download them here to attach directly to the
            draft.
          </p>
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {(photoDownloads ?? []).map((photo) => (
              <li key={photo.url}>
                <a href={photo.url} download={photo.filename} className="underline underline-offset-2">
                  {photo.filename}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {prepared.draft.condensed && prepared.linkFits ? (
        <p className="rounded-md border border-dashed p-2 text-sm text-muted-foreground">
          This email will open with a shortened summary — the full request was too long for a compose link. The
          complete details are saved in this request, and Copy Email Details always includes everything.
        </p>
      ) : null}

      {!prepared.linkFits ? (
        <p className="rounded-md border border-dashed p-2 text-sm text-muted-foreground">{OVERSIZED_MESSAGE}</p>
      ) : null}

      {fallbackReason === 'blocked' ? (
        <div className="space-y-2 rounded-md border p-3 text-sm">
          {/* Two separate elements, not one concatenated sentence: the exact
              headline must be independently findable (brief section 19's
              literal-pinned string) without swallowing the trailing
              context sentence into the same text node. */}
          <p>{BLOCKED_HEADLINE}</p>
          <p className="text-muted-foreground">
            Your request is saved — try again, or use one of the options below.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={openDraft}>
              <Mail className="h-4 w-4" aria-hidden="true" />
              Try Outlook Again
            </Button>
          </div>
        </div>
      ) : null}

      {manualText !== null ? (
        <Textarea
          readOnly
          rows={8}
          value={manualText}
          aria-label="Maintenance request text to copy manually"
          onFocus={(e) => e.currentTarget.select()}
        />
      ) : null}

      {/* Reliable SR-announcement path: always mounted so VoiceOver/Safari
          (which only pick up nodes already in the tree when aria-live was
          observed) pick up the text change rather than missing a node that
          only just appeared. */}
      <div aria-live="polite" aria-atomic="true" className="sr-only" data-testid="maintenance-email-live">
        {announcement}
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Open another draft?</DialogTitle>
            <DialogDescription>{DUPLICATE_WARNING}</DialogDescription>
          </DialogHeader>

          {/* Radix's modal mode sets aria-hidden="true" on every sibling of
              the portalled dialog while it is open — including the
              always-mounted live region above. A SECOND region, fed by the
              same `announcement` state and living inside DialogContent, is
              never aria-hidden while this dialog is open. */}
          <div
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
            data-testid="maintenance-email-live-dialog"
          >
            {announcement}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                // R3 still applies inside the dialog: the open is the first
                // statement of openDraft(), and the dialog closes after.
                openDraft();
                setConfirmOpen(false);
              }}
            >
              <Mail className="h-4 w-4" aria-hidden="true" />
              Open Another Draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
