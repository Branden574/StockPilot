import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { can, formatMaintenanceRequestNumber, relatedLocationText, uuidSchema } from '@stockpilot/core';

import { AssignOwnerSelect, type MaintenanceOwnerOption } from '@/components/maintenance/assign-owner-select';
import { MaintenanceEmailAction } from '@/components/maintenance/maintenance-email-action';
import { MaintenanceNotesPanel, type MaintenanceNoteRow } from '@/components/maintenance/maintenance-notes-panel';
import { MaintenanceReview } from '@/components/maintenance/maintenance-review';
import { MaintenanceStatusBadge } from '@/components/maintenance/maintenance-status-badge';
import { MaintenanceShareLinkProvider } from '@/components/maintenance/share-link-context';
import { ShareLinkPanel, type MaintenanceShareLinkStatus } from '@/components/maintenance/share-link-panel';
import { ModuleUnavailable } from '@/components/dashboard/module-unavailable';
import { DetailSection } from '@/components/patterns/detail-section';
import { KeyValueList, KeyValueRow } from '@/components/patterns/key-value-row';
import { PageHeaderBackLink } from '@/components/patterns/page-header';
import { PatternPhoto } from '@/components/patterns/photo';
import { Badge } from '@/components/ui/badge';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { formatRelative } from '@/lib/utils';
import { ServiceError, withContext } from '@/server/services/context';
import { MaintenanceAttachmentsService } from '@/server/services/maintenance-attachments';
import { fetchAcceptedMembers } from '@/server/lib/maintenance-members';
import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';
import { MaintenanceShareLinksService, maintenanceShareLinksEnabled } from '@/server/services/maintenance-share-links';

import { MaintenancePhotosPanelClient, MaintenanceRequestActions } from './detail-client';

export const dynamic = 'force-dynamic';

/**
 * The page box every redesigned dashboard page shares (DESIGN-SPEC 4 and 5.3:
 * max 1320, 28 / 32 / 64 padding, 16 px gutters on a phone, 16 px between
 * blocks).
 */
const PAGE_BOX =
  'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/** One label / value row of the Details card (DESIGN-SPEC 6.7); a blank
 *  value leaves the row out, as before. */
function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return null;
  return <KeyValueRow label={label}>{v}</KeyValueRow>;
}

/** One StockPilot activity row: the event in ink, its time quiet. */
function ActivityRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <KeyValueRow
      label={label}
      labelClassName="text-foreground"
      valueClassName="text-muted-foreground"
    >
      {children}
    </KeyValueRow>
  );
}

/** A read-only grid of request photos (a closed request, the resolution
 *  proof): the small rendition in a fixed tile, the missing-photo hatch when
 *  a signed link has expired. */
function PhotoGrid({
  photos,
}: {
  photos: { id: string; url: string; thumbUrl: string | null; originalFilename: string }[];
}) {
  return (
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
  );
}

