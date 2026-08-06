import Link from 'next/link';

import {
  formatMaintenanceRequestNumber,
  MAINTENANCE_CC_NOTICE,
  prepareMaintenanceEmail,
  type MaintenanceEmailInput,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

/** 'Label: value' as a single dt/dd pair — omits itself entirely when the
 *  value is blank, matching the pure email builder's own `line()` rule
 *  (packages/core/src/maintenance/email.ts) so the review screen never shows
 *  a field the generated email itself would have dropped. */
function Field({ label, value }: { label: string; value: string | null | undefined }) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm">{v}</dd>
    </div>
  );
}

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
  requestId,
  detail,
  photos,
  emailInput,
  initialOpenCount,
}: {
  requestId: string;
  detail: MaintenanceRequestDetail;
  photos: PanelPhoto[];
  emailInput: MaintenanceEmailInput;
  initialOpenCount: number;
}) {
  const prepared = prepareMaintenanceEmail(emailInput);
  const requestNumber =
    formatMaintenanceRequestNumber(detail.requestNumber, detail.createdAt) ?? String(detail.requestNumber);
  const photoDownloads = photos.map((p) => ({ url: p.url, filename: p.originalFilename }));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Review maintenance request</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {requestNumber} &middot; {detail.subject}
          </p>
        </div>
        <MaintenanceStatusBadge status={detail.status} />
      </div>

      {/* Spec line 8's exact helper sentence — the honesty anchor for this
          whole screen: saved, but not sent, and never automatically. */}
      <p className="rounded-md border border-dashed p-3 text-sm">
        Your request has been saved in StockPilot. Outlook will open with the email details filled in, but the
        email will not be sent automatically.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Request details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2">
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
          </dl>
          <div className="mt-4">
            <p className="text-xs font-medium text-muted-foreground">Description</p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{detail.description}</p>
          </div>

          {emailInput.relatedItem || emailInput.relatedOrder || emailInput.relatedRental ? (
            <div className="mt-4 space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Related StockPilot record</p>
              {emailInput.relatedItem ? (
                <p className="text-sm">
                  Item:{' '}
                  {emailInput.relatedItem.url ? (
                    <a className="underline underline-offset-2" href={emailInput.relatedItem.url}>
                      {emailInput.relatedItem.name}
                    </a>
                  ) : (
                    emailInput.relatedItem.name
                  )}
                  {emailInput.relatedItem.sku ? ` (${emailInput.relatedItem.sku})` : ''}
                </p>
              ) : null}
              {emailInput.relatedOrder ? (
                <p className="text-sm">
                  Order:{' '}
                  {emailInput.relatedOrder.url ? (
                    <a className="underline underline-offset-2" href={emailInput.relatedOrder.url}>
                      {emailInput.relatedOrder.handle}
                    </a>
                  ) : (
                    emailInput.relatedOrder.handle
                  )}
                </p>
              ) : null}
              {emailInput.relatedRental ? (
                <p className="text-sm">
                  Rental of{' '}
                  {emailInput.relatedRental.url ? (
                    <a className="underline underline-offset-2" href={emailInput.relatedRental.url}>
                      {emailInput.relatedRental.itemNames.join(', ') || 'rental record'}
                    </a>
                  ) : (
                    emailInput.relatedRental.itemNames.join(', ') || 'rental record'
                  )}
                </p>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {photos.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Photos ({photos.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
              {photos.map((p) => (
                <li key={p.id}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.thumbUrl ?? p.url}
                    alt={p.originalFilename}
                    className="h-24 w-full rounded-lg border object-cover"
                  />
                </li>
              ))}
            </ul>
            {/* Brief section 10's suggested helper text, verbatim. */}
            <p className="text-sm text-muted-foreground">
              Outlook cannot add StockPilot photos automatically. The photo links will be included in the
              message, and you can download the photos here if you want to attach them directly.
            </p>
            <div>
              <p className="text-sm font-medium">Download Photos for Outlook</p>
              <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {photos.map((p) => (
                  <li key={p.id}>
                    <a
                      href={p.url}
                      download={p.originalFilename}
                      className="text-sm underline underline-offset-2"
                    >
                      {p.originalFilename}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Email preview</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="text-sm">
            <div>
              <dt className="inline text-muted-foreground">To </dt>
              <dd className="inline">{prepared.draft.to}</dd>
            </div>
            <div>
              <dt className="inline text-muted-foreground">CC </dt>
              <dd className="inline">{prepared.draft.cc}</dd>
            </div>
          </dl>
          <p className="text-sm text-muted-foreground">{MAINTENANCE_CC_NOTICE}</p>

          <div>
            <p className="text-xs font-medium text-muted-foreground">Subject</p>
            <p className="mt-1 text-sm">{prepared.draft.subject}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Body</p>
            <pre className="mt-1 whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">
              {prepared.draft.body}
            </pre>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <MaintenanceEmailAction
          requestId={requestId}
          emailInput={emailInput}
          initialOpenCount={initialOpenCount}
          photoDownloads={photoDownloads.length > 0 ? photoDownloads : undefined}
        />
        {/* Editing happens on the detail page itself — this is a saved
            request, not a draft form, so "Edit Request" is a plain link back
            to the same page with the review query param dropped, not a
            second form. */}
        <Button asChild variant="ghost">
          <Link href={`/dashboard/maintenance/${requestId}`}>Edit Request</Link>
        </Button>
      </div>
    </div>
  );
}
