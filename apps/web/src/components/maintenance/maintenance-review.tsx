import Link from 'next/link';

import {
  brandMaintenanceRecipients,
  formatMaintenanceRequestNumber,
  maintenanceCcNotice,
  prepareMaintenanceEmail,
  relatedLocationText,
  type MaintenanceEmailContent,
  type OrgEmailRoutingState,
  type PreparedMaintenanceEmail,
} from '@stockpilot/core';

import { DetailSection } from '@/components/patterns/detail-section';
import { KeyValueList, KeyValueRow } from '@/components/patterns/key-value-row';
import { PageHeader } from '@/components/patterns/page-header';
import { PatternPhoto } from '@/components/patterns/photo';
import { Button } from '@/components/ui/button';
import type { MaintenanceRequestDetail } from '@/server/services/maintenance-requests';

import { MaintenanceEmailAction } from './maintenance-email-action';
import type { PanelPhoto } from './maintenance-photos-panel';
import { MaintenanceStatusBadge } from './maintenance-status-badge';

const PRIORITY_LABELS: Record<string, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

/** 'Label: value' as a single dt/dd pair (DESIGN-SPEC 6.7's key-value
 *  row) — omits itself entirely when the value is blank, matching the pure
 *  email builder's own `line()` rule (packages/core/src/maintenance/email.ts)
 *  so the review screen never shows a field the generated email itself would
 *  have dropped. */
function Field({ label, value }: { label: string; value: string | null | undefined }) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return null;
  return <KeyValueRow label={label}>{v}</KeyValueRow>;
}

/** A quiet label over a block of text inside a flush card. */
const BLOCK = 'border-border border-t px-[18px] py-3.5';
const BLOCK_LABEL = 'text-muted-foreground text-[12.5px] leading-[18.75px]';

/**
 * The saved request, laid out for review BEFORE the employee opens Outlook.
 * Mounted by Task 15's detail page whenever `?review=1` is present (the
 * landing spot straight out of the create form — see
 * apps/web/src/app/(dashboard)/dashboard/maintenance/new/new-request-client.tsx).
 *
 * Everything here is READ-ONLY display plus the MaintenanceEmailAction block
 * (the only thing on this screen with side effects). `detail` carries the
 * StockPilot-native fields (status, timestamps, raw description); `emailInput`
 * carries what the SERVER already assembled for the pure email builder
 * (related-record snapshots with URLs, the formatted request number, the
 * org-timezone submitted timestamp) — reused here rather than re-deriving any
 * of it, so the preview can never drift from what Outlook will actually show.
 */
