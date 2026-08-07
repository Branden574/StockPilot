import Link from 'next/link';
import { notFound } from 'next/navigation';

import { can, formatMaintenanceRequestNumber, uuidSchema } from '@stockpilot/core';

import { AssignOwnerSelect, type MaintenanceOwnerOption } from '@/components/maintenance/assign-owner-select';
import { MaintenanceEmailAction } from '@/components/maintenance/maintenance-email-action';
import { MaintenanceNotesPanel, type MaintenanceNoteRow } from '@/components/maintenance/maintenance-notes-panel';
import { MaintenanceReview } from '@/components/maintenance/maintenance-review';
import { MaintenanceStatusBadge } from '@/components/maintenance/maintenance-status-badge';
import { ShareLinkPanel, type MaintenanceShareLinkInfo } from '@/components/maintenance/share-link-panel';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { Badge } from '@/components/ui/badge';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { formatRelative } from '@/lib/utils';
import { ServiceError, withContext, type ServiceContext } from '@/server/services/context';
import { MaintenanceAttachmentsService } from '@/server/services/maintenance-attachments';
import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';
import { MaintenanceShareLinksService, maintenanceShareLinksEnabled } from '@/server/services/maintenance-share-links';

import { MaintenancePhotosPanelClient, MaintenanceRequestActions } from './detail-client';

export const dynamic = 'force-dynamic';

/** organization_members embedding user_profiles!user_id, filtered to
 *  accepted members — same query cycle-counts/new/page.tsx:36-57 uses for
 *  its own assignee picker. Backs BOTH the owner picker and note-author
 *  name resolution, since only a manage-holder ever sees either. */