export default async function MaintenanceRequestDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ review?: string }>;
}) {
  const { id } = await params;
  // RSC PARAM SAFETY (recurring pattern #1 / Task 8's forward requirement):
  // MaintenanceRequestsService.get() turns a malformed uuid into an opaque
  // internal_error (a raw Postgres 22P02), so the param SHAPE is validated
  // here, before any service call — a bad id is a clean notFound(), never
  // an error-boundary crash and never an opaque 500. Matches the mobile
  // route's identical guard (api/v1/maintenance-requests/[id]/route.ts).
  if (!uuidSchema.safeParse(id).success) notFound();

  const access = await checkModuleAccess('maintenance_requests');
  if (!access.enabled) {
    return <ModuleUnavailable moduleId="maintenance_requests" access={access} />;
  }

  const ctx = await withContext();
  const svc = new MaintenanceRequestsService(ctx);

  let detail;
  try {
    detail = await svc.get(id);
  } catch (e) {
    // get()'s I1 check (server/services/maintenance-requests.ts) returns
    // not_found — never forbidden — for any request this caller cannot see
    // (requester-own OR read_all OR manage), so an unauthorized id and a
    // truly missing one are indistinguishable here: never confirm a foreign
    // row exists. Any other ServiceError (internal_error, etc.) propagates
    // to the dashboard error boundary, same as every other detail page.
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }

  const canManage = can(ctx, 'maintenance_requests:manage');
  const isOwningRequester = detail.requesterUserId === ctx.userId;
  // Maintenance Resolved (spec §1.3): a resolved request is closed the same
  // way an archived/cancelled one is — widened here, the ONE place `closed`
  // is computed, so every gate below (photos edit, Resolve/Archive/Cancel
  // visibility) picks it up automatically.
  const closed = Boolean(detail.archivedAt || detail.cancelledAt || detail.resolvedAt);

  const photos = await new MaintenanceAttachmentsService(ctx).signedViewUrls(id);
  // Proof-photo kind split (spec §4.1). `kind` is a NOT NULL column
  // defaulting to 'requester' at the DB (migration 0317), so the `??` here
  // is defensive only — real rows always carry a kind. The requester card
  // keeps its shipped identity/behavior (editable pre-close via
  // MaintenancePhotosPanelClient); the resolution card is new and always
  // read-only, since resolution photos only ever exist on a request that is
  // resolved or about to be (spec §12.5's pre-flip staging).
  const requesterPhotos = photos.filter((p) => (p.kind ?? 'requester') === 'requester');
  const resolutionPhotos = photos.filter((p) => p.kind === 'resolution');

  // Share-link STATUS read (mig 0330): rendering no longer mints — the
  // token is hashed at rest, so an auto-mint here could only ever ROTATE
  // (invalidating whatever URL was already emailed out) and still could
  // not display anything. getActiveLinkStatus()'s bar (manage, OR the
  // owning requester holding submit) is narrower than get()'s bar for
  // merely VIEWING (owner OR read_all OR manage) — a read_all-only viewer
  // of someone else's request must still get a working page. Any
  // ServiceError degrades to shareLinkStatus: null; a non-ServiceError (a
  // real bug) still propagates to the error boundary, same as the route.
  let shareLinkStatus: MaintenanceShareLinkStatus | null = null;
  if (photos.length > 0 && (await maintenanceShareLinksEnabled(ctx))) {
    try {
      shareLinkStatus = await new MaintenanceShareLinksService(ctx).getActiveLinkStatus(id);
    } catch (shareErr) {
      if (!(shareErr instanceof ServiceError)) throw shareErr;
    }
  }
  // shareUrl is null at render — the plaintext URL only exists in the
  // moment ShareLinkPanel generates one; MaintenanceEmailAction folds that
  // fresh URL in client-side through MaintenanceShareLinkProvider.
  //
  // `emailInput` is the CONTENT (always built — the related-record panels
  // below render from it); `emailRouting` is the org's per-feature routing
  // resolution (migration 0337) and decides whether any compose action
  // exists: members simply see no email action on 'unset'/'invalid', while
  // holders of organization:update see an inline pointer to Settings.
  const { content: emailInput, emailRouting } = await svc.emailInput(id, { shareUrl: null });
  const canConfigureRouting = can(ctx, 'organization:update');

  const sp = await searchParams;
  if (sp.review === '1') {
    // The post-save review screen (Task 13 redirects here straight out of
    // the create form) is a fully self-contained single-column screen —
    // MaintenanceReview already renders its own subject/description/
    // photos/email-preview sections, so it replaces the whole page rather
    // than nesting inside the two-column layout below (which would
    // duplicate every field it already shows).
    return (
      <div className={PAGE_BOX}>
        <MaintenanceReview
          detail={detail}
          photos={photos}
          emailInput={emailInput}
          emailRouting={emailRouting}
          canConfigureRouting={canConfigureRouting}
          initialOpenCount={detail.outlookDraftOpenCount}
        />
      </div>
    );
  }

  // Internal notes are manage-only end to end (0314 RLS + listNotes()'s own
  // assertPermission('maintenance_requests:manage')) — never fetched for a
  // non-manager, so a requester never even causes the round trip, let alone
  // sees the result. MaintenanceNotesPanel carries its own second,
  // independent `canManage` guard as defense in depth. The member list
  // backs both the owner picker and note-author display, fetched under the
  // same gate since only managers see either.
  let notes: MaintenanceNoteRow[] = [];
  let members: MaintenanceOwnerOption[] = [];
  if (canManage) {
    [notes, members] = await Promise.all([svc.listNotes(id), fetchAcceptedMembers(ctx)]);
  }
  const authorNames: Record<string, string> = Object.fromEntries(members.map((m) => [m.userId, m.name]));

  // Real audit-log-driven timeline rows (fix wave Important 1) — every
  // viewer who reaches this branch already passed get()'s own view boundary
  // (requester-own OR read_all OR manage), same as the rest of this page,
  // so this is fetched unconditionally here (unlike notes/members, which
  // stay manage-only). Never fetched for the ?review=1 branch above, which
  // returns before this point and has no use for it.
  const timelineEvents = await svc.listTimelineEvents(id);
  const photoUploadedAt = timelineEvents
    .filter((e) => e.event === 'maintenance_request.attachment_added')
    .map((e) => e.createdAt);
  // The current local_owner_user_id column is only ever written by
  // assignLocalOwner(), which always audits owner_assigned in the same
  // call — the MOST RECENT such event is the one that produced today's
  // value, so its timestamp is what "Local owner assigned" reports.
  const ownerAssignedAt =
    timelineEvents.filter((e) => e.event === 'maintenance_request.owner_assigned').at(-1)?.createdAt ?? null;

  const requestNumber =
    formatMaintenanceRequestNumber(detail.requestNumber, detail.createdAt) ?? String(detail.requestNumber);


  return (
    <div className={PAGE_BOX}>
      {/* The record header (DESIGN-SPEC 6.1, the item-detail variant without
          a photo): back link, the request number as the page's only h1 with
          its status and priority beside it, the subject line under it, and
          the request's actions on the right. It keeps its own title column
          (min-w-0 flex-1 basis-72, a truncating h1) rather than the shared
          PageHeader: the detail-title guard pins that column on this page so
          the actions wrap under the number instead of squeezing it. */}
      <div className="flex min-w-0 flex-col">
        <div className="mb-2">
          <PageHeaderBackLink href="/dashboard/maintenance">
            ← Back to maintenance requests
          </PageHeaderBackLink>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 flex-1 basis-72">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="truncate font-display text-[26px] font-medium leading-[1.2] tracking-[-0.025em]">
                {requestNumber}
              </h1>
              <MaintenanceStatusBadge status={detail.status} />
              <Badge variant="outline" className="capitalize">
                {detail.priority}
              </Badge>
            </div>
            <p className="text-muted-foreground mt-1.5 text-[13.5px] [overflow-wrap:anywhere]">
              {detail.subject} · Created {formatRelative(detail.createdAt)}
            </p>
          </div>
          <MaintenanceRequestActions
            requestId={detail.id}
            requesterName={detail.requesterName}
            showResolve={canManage && !closed}
            showArchive={canManage && !detail.archivedAt}
            showCancel={isOwningRequester && !closed}
            resolutionPhotos={resolutionPhotos}
          />
        </div>
      </div>

      {/* Mig 0330: the provider is the seam that carries a freshly-
          generated share URL from ShareLinkPanel (aside) into
          MaintenanceEmailAction (main column) — the ONLY way a compose
          draft can include the link now that the server cannot re-read
          the plaintext at render time. */}
      <MaintenanceShareLinkProvider>
        {/* Two columns with an aside (DESIGN-SPEC 7.4's item-detail split):
            the request on the left, its details and working tools on the
            right; one column below lg. */}
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(280px,1fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            <DetailSection title="Description">
              <p className="whitespace-pre-wrap text-[13.5px] leading-[20.25px] [overflow-wrap:anywhere]">
                {detail.description}
              </p>
            </DetailSection>

            {detail.resolvedAt ? (
              <DetailSection title="Resolution">
                <p className="whitespace-pre-wrap text-[13.5px] leading-[20.25px] [overflow-wrap:anywhere]">
                  {detail.resolutionNote}
                </p>
                <p className="text-muted-foreground mt-2 text-[12px]">
                  Marked resolved by {detail.resolvedByName} · {formatRelative(detail.resolvedAt)}
                </p>
              </DetailSection>
            ) : null}

            <DetailSection title={`Photos (${requesterPhotos.length})`}>
              {closed ? (
                requesterPhotos.length === 0 ? (
                  <p className="text-muted-foreground text-[13.5px]">
                    No photos were added to this request.
                  </p>
                ) : (
                  <PhotoGrid photos={requesterPhotos} />
                )
              ) : (
                <MaintenancePhotosPanelClient requestId={detail.id} photos={requesterPhotos} />
              )}
              {closed ? (
                <p className="text-muted-foreground mt-3 text-[12px]">
                  This request is closed. Photos can no longer be added or removed.
                </p>
              ) : null}
            </DetailSection>

            {resolutionPhotos.length > 0 ? (
              <DetailSection title={`Resolution proof (${resolutionPhotos.length})`}>
                <PhotoGrid photos={resolutionPhotos} />
                <p className="text-muted-foreground mt-3 text-[12px]">
                  {/* Fix wave (Important 1): this card intentionally renders
                      STRAY kind='resolution' rows even on a still-open request
                      (a manager staged proof photos then cancelled the Resolve
                      dialog — spec §12.5's pre-flip staging is designed,
                      disclosed behavior, not a bug). Hiding those rows from
                      the requester would be worse than showing them, but the
                      caption must never claim resolution happened when it
                      hasn't — so the claim itself is gated on the ONE fact
                      that actually means "resolved", `detail.resolvedAt`,
                      never on `resolutionPhotos.length > 0` (spec §11
                      Vocabulary: "marked resolved" is only true of a real
                      StockPilot record). */}
                  {detail.resolvedAt
                    ? 'Added by the team when this request was marked resolved.'
                    : 'Staged by the team while preparing to mark this request resolved.'}
                </p>
              </DetailSection>
            ) : null}

            {emailRouting.state === 'valid' ? (
              <DetailSection title="Email">
                <MaintenanceEmailAction
                  requestId={detail.id}
                  emailInput={emailInput}
                  recipients={emailRouting.recipients}
                  initialOpenCount={detail.outlookDraftOpenCount}
                  photoDownloads={requesterPhotos.map((p) => ({
                    url: p.url,
                    filename: p.originalFilename,
                  }))}
                />
              </DetailSection>
            ) : canConfigureRouting ? (
              // Admin-only hint (fallback matrix states B/D): an admin who
              // just enabled the module would otherwise wonder where the
              // email action went. Members see nothing — the record flow
              // (save, photos, share link, resolve) is untouched.
              <DetailSection title="Email">
                <p
                  className="text-muted-foreground text-[13.5px]"
                  data-testid="maintenance-routing-hint"
                >
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
          </div>

          <aside className="flex min-w-0 flex-col gap-4">
            <DetailSection title="Details" flush>
              <KeyValueList>
                <DetailRow label="Requester" value={detail.requesterName} />
                <DetailRow label="Requester email" value={detail.requesterEmail} />
                <DetailRow label="Requester phone" value={detail.requesterPhone} />
                <DetailRow label="Site" value={detail.siteName} />
                <DetailRow label="Building" value={detail.building} />
                <DetailRow label="Room or area" value={detail.roomOrArea} />
                <DetailRow label="Department" value={detail.department} />
                <DetailRow label="Category" value={detail.category} />
                <DetailRow label="Access instructions" value={detail.accessInstructions} />
                {emailInput.relatedItem ? (
                  <KeyValueRow label="Related item">
                    {emailInput.relatedItem.url ? (
                      <a
                        href={emailInput.relatedItem.url}
                        className="text-accent hover:text-foreground hover:underline"
                      >
                        {emailInput.relatedItem.name}
                      </a>
                    ) : (
                      emailInput.relatedItem.name
                    )}
                  </KeyValueRow>
                ) : null}
                {/* F1-5: the location the request is about (an escalated
                    exception's rack, Staging or Unplaced). Names only, read by
                    emailInput() from the request's related_location_id. */}
                <DetailRow
                  label="Related location"
                  value={relatedLocationText(emailInput.relatedLocation)}
                />
                {emailInput.relatedOrder ? (
                  <KeyValueRow label="Related order">
                    {emailInput.relatedOrder.url ? (
                      <a
                        href={emailInput.relatedOrder.url}
                        className="text-accent hover:text-foreground hover:underline"
                      >
                        {emailInput.relatedOrder.handle}
                      </a>
                    ) : (
                      emailInput.relatedOrder.handle
                    )}
                  </KeyValueRow>
                ) : null}
                {emailInput.relatedRental ? (
                  <KeyValueRow label="Related rental">
                    {emailInput.relatedRental.url ? (
                      <a
                        href={emailInput.relatedRental.url}
                        className="text-accent hover:text-foreground hover:underline"
                      >
                        {emailInput.relatedRental.itemNames.join(', ') || 'Rental record'}
                      </a>
                    ) : (
                      emailInput.relatedRental.itemNames.join(', ') || 'Rental record'
                    )}
                  </KeyValueRow>
                ) : null}
              </KeyValueList>

              {canManage ? (
                <div className="border-border border-t px-[18px] py-3.5">
                  <AssignOwnerSelect
                    requestId={detail.id}
                    currentOwnerUserId={detail.localOwnerUserId}
                    members={members}
                  />
                </div>
              ) : detail.localOwnerUserId ? (
                // Its own description list: a dt/dd pair is only valid
                // inside a dl (it used to sit loose under the card).
                <KeyValueList className="border-border border-t">
                  <KeyValueRow label="StockPilot owner">Assigned</KeyValueRow>
                </KeyValueList>
              ) : null}
            </DetailSection>

            <DetailSection title="StockPilot activity" aria-label="StockPilot activity" flush>
              {/* No fake ticket conversation timeline (brief §23) — every row
                  below is a real, locally-observed StockPilot event, never a
                  claim about Outlook/Zendesk state this app cannot see. */}
              <p className="text-muted-foreground border-border border-b px-[18px] py-3 text-[12px] leading-[18px]">
                Local StockPilot actions only. Ticket replies happen in the Outlook/Zendesk email
                conversation and are not shown here.
              </p>
              <KeyValueList>
                <ActivityRow label="Request saved">{formatRelative(detail.createdAt)}</ActivityRow>
                {photoUploadedAt.map((createdAt, i) => (
                  <ActivityRow key={`photo-${i}`} label="Photo uploaded">
                    {formatRelative(createdAt)}
                  </ActivityRow>
                ))}
                {detail.outlookDraftOpenedAt ? (
                  <ActivityRow
                    label={
                      <>
                        Outlook draft opened
                        {detail.outlookDraftOpenCount > 1
                          ? ` ×${detail.outlookDraftOpenCount}`
                          : ''}
                      </>
                    }
                  >
                    {formatRelative(detail.outlookDraftOpenedAt)}
                  </ActivityRow>
                ) : null}
                {detail.localOwnerUserId ? (
                  <ActivityRow label="Local owner assigned">
                    {ownerAssignedAt ? formatRelative(ownerAssignedAt) : '—'}
                  </ActivityRow>
                ) : null}
                {detail.resolvedAt ? (
                  <ActivityRow label="Marked resolved">
                    {formatRelative(detail.resolvedAt)}
                  </ActivityRow>
                ) : null}
                {detail.archivedAt ? (
                  <ActivityRow label="Request archived">
                    {formatRelative(detail.archivedAt)}
                  </ActivityRow>
                ) : null}
                {detail.cancelledAt ? (
                  <ActivityRow label="Request cancelled">
                    {formatRelative(detail.cancelledAt)}
                  </ActivityRow>
                ) : null}
              </KeyValueList>
            </DetailSection>

            {/* Important 2 (fix wave): issueLink's own tier (maintenance-
                share-links.ts) deliberately admits the owning requester
                (submit + owns it), not just manage — the affordance here must
                match. The owning requester gets Generate-only (canRevoke
                false): revoke() is genuinely manage-only server-side, so a
                Revoke button for a non-manager owner would only ever 403. A
                read_all-only non-owner is neither manage nor the owning
                requester and sees no panel at all. */}
            {canManage || isOwningRequester ? (
              <ShareLinkPanel
                requestId={detail.id}
                status={shareLinkStatus}
                canRevoke={canManage}
              />
            ) : null}

            {canManage ? (
              <MaintenanceNotesPanel
                requestId={detail.id}
                canManage={canManage}
                notes={notes}
                authorNames={authorNames}
                truncated={notes.length >= 500}
              />
            ) : null}
          </aside>
        </div>
      </MaintenanceShareLinkProvider>
    </div>
  );
}