export function MaintenanceReview({
  detail,
  photos,
  emailInput,
  emailRouting,
  canConfigureRouting,
  initialOpenCount,
}: {
  detail: MaintenanceRequestDetail;
  photos: PanelPhoto[];
  /** The email CONTENT — recipients arrive separately on `emailRouting`. */
  emailInput: MaintenanceEmailContent;
  /**
   * The org's maintenance-request routing resolution (per-org email
   * routing, migration 0337). Only 'valid' renders the email preview and
   * the compose actions; 'unset'/'invalid' hide them — members see nothing,
   * `canConfigureRouting` holders see a pointer to Settings.
   */
  emailRouting: OrgEmailRoutingState;
  canConfigureRouting: boolean;
  initialOpenCount: number;
}) {
  // Minor 7 fix: `detail.id` IS the request id — there is no second value
  // that could legitimately disagree with it, so a separate `requestId`
  // prop was just a second source of truth a caller could pass out of sync
  // with `detail`. Every consumer below reads `detail.id`.
  const requestId = detail.id;
  // THE SEAM: re-brand (re-validate) the resolved routing; fail CLOSED to
  // "no email UI" on anything the factory refuses — never a compiled
  // constant. Server components have no memo; this is a cheap pure call.
  let prepared: PreparedMaintenanceEmail | null = null;
  if (emailRouting.state === 'valid') {
    try {
      const recipients = brandMaintenanceRecipients(emailRouting.recipients);
      prepared = prepareMaintenanceEmail({ ...emailInput, recipients });
    } catch {
      prepared = null;
    }
  }
  const requestNumber =
    formatMaintenanceRequestNumber(detail.requestNumber, detail.createdAt) ?? String(detail.requestNumber);
  // F1-5: the location the request is about (an escalated exception's rack,
  // Staging or Unplaced), in the email's own words.
  const relatedLocation = relatedLocationText(emailInput.relatedLocation);

  return (
    // The review step (the wizard pattern's last step): the shared page
    // header, the honesty sentence, then the saved request in titled cards
    // (DESIGN-SPEC 6.7) and the email actions at the foot. A reading-width
    // column, centred as before.
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <PageHeader
        title="Review maintenance request"
        subline={
          <>
            {requestNumber} &middot; {detail.subject}
          </>
        }
        titleAside={<MaintenanceStatusBadge status={detail.status} />}
      />

      {/* The helper sentence — the honesty anchor for this whole screen:
          saved, but not sent, and never automatically. Owner-approved wording
          (2026-09-28), replacing the brief's original line, which read as if
          Outlook opened by itself: Outlook opens only when the person chooses
          Open in Outlook, and nothing is sent until they send it. The Outlook
          half of the sentence only renders when a compose action actually
          exists (routing 'valid'); an unconfigured org must not be promised an
          Outlook window that will never open. */}
      <p className="border-border bg-sunk text-foreground rounded-lg border px-[18px] py-3 text-[13.5px] leading-[20.25px]">
        {emailRouting.state === 'valid'
          ? 'Your request has been saved in StockPilot. When you choose Open in Outlook, it opens with the email details filled in; nothing is sent until you send it.'
          : 'Your request has been saved in StockPilot.'}
      </p>

      <DetailSection title="Request details" flush>
        <KeyValueList>
          <Field label="Request number" value={requestNumber} />
          <Field label="Subject" value={detail.subject} />
          <Field label="Category" value={detail.category} />
          <Field label="Priority" value={PRIORITY_LABELS[detail.priority] ?? detail.priority} />
          <Field label="Requester" value={detail.requesterName} />
          <Field label="Requester email" value={detail.requesterEmail} />
          <Field label="Requester phone" value={detail.requesterPhone} />
          <Field label="Site" value={detail.siteName} />
          <Field label="Building" value={detail.building} />
          <Field label="Room or area" value={detail.roomOrArea} />
          <Field label="Department" value={detail.department} />
          <Field label="Access instructions" value={detail.accessInstructions} />
        </KeyValueList>
        <div className={BLOCK}>
          <p className={BLOCK_LABEL}>Description</p>
          <p className="mt-1 whitespace-pre-wrap text-[13.5px] leading-[20.25px] [overflow-wrap:anywhere]">
            {detail.description}
          </p>
        </div>

        {emailInput.relatedItem ||
        relatedLocation ||
        emailInput.relatedOrder ||
        emailInput.relatedRental ? (
          <div className={`${BLOCK} space-y-1.5 text-[13.5px] leading-[20.25px]`}>
            <p className={BLOCK_LABEL}>Related StockPilot record</p>
            {emailInput.relatedItem ? (
              <p>
                Item:{' '}
                {emailInput.relatedItem.url ? (
                  <a
                    className="text-accent hover:text-foreground underline underline-offset-2"
                    href={emailInput.relatedItem.url}
                  >
                    {emailInput.relatedItem.name}
                  </a>
                ) : (
                  emailInput.relatedItem.name
                )}
                {emailInput.relatedItem.sku ? ` (${emailInput.relatedItem.sku})` : ''}
              </p>
            ) : null}
            {relatedLocation ? <p>Related location: {relatedLocation}</p> : null}
            {emailInput.relatedOrder ? (
              <p>
                Order:{' '}
                {emailInput.relatedOrder.url ? (
                  <a
                    className="text-accent hover:text-foreground underline underline-offset-2"
                    href={emailInput.relatedOrder.url}
                  >
                    {emailInput.relatedOrder.handle}
                  </a>
                ) : (
                  emailInput.relatedOrder.handle
                )}
              </p>
            ) : null}
            {emailInput.relatedRental ? (
              <p>
                Rental of{' '}
                {emailInput.relatedRental.url ? (
                  <a
                    className="text-accent hover:text-foreground underline underline-offset-2"
                    href={emailInput.relatedRental.url}
                  >
                    {emailInput.relatedRental.itemNames.join(', ') || 'rental record'}
                  </a>
                ) : (
                  emailInput.relatedRental.itemNames.join(', ') || 'rental record'
                )}
              </p>
            ) : null}
          </div>
        ) : null}
      </DetailSection>

      {photos.length > 0 ? (
        <DetailSection title={`Photos (${photos.length})`} bodyClassName="space-y-3">
          <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            {photos.map((p) => (
              <li
                key={p.id}
                className="border-border relative h-24 overflow-hidden rounded-md border bg-white"
              >
                <PatternPhoto src={p.thumbUrl ?? p.url} alt={p.originalFilename} />
              </li>
            ))}
          </ul>
          {/* Brief section 10's suggested helper text, verbatim. */}
          <p className="text-muted-foreground text-[13px] leading-[19.5px]">
            Outlook cannot add StockPilot photos automatically. The photo links will be included in
            the message, and you can download the photos here if you want to attach them directly.
          </p>
          <div>
            <p className="text-foreground text-[13px] font-medium">Download Photos for Outlook</p>
            <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
              {photos.map((p) => (
                <li key={p.id}>
                  <a
                    href={p.url}
                    download={p.originalFilename}
                    className="text-accent hover:text-foreground text-[13px] underline underline-offset-2"
                  >
                    {p.originalFilename}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </DetailSection>
      ) : null}

      {prepared && emailRouting.state === 'valid' ? (
        <DetailSection title="Email preview" flush>
          <KeyValueList>
            <KeyValueRow label="To">{prepared.draft.to}</KeyValueRow>
            <KeyValueRow label="CC">{prepared.draft.cc}</KeyValueRow>
          </KeyValueList>
          <div className={`${BLOCK} space-y-3`}>
            {/* A pure function of the SAME recipients the compose urls
                carry, so this sentence can never name a mailbox the mail
                does not go to. */}
            <p className="text-muted-foreground text-[13px] leading-[19.5px]">
              {maintenanceCcNotice(prepared.draft)}
            </p>
            <div>
              <p className={BLOCK_LABEL}>Subject</p>
              <p className="mt-1 text-[13.5px] leading-[20.25px]">{prepared.draft.subject}</p>
            </div>
            <div>
              <p className={BLOCK_LABEL}>Body</p>
              <pre className="border-border bg-sunk mt-1 whitespace-pre-wrap rounded-md border p-3 font-mono text-[12.5px] leading-[19px] [overflow-wrap:anywhere]">
                {prepared.draft.body}
              </pre>
            </div>
          </div>
        </DetailSection>
      ) : canConfigureRouting ? (
        // Admin-only hint (fallback matrix states B/D). Members see no email
        // UI at all — the saved request itself is unaffected.
        <DetailSection title="Email preview">
          <p className="text-muted-foreground text-[13.5px]" data-testid="maintenance-routing-hint">
            {emailRouting.state === 'invalid'
              ? `Email routing for maintenance requests is invalid: ${emailRouting.reason} The email action is hidden until this is fixed in `
              : 'Email routing is not configured for this organization, so the email action is hidden. Set it in '}
            <Link
              href="/dashboard/settings/email-routing"
              className="text-accent hover:text-foreground underline underline-offset-2"
            >
              Settings &rarr; Email routing
            </Link>
            .
          </p>
        </DetailSection>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* Minor 6 fix: deliberately NOT passing `photoDownloads` here. The
            Photos card above (when photos.length > 0) already renders its
            own "Download Photos for Outlook" group right next to the §10
            sentence and the thumbnails, so passing the same list into
            MaintenanceEmailAction would render a SECOND identical group and
            duplicate the "Download Photos for Outlook" heading text on the
            page. MaintenanceEmailAction's own photoDownloads-driven group
            stays in the component for contexts that render it WITHOUT an
            adjacent Photos card (there are none yet, but the prop exists for
            exactly that future reuse — see its own doc comment). */}
        {emailRouting.state === 'valid' ? (
          <div className="min-w-0 flex-1">
            <MaintenanceEmailAction
              requestId={requestId}
              emailInput={emailInput}
              recipients={emailRouting.recipients}
              initialOpenCount={initialOpenCount}
            />
          </div>
        ) : (
          <span />
        )}
        {/* Editing happens on the detail page itself — this is a saved
            request, not a draft form, so "Edit Request" is a plain link back
            to the same page with the review query param dropped, not a
            second form. */}
        <Button asChild variant="outline">
          <Link href={`/dashboard/maintenance/${requestId}`}>Edit Request</Link>
        </Button>
      </div>
    </div>
  );
}