async function fetchAcceptedMembers(ctx: ServiceContext): Promise<MaintenanceOwnerOption[]> {
  const { data: rawMembers } = await ctx.supabase
    .from('organization_members')
    .select('user_id, user:user_profiles!user_id (id, full_name, email)')
    .eq('organization_id', ctx.organizationId)
    .not('accepted_at', 'is', null);
  type MemberRow = {
    user_id: string;
    user:
      | { id: string; full_name: string | null; email: string }
      | { id: string; full_name: string | null; email: string }[]
      | null;
  };
  return ((rawMembers ?? []) as MemberRow[])
    .map((row) => {
      const u = Array.isArray(row.user) ? row.user[0] : row.user;
      if (!u) return null;
      return { userId: u.id, name: u.full_name ?? u.email };
    })
    .filter((m): m is MaintenanceOwnerOption => Boolean(m))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return null;
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{v}</dd>
    </div>
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
    return <ModuleNotEnabled moduleId="maintenance_requests" canManage={access.canManage} />;
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

  // Share-link mint: mirrors the mobile REST route's GET handler exactly.
  // ensureActiveLink()'s bar (manage, OR the owning requester holding
  // submit) is narrower than get()'s bar for merely VIEWING (owner OR
  // read_all OR manage) — a read_all-only viewer of someone else's request
  // must still get a working page. Any ServiceError out of the mint
  // attempt degrades to shareLink: null; a non-ServiceError (a real bug)
  // still propagates to the error boundary, same as the route.
  let shareLink: MaintenanceShareLinkInfo | null = null;
  if (photos.length > 0 && (await maintenanceShareLinksEnabled(ctx))) {
    try {
      shareLink = await new MaintenanceShareLinksService(ctx).ensureActiveLink(id);
    } catch (shareErr) {
      if (!(shareErr instanceof ServiceError)) throw shareErr;
    }
  }
  const emailInput = await svc.emailInput(id, { shareUrl: shareLink?.url ?? null });

  const sp = await searchParams;
  if (sp.review === '1') {
    // The post-save review screen (Task 13 redirects here straight out of
    // the create form) is a fully self-contained single-column screen —
    // MaintenanceReview already renders its own subject/description/
    // photos/email-preview sections, so it replaces the whole page rather
    // than nesting inside the two-column layout below (which would
    // duplicate every field it already shows).
    return (
      <div className="container mx-auto px-4 py-8 sm:px-6">
        <MaintenanceReview
          detail={detail}
          photos={photos}
          emailInput={emailInput}
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
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link href="/dashboard/maintenance" className="text-muted-foreground hover:text-foreground text-sm">
          ← Back to maintenance requests
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-2xl font-semibold tracking-tight">{requestNumber}</h1>
              <MaintenanceStatusBadge status={detail.status} />
              <Badge variant="outline" className="capitalize">
                {detail.priority}
              </Badge>
            </div>
            <p className="text-muted-foreground mt-1 text-sm">
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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <section className="bg-card rounded-xl border p-4">
            <h2 className="text-sm font-medium">Description</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm">{detail.description}</p>
          </section>

          {detail.resolvedAt ? (
            <section className="bg-card rounded-xl border p-4">
              <h2 className="text-sm font-medium">Resolution</h2>
              <p className="mt-2 whitespace-pre-wrap text-sm">{detail.resolutionNote}</p>
              <p className="text-muted-foreground mt-2 text-xs">
                Marked resolved by {detail.resolvedByName} · {formatRelative(detail.resolvedAt)}
              </p>
            </section>
          ) : null}

          <section className="bg-card rounded-xl border p-4">
            <h2 className="mb-3 text-sm font-medium">Photos ({requesterPhotos.length})</h2>
            {closed ? (
              requesterPhotos.length === 0 ? (
                <p className="text-muted-foreground text-sm">No photos were added to this request.</p>
              ) : (
                <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                  {requesterPhotos.map((p) => (
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
              )
            ) : (
              <MaintenancePhotosPanelClient requestId={detail.id} photos={requesterPhotos} />
            )}
            {closed ? (
              <p className="text-muted-foreground mt-2 text-xs">
                This request is closed. Photos can no longer be added or removed.
              </p>
            ) : null}
          </section>

          {resolutionPhotos.length > 0 ? (
            <section className="bg-card rounded-xl border p-4">
              <h2 className="mb-3 text-sm font-medium">Resolution proof ({resolutionPhotos.length})</h2>
              <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                {resolutionPhotos.map((p) => (
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
              <p className="text-muted-foreground mt-2 text-xs">
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
            </section>
          ) : null}

          <section className="bg-card rounded-xl border p-4">
            <h2 className="mb-3 text-sm font-medium">Email</h2>
            <MaintenanceEmailAction
              requestId={detail.id}
              emailInput={emailInput}
              initialOpenCount={detail.outlookDraftOpenCount}
              photoDownloads={requesterPhotos.map((p) => ({ url: p.url, filename: p.originalFilename }))}
            />
          </section>
        </div>

        <aside className="space-y-4">
          <section className="bg-card rounded-xl border p-4 text-xs">
            <h2 className="text-muted-foreground mb-2 text-[10.5px] uppercase tracking-[0.08em]">Details</h2>
            <dl className="space-y-1.5 text-[11.5px]">
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
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Related item</dt>
                  <dd className="text-right">
                    {emailInput.relatedItem.url ? (
                      <a href={emailInput.relatedItem.url} className="hover:underline">
                        {emailInput.relatedItem.name}
                      </a>
                    ) : (
                      emailInput.relatedItem.name
                    )}
                  </dd>
                </div>
              ) : null}
              {emailInput.relatedOrder ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Related order</dt>
                  <dd className="text-right">
                    {emailInput.relatedOrder.url ? (
                      <a href={emailInput.relatedOrder.url} className="hover:underline">
                        {emailInput.relatedOrder.handle}
                      </a>
                    ) : (
                      emailInput.relatedOrder.handle
                    )}
                  </dd>
                </div>
              ) : null}
              {emailInput.relatedRental ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Related rental</dt>
                  <dd className="text-right">
                    {emailInput.relatedRental.url ? (
                      <a href={emailInput.relatedRental.url} className="hover:underline">
                        {emailInput.relatedRental.itemNames.join(', ') || 'Rental record'}
                      </a>
                    ) : (
                      emailInput.relatedRental.itemNames.join(', ') || 'Rental record'
                    )}
                  </dd>
                </div>
              ) : null}
            </dl>

            {canManage ? (
              <div className="mt-3 border-t pt-3">
                <AssignOwnerSelect
                  requestId={detail.id}
                  currentOwnerUserId={detail.localOwnerUserId}
                  members={members}
                />
              </div>
            ) : detail.localOwnerUserId ? (
              <div className="mt-3 flex justify-between gap-3 border-t pt-3">
                <dt className="text-muted-foreground">StockPilot owner</dt>
                <dd className="text-right">Assigned</dd>
              </div>
            ) : null}
          </section>

          <section aria-label="StockPilot activity" className="bg-card rounded-xl border p-4 text-xs">
            <h2 className="text-muted-foreground mb-1 text-[10.5px] uppercase tracking-[0.08em]">
              StockPilot activity
            </h2>
            {/* No fake ticket conversation timeline (brief §23) — every row
                below is a real, locally-observed StockPilot event, never a
                claim about Outlook/Zendesk state this app cannot see. */}
            <p className="text-muted-foreground mb-2 text-[11px]">
              Local StockPilot actions only. Ticket replies happen in the Outlook/Zendesk email conversation and
              are not shown here.
            </p>
            <dl className="space-y-1.5 text-[11.5px]">
              <div className="flex justify-between gap-3">
                <dt>Request saved</dt>
                <dd className="text-muted-foreground text-right tabular-nums">
                  {formatRelative(detail.createdAt)}
                </dd>
              </div>
              {photoUploadedAt.map((createdAt, i) => (
                <div key={`photo-${i}`} className="flex justify-between gap-3">
                  <dt>Photo uploaded</dt>
                  <dd className="text-muted-foreground text-right tabular-nums">{formatRelative(createdAt)}</dd>
                </div>
              ))}
              {detail.outlookDraftOpenedAt ? (
                <div className="flex justify-between gap-3">
                  <dt>
                    Outlook draft opened
                    {detail.outlookDraftOpenCount > 1 ? ` ×${detail.outlookDraftOpenCount}` : ''}
                  </dt>
                  <dd className="text-muted-foreground text-right tabular-nums">
                    {formatRelative(detail.outlookDraftOpenedAt)}
                  </dd>
                </div>
              ) : null}
              {detail.localOwnerUserId ? (
                <div className="flex justify-between gap-3">
                  <dt>Local owner assigned</dt>
                  <dd className="text-muted-foreground text-right tabular-nums">
                    {ownerAssignedAt ? formatRelative(ownerAssignedAt) : '—'}
                  </dd>
                </div>
              ) : null}
              {detail.resolvedAt ? (
                <div className="flex justify-between gap-3">
                  <dt>Marked resolved</dt>
                  <dd className="text-muted-foreground text-right tabular-nums">
                    {formatRelative(detail.resolvedAt)}
                  </dd>
                </div>
              ) : null}
              {detail.archivedAt ? (
                <div className="flex justify-between gap-3">
                  <dt>Request archived</dt>
                  <dd className="text-muted-foreground text-right tabular-nums">
                    {formatRelative(detail.archivedAt)}
                  </dd>
                </div>
              ) : null}
              {detail.cancelledAt ? (
                <div className="flex justify-between gap-3">
                  <dt>Request cancelled</dt>
                  <dd className="text-muted-foreground text-right tabular-nums">
                    {formatRelative(detail.cancelledAt)}
                  </dd>
                </div>
              ) : null}
            </dl>
          </section>

          {/* Important 2 (fix wave): ensureActiveLink's own tier (maintenance-
              share-links.ts) deliberately admits the owning requester
              (submit + owns it), not just manage — the affordance here must
              match. The owning requester gets a COPY-ONLY view (canRevoke
              false): revoke() is genuinely manage-only server-side, so a
              Revoke button for a non-manager owner would only ever 403. A
              read_all-only non-owner is neither manage nor the owning
              requester and sees no panel at all. */}
          {canManage || isOwningRequester ? (
            <ShareLinkPanel requestId={detail.id} link={shareLink} canRevoke={canManage} />
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
    </div>
  );
}
