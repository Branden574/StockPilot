import 'server-only';

import {
  can,
  formatMaintenanceRequestNumber,
  formatOrderNumber,
  maintenanceRequestFormSchema,
  parseMaintenanceRequestNumber,
  uuidSchema,
  type MaintenanceEmailInput,
  type MaintenancePriority,
  type MaintenanceStatus,
} from '@stockpilot/core';

import { checkRateLimit } from '@/lib/rate-limit';
import { formatOrgDateTime, ORG_TIMEZONE_DEFAULT } from '@/lib/timezone';
import { createAdminClient } from '@/lib/supabase/admin';

import { audit } from './audit';
import { assertModuleEnabled, assertPermission, ServiceError, type ServiceContext } from './context';

/**
 * The ONLY audit_logs events the detail page's "StockPilot activity"
 * timeline may ever surface (fix wave Important 1). `audit_logs` SELECT
 * under RLS requires the `activity_logs:read` permission (migration 0279),
 * which is DISTINCT from `maintenance_requests:manage` — a manager who was
 * never separately granted `activity_logs:read` gets zero rows back from a
 * plain `ctx.supabase` read, silently. `listTimelineEvents` below therefore
 * reads on the ADMIN client (same posture as the WRITES in
 * maintenance-share-links.ts), but only after re-deriving get()'s own view
 * boundary first, and only for this one request's own rows.
 *
 * Belt-and-suspenders allow-listing: the query itself filters on `.in(...)`
 * (so the admin client never even pulls a non-maintenance event off the
 * wire), AND the mapped result is filtered again in JS against this same
 * Set before it ever leaves the method. A future `maintenance_request.*`
 * audit event (e.g. a status-change event added later) must be added to
 * this list EXPLICITLY before it can ever reach the page — silence is the
 * safe default, never an auto-appearing row.
 */
const TIMELINE_ALLOWED_EVENTS = [
  'maintenance_request.attachment_added',
  'maintenance_request.owner_assigned',
] as const;
const TIMELINE_ALLOWED_EVENT_SET = new Set<string>(TIMELINE_ALLOWED_EVENTS);

export type MaintenanceTimelineEventType = (typeof TIMELINE_ALLOWED_EVENTS)[number];

export interface MaintenanceTimelineEvent {
  event: MaintenanceTimelineEventType;
  createdAt: string;
  extra: Record<string, unknown>;
}

// Same fallback the rest of the app uses when building an absolute app URL
// server-side (order-requests.ts:2378/3220) — never window.location, since
// this runs in Server Actions/API routes with no browser context.
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://stockpilotusa.com';

const LIST_COLUMNS =
  'id, request_number, created_at, subject, status, priority, category, requester_user_id, requester_name_snapshot, local_owner_user_id, outlook_draft_opened_at, charter_id';

export interface MaintenanceRequestListRow {
  id: string;
  requestNumber: number;
  createdAt: string;
  subject: string;
  status: MaintenanceStatus;
  priority: MaintenancePriority;
  category: string | null;
  siteName: string | null;
  requesterName: string;
  requesterUserId: string | null;
  photoCount: number;
  draftOpened: boolean;
  localOwnerUserId: string | null;
}

export interface MaintenanceRequestDetail extends MaintenanceRequestListRow {
  description: string;
  requesterEmail: string | null;
  requesterPhone: string | null;
  charterId: string | null;
  warehouseId: string | null;
  building: string | null;
  roomOrArea: string | null;
  department: string | null;
  accessInstructions: string | null;
  relatedItemId: string | null;
  relatedOrderRequestId: string | null;
  relatedRentalId: string | null;
  relatedLocationId: string | null;
  outlookDraftOpenedAt: string | null;
  outlookDraftOpenCount: number;
  archivedAt: string | null;
  cancelledAt: string | null;
  updatedAt: string;
}

/**
 * Fields a REQUESTER may edit on their own pre-archive request. Everything
 * else (owner assignment, status flips, counters) is manage/service-only and
 * lives in dedicated methods (assignLocalOwner/archive/cancel/
 * recordDraftOpened) that never accept a client patch — RLS enforces the ROW
 * boundary (0314 maintenance_requests_update), this list enforces the FIELD
 * boundary within `update()`. Every key in maintenanceRequestFormSchema is
 * currently requester-editable pre-archive; this set exists so a FUTURE
 * schema field that should stay manage-only has somewhere to be excluded
 * from without touching the update() control flow.
 */
const REQUESTER_EDITABLE = new Set([
  'subject',
  'description',
  'category',
  'priority',
  'charterId',
  'warehouseId',
  'building',
  'roomOrArea',
  'department',
  'accessInstructions',
  'requesterPhone',
  'relatedItemId',
  'relatedOrderRequestId',
  'relatedRentalId',
  'relatedLocationId',
]);

/** camelCase form field -> snake_case column, shared by update()'s allow-list
 *  filtering and the actual patch object it builds. */
const COLUMN_FOR_FIELD: Record<string, string> = {
  subject: 'subject',
  description: 'description',
  category: 'category',
  priority: 'priority',
  charterId: 'charter_id',
  warehouseId: 'warehouse_id',
  building: 'building',
  roomOrArea: 'room_or_area',
  department: 'department',
  accessInstructions: 'access_instructions',
  requesterPhone: 'requester_phone_snapshot',
  relatedItemId: 'related_item_id',
  relatedOrderRequestId: 'related_order_request_id',
  relatedRentalId: 'related_rental_id',
  relatedLocationId: 'related_location_id',
};

/** Fix wave 1: the same four related-id fields need the same
 *  resolveRelatedId() re-derivation in update() that create() already does
 *  (Task 17 / binding constraint 2) — the PATCH route
 *  (api/v1/maintenance-requests/[id]/route.ts) forwards the body straight to
 *  update() with no re-parse, so this is the only enforcement point standing
 *  between a Bearer-token caller and a foreign-org related-record attach.
 *  Maps each camelCase field to the table resolveRelatedId() checks it
 *  against, so update()'s allow-list loop can special-case exactly these
 *  four keys without forking a second implementation of the lookup. */
const RELATED_ID_TABLE: Record<string, 'inventory_items' | 'order_requests' | 'rentals' | 'locations'> = {
  relatedItemId: 'inventory_items',
  relatedOrderRequestId: 'order_requests',
  relatedRentalId: 'rentals',
  relatedLocationId: 'locations',
};

export class MaintenanceRequestsService {
  constructor(private readonly ctx: ServiceContext) {}

  private get db() {
    return this.ctx.supabase;
  }

  private canReadAll(): boolean {
    return can(this.ctx, 'maintenance_requests:read_all') || can(this.ctx, 'maintenance_requests:manage');
  }

  /** Task 17 / binding constraint 2: re-derives a client-supplied related-
   *  record id against THIS org before it is ever attached to a request.
   *  Returns the id unchanged when a row exists in `table` with a matching
   *  `organization_id` — otherwise null. Never throws on a
   *  foreign/nonexistent id (that is the intended degrade-gracefully
   *  outcome, not an error); a genuine read failure still surfaces as
   *  internal_error, matching every other read in this file. Skips the
   *  round trip entirely when no id was supplied. */
  private async resolveRelatedId(
    table: 'inventory_items' | 'order_requests' | 'rentals' | 'locations',
    id: string | null | undefined,
  ): Promise<string | null> {
    if (!id) return null;
    const { data, error } = await this.db
      .from(table)
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    return data ? id : null;
  }

  async create(input: unknown): Promise<{ id: string; requestNumber: number; createdAt: string }> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    assertPermission(this.ctx, 'maintenance_requests:submit');

    // `.strict()` at every depth of maintenanceRequestFormSchema (packages/
    // core/src/schemas/maintenance.ts) means a client body carrying a
    // requester-identity-shaped key (requesterName, requesterEmail — neither
    // is a field on this schema) is a hard REJECTION here, before any of
    // that data could ever reach the snapshot below. requesterPhone IS a
    // real schema field: it is contact info the requester supplies, not an
    // identity claim, and there is no profile column to source it from (see
    // the snapshot comment below) — matches the order_requests.requester_phone
    // precedent (order-requests.ts's create path takes it straight from
    // client input too).
    const parsed = maintenanceRequestFormSchema.safeParse(input);
    if (!parsed.success) {
      throw new ServiceError('validation_error', parsed.error.issues[0]?.message ?? 'Please check the form.');
    }
    const v = parsed.data;

    const limit = await checkRateLimit(`maintenance:create:${this.ctx.userId}`, 20, 60 * 60 * 1000, 'closed');
    if (!limit.allowed) {
      throw new ServiceError('conflict', 'Too many maintenance requests in the last hour. Please try again later.');
    }

    // Identity snapshots come from the AUTHENTICATED PROFILE, never the
    // client body — brief §7. user_profiles has no `phone` column (0001
    // init: id/email/full_name/avatar_url/default_organization_id only), so
    // requester_phone_snapshot is the one snapshot field that legitimately
    // comes from client input (see the schema-strictness comment above).
    //
    // Task 17 / binding constraint 2: relatedItemId/relatedOrderRequestId/
    // relatedRentalId/relatedLocationId are a DEEP-LINK HINT, never
    // authority — a launch-point query string (Report a problem on an
    // item/order/rental detail page) reaches here as plain form input,
    // indistinguishable from an id the requester actually picked, and the
    // column-level FK only proves the row exists SOMEWHERE, not that it
    // belongs to THIS org. Every one of the four is re-derived against this
    // org, in parallel with the profile lookup, before it is ever
    // persisted: a foreign-org or nonexistent id degrades to null (the
    // request still saves — only that one attachment is dropped), it never
    // throws and it is never inserted verbatim. Same defense-in-depth shape
    // as assignLocalOwner's organization_members re-check (I2) below.
    const [profileRes, relatedItemId, relatedOrderRequestId, relatedRentalId, relatedLocationId] =
      await Promise.all([
        this.db.from('user_profiles').select('full_name, email').eq('id', this.ctx.userId).maybeSingle(),
        this.resolveRelatedId('inventory_items', v.relatedItemId),
        this.resolveRelatedId('order_requests', v.relatedOrderRequestId),
        this.resolveRelatedId('rentals', v.relatedRentalId),
        this.resolveRelatedId('locations', v.relatedLocationId),
      ]);
    const profile = profileRes.data;
    const fullName = (profile?.full_name as string | null | undefined)?.trim();
    const email = (profile?.email as string | null | undefined) ?? null;

    const { data: row, error } = await this.db
      .from('maintenance_requests')
      .insert({
        organization_id: this.ctx.organizationId,
        requester_user_id: this.ctx.userId,
        requester_name_snapshot: fullName || email || 'Unknown requester',
        requester_email_snapshot: email,
        requester_phone_snapshot: v.requesterPhone ?? null,
        subject: v.subject,
        description: v.description,
        category: v.category ?? null,
        priority: v.priority,
        charter_id: v.charterId ?? null,
        warehouse_id: v.warehouseId ?? null,
        building: v.building ?? null,
        room_or_area: v.roomOrArea ?? null,
        department: v.department ?? null,
        access_instructions: v.accessInstructions ?? null,
        related_item_id: relatedItemId,
        related_order_request_id: relatedOrderRequestId,
        related_rental_id: relatedRentalId,
        related_location_id: relatedLocationId,
        status: 'saved',
      })
      .select('id, request_number, created_at')
      .single();
    if (error || !row) throw new ServiceError('internal_error', error?.message ?? 'Could not save the request.');

    await audit(
      {
        event: 'maintenance_request.created',
        entityType: 'maintenance_request',
        entityId: row.id as string,
        extra: {
          request_number: row.request_number,
          priority: v.priority,
          category: v.category ?? null,
          // Reflects what was ACTUALLY attached post-org-scoping, not
          // merely what the client requested — a dropped foreign-org id
          // must never show up here as though it succeeded.
          has_related_item: Boolean(relatedItemId),
          // NEVER the description, subject, phone, or a compose URL (GC 27).
        },
      },
      this.ctx,
    );

    return {
      id: row.id as string,
      requestNumber: row.request_number as number,
      createdAt: row.created_at as string,
    };
  }

  async list(args: {
    scope: 'mine' | 'all';
    q?: string;
    status?: MaintenanceStatus | 'active';
    limit?: number;
    offset?: number;
  }): Promise<MaintenanceRequestListRow[]> {
    // NOT module-gated (0314 Q3, mirrored verbatim in the
    // maintenance_requests_select RLS policy's own comment): request
    // history stays visible after the module is disabled. Only WRITES are
    // gated — do not "restore" this call.
    if (args.scope === 'all' && !this.canReadAll()) {
      throw new ServiceError('forbidden', 'Missing permission: maintenance_requests:read_all');
    }

    const offset = args.offset ?? 0;
    let q = this.db
      .from('maintenance_requests')
      .select(`${LIST_COLUMNS}, charters!charter_id(name), maintenance_request_attachments(count)`)
      .eq('organization_id', this.ctx.organizationId)
      .order('created_at', { ascending: false })
      .range(offset, offset + Math.min(args.limit ?? 50, 100) - 1);

    if (args.scope === 'mine') q = q.eq('requester_user_id', this.ctx.userId);
    if (args.status && args.status !== 'active') q = q.eq('status', args.status);

    if (args.q?.trim()) {
      const handle = parseMaintenanceRequestNumber(args.q);
      if (handle) {
        q = q.eq('request_number', handle);
      } else {
        // Same sanitization as the inventory search (inventory.ts): strip
        // characters that would let a term escape its .or() clause and cap
        // length, rather than the narrower [%,]-only strip.
        const term = args.q.trim().slice(0, 120).replace(/[,()%*]/g, ' ');
        if (term.trim()) {
          q = q.or(`subject.ilike.%${term}%,description.ilike.%${term}%,requester_name_snapshot.ilike.%${term}%`);
        }
      }
    }

    const { data, error } = await q;
    if (error) throw new ServiceError('internal_error', error.message);

    let rows = (data ?? []) as Record<string, unknown>[];
    // 'active' excludes archived/cancelled JS-SIDE — never PostgREST
    // not.in, which silently drops NULL rows (recurring pattern #23).
    if (args.status === 'active') {
      rows = rows.filter((r) => r.status === 'saved' || r.status === 'draft_opened');
    }
    return rows.map((r) => this.toListRow(r));
  }

  private toListRow(r: Record<string, unknown>): MaintenanceRequestListRow {
    const charter = r.charters as { name?: string } | null;
    const att = r.maintenance_request_attachments as { count?: number }[] | null;
    return {
      id: r.id as string,
      requestNumber: r.request_number as number,
      createdAt: r.created_at as string,
      subject: r.subject as string,
      status: r.status as MaintenanceStatus,
      priority: r.priority as MaintenancePriority,
      category: (r.category as string | null) ?? null,
      siteName: charter?.name ?? null,
      requesterName: r.requester_name_snapshot as string,
      requesterUserId: (r.requester_user_id as string | null) ?? null,
      photoCount: att?.[0]?.count ?? 0,
      draftOpened: Boolean(r.outlook_draft_opened_at),
      localOwnerUserId: (r.local_owner_user_id as string | null) ?? null,
    };
  }

  async get(id: string): Promise<MaintenanceRequestDetail> {
    // NOT module-gated (0314 Q3) — same reasoning as list(): history reads
    // survive a module disable. update()/cancel()/recordDraftOpened() all
    // call this internally but each carries its OWN assertModuleEnabled at
    // the top of the write method, so every write path is still gated —
    // do not "restore" this call.
    const { data: r, error } = await this.db
      .from('maintenance_requests')
      .select('*, charters!charter_id(name), maintenance_request_attachments(count)')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!r) throw new ServiceError('not_found', 'Maintenance request not found');

    const row = r as Record<string, unknown>;
    // I1: zero-query defense in depth. RLS (0314 maintenance_requests_select)
    // already scopes this SELECT to requester-own OR read_all OR manage —
    // the row is in hand, so assert the SAME boundary here rather than
    // trusting RLS as the only enforcement layer. not_found, never
    // forbidden: an unauthorized caller must not learn a foreign request
    // even exists. Every write method below routes through get() first, so
    // this closes the same hole for update()/cancel()/recordDraftOpened()/
    // emailInput() too — each still layers its OWN manage-vs-requester
    // decision on top for the narrower "can VIEW but not EDIT" case (e.g. a
    // read_all holder who isn't the requester and isn't a manage-holder).
    if (!this.canReadAll() && (row.requester_user_id as string | null) !== this.ctx.userId) {
      throw new ServiceError('not_found', 'Maintenance request not found');
    }
    const base = this.toListRow(row);
    return {
      ...base,
      description: row.description as string,
      requesterEmail: (row.requester_email_snapshot as string | null) ?? null,
      requesterPhone: (row.requester_phone_snapshot as string | null) ?? null,
      charterId: (row.charter_id as string | null) ?? null,
      warehouseId: (row.warehouse_id as string | null) ?? null,
      building: (row.building as string | null) ?? null,
      roomOrArea: (row.room_or_area as string | null) ?? null,
      department: (row.department as string | null) ?? null,
      accessInstructions: (row.access_instructions as string | null) ?? null,
      relatedItemId: (row.related_item_id as string | null) ?? null,
      relatedOrderRequestId: (row.related_order_request_id as string | null) ?? null,
      relatedRentalId: (row.related_rental_id as string | null) ?? null,
      relatedLocationId: (row.related_location_id as string | null) ?? null,
      outlookDraftOpenedAt: (row.outlook_draft_opened_at as string | null) ?? null,
      outlookDraftOpenCount: (row.outlook_draft_open_count as number) ?? 0,
      archivedAt: (row.archived_at as string | null) ?? null,
      cancelledAt: (row.cancelled_at as string | null) ?? null,
      updatedAt: row.updated_at as string,
    };
  }

  async update(id: string, patch: unknown): Promise<void> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    const detail = await this.get(id);
    const isManager = can(this.ctx, 'maintenance_requests:manage');
    const isRequester = detail.requesterUserId === this.ctx.userId;
    if (!isManager && !isRequester) throw new ServiceError('forbidden', 'Not your request.');
    if (!isManager && (detail.archivedAt || detail.cancelledAt)) {
      throw new ServiceError('conflict', 'This request is closed and can no longer be edited.');
    }

    const parsed = maintenanceRequestFormSchema.partial().safeParse(patch);
    if (!parsed.success) {
      throw new ServiceError('validation_error', parsed.error.issues[0]?.message ?? 'Please check the form.');
    }
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    // Fix wave 1: related-id fields are collected separately rather than
    // written straight into `updates` like every other field below — each
    // one still needs the SAME org re-derivation create() already applies
    // (Task 17 / binding constraint 2) before it can be trusted. A patched
    // relatedItemId/relatedOrderRequestId/relatedRentalId/relatedLocationId
    // is exactly as untrustworthy as one supplied at create time: the
    // column's FK only proves the row exists SOMEWHERE, never that it
    // belongs to THIS org, and the PATCH route forwards this body with no
    // re-parse of its own.
    const pendingRelatedIds: { key: string; table: (typeof RELATED_ID_TABLE)[string]; value: unknown }[] = [];
    for (const [key, value] of Object.entries(parsed.data as Record<string, unknown>)) {
      if (value === undefined) continue;
      if (!isManager && !REQUESTER_EDITABLE.has(key)) continue;
      const col = COLUMN_FOR_FIELD[key];
      if (!col) continue;
      const relatedTable = RELATED_ID_TABLE[key];
      if (relatedTable) {
        pendingRelatedIds.push({ key, table: relatedTable, value });
        continue;
      }
      updates[col] = value ?? null;
    }
    if (pendingRelatedIds.length > 0) {
      // Reuses resolveRelatedId() verbatim — the same helper create() calls
      // — rather than forking a second lookup implementation. A foreign-org
      // or nonexistent id degrades to null (no throw, the rest of the patch
      // still applies); only a genuine read failure surfaces as
      // internal_error, matching resolveRelatedId's own contract.
      const resolved = await Promise.all(
        pendingRelatedIds.map(({ table, value }) => this.resolveRelatedId(table, value as string | null)),
      );
      pendingRelatedIds.forEach(({ key }, i) => {
        updates[COLUMN_FOR_FIELD[key]!] = resolved[i];
      });
    }

    const { data, error } = await this.db
      .from('maintenance_requests')
      .update(updates)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    // C2: fail CLOSED, not open. get() above already confirmed this id
    // exists, is in-org, and is readable/editable by this caller — so a
    // zero-row result here means RLS refused the WRITE itself (the row's
    // archived_at/cancelled_at flipped between that read and this write, or
    // a permission changed mid-request). That is a state-changed conflict,
    // not a missing/foreign row — get() already ruled the latter out.
    if (!data) {
      throw new ServiceError(
        'conflict',
        'This request changed state and can no longer be edited this way. Reload and try again.',
      );
    }

    await audit(
      {
        event: 'maintenance_request.updated',
        entityType: 'maintenance_request',
        entityId: id,
        extra: { changed_keys: Object.keys(updates).filter((k) => k !== 'updated_at') },
      },
      this.ctx,
    );
  }

  /** manage-only. Sets status + archived_at TOGETHER, in one write — the DB
   *  has no lockstep trigger by design (plan C1), so this service owns
   *  keeping the two consistent on every transition. */
  async archive(id: string): Promise<void> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    assertPermission(this.ctx, 'maintenance_requests:manage');

    // M1: refuse archiving an already-CANCELLED request rather than
    // silently ending up with BOTH archived_at and cancelled_at set on the
    // same row — two closed-state timestamps on one request is a history
    // nothing downstream can make sense of. Narrow pre-read (status column
    // only), same shape as cycle-counts.ts's assign() header check —
    // archive() had NO existence check at all before this fix, so a
    // missing row here is genuinely not_found, not a race.
    const { data: header, error: hErr } = await this.db
      .from('maintenance_requests')
      .select('cancelled_at')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (hErr) throw new ServiceError('internal_error', hErr.message);
    if (!header) throw new ServiceError('not_found', 'Maintenance request not found.');
    if ((header as { cancelled_at: string | null }).cancelled_at) {
      throw new ServiceError('conflict', 'This request is cancelled and cannot be archived.');
    }

    const now = new Date().toISOString();
    const { data, error } = await this.db
      .from('maintenance_requests')
      .update({ status: 'archived', archived_at: now, updated_at: now })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    // C2: the pre-read above already confirmed the row exists — a zero-row
    // result here means it changed state (or the module got disabled)
    // between that read and this write. Conflict, not not_found: the row
    // is still there, just no longer writable the way this caller expects.
    if (!data) {
      throw new ServiceError(
        'conflict',
        'This request changed state and can no longer be archived this way. Reload and try again.',
      );
    }
    await audit({ event: 'maintenance_request.archived', entityType: 'maintenance_request', entityId: id }, this.ctx);
  }

  /** Requester's OWN pre-archive request, or manage. Same lockstep
   *  discipline as archive(): status + cancelled_at in one write. */
  async cancel(id: string): Promise<void> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    const detail = await this.get(id);
    const isManager = can(this.ctx, 'maintenance_requests:manage');
    if (!isManager && detail.requesterUserId !== this.ctx.userId) {
      throw new ServiceError('forbidden', 'Not your request.');
    }
    if (detail.archivedAt) throw new ServiceError('conflict', 'This request is archived.');
    const now = new Date().toISOString();
    const { data, error } = await this.db
      .from('maintenance_requests')
      .update({ status: 'cancelled', cancelled_at: now, updated_at: now })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    // C2: get() above already confirmed existence and the archivedAt check
    // just passed — a zero-row result here means the row's state moved
    // between that read and this write (e.g. someone else archived it, or
    // a repeat cancel raced itself). Conflict, not not_found.
    if (!data) {
      throw new ServiceError(
        'conflict',
        'This request changed state and can no longer be cancelled this way. Reload and try again.',
      );
    }
    await audit({ event: 'maintenance_request.cancelled', entityType: 'maintenance_request', entityId: id }, this.ctx);
  }

  /** manage-only. "Local owner" is a StockPilot coordinator, never a
   *  Zendesk assignee (permissions.ts doc comment). */
  async assignLocalOwner(id: string, userId: string | null): Promise<void> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    assertPermission(this.ctx, 'maintenance_requests:manage');

    if (userId !== null) {
      // I2: uuid-shape validation FIRST — the column's only constraint is a
      // FK to auth.users(id), so without this a garbage string reaches
      // Postgres and comes back as an opaque 22P02 internal_error instead
      // of a clear, actionable validation_error.
      if (!uuidSchema.safeParse(userId).success) {
        throw new ServiceError('validation_error', 'That is not a valid user id.');
      }
      // I2: cross-org tampering check, same shape as cycle-counts.ts's
      // assign(). The FK is to auth.users, NOT organization_members, so
      // without this a foreign-org uuid the caller happens to know is a
      // perfectly valid write — it would silently route the request (and
      // the "assigned to you" notification + detail-page display) to
      // someone outside this organization entirely.
      const { data: member, error: mErr } = await this.db
        .from('organization_members')
        .select('id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('user_id', userId)
        .not('accepted_at', 'is', null)
        .maybeSingle();
      if (mErr) throw new ServiceError('internal_error', mErr.message);
      if (!member) {
        throw new ServiceError('validation_error', 'That user is not an active member of this organization.');
      }
    }

    const { data, error } = await this.db
      .from('maintenance_requests')
      .update({ local_owner_user_id: userId, updated_at: new Date().toISOString() })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    // C2: assignLocalOwner() never pre-reads the row (unlike update()/
    // cancel()/recordDraftOpened(), which route through get() first) — a
    // zero-row result here is the FIRST and only existence signal this
    // method gets, so a stale/foreign id reads as not_found, not conflict.
    if (!data) throw new ServiceError('not_found', 'Maintenance request not found.');
    await audit(
      {
        event: 'maintenance_request.owner_assigned',
        entityType: 'maintenance_request',
        entityId: id,
        extra: { local_owner_user_id: userId },
      },
      this.ctx,
    );
  }

  /** manage-only internal note — NEVER visible to the requester, NEVER
   *  synced anywhere (0314: notes RLS is manage-only in both directions). */
  async addNote(id: string, body: string): Promise<{ id: string }> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    assertPermission(this.ctx, 'maintenance_requests:manage');
    const text = body.trim();
    if (!text || text.length > 4000) {
      throw new ServiceError('validation_error', 'Notes must be 1 to 4,000 characters.');
    }

    // M3: confirm the parent exists in THIS org before inserting. Without
    // this, a foreign/stale id trips the notes INSERT RLS policy's `exists
    // (... maintenance_requests r ...)` check and comes back as an opaque
    // internal_error instead of a clear not_found — narrow read, same shape
    // as archive()'s pre-check above.
    const { data: parent, error: pErr } = await this.db
      .from('maintenance_requests')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (pErr) throw new ServiceError('internal_error', pErr.message);
    if (!parent) throw new ServiceError('not_found', 'Maintenance request not found.');

    const { data, error } = await this.db
      .from('maintenance_request_notes')
      .insert({
        organization_id: this.ctx.organizationId,
        maintenance_request_id: id,
        author_user_id: this.ctx.userId,
        body: text,
      })
      .select('id')
      .single();
    if (error || !data) throw new ServiceError('internal_error', error?.message ?? 'Could not add the note.');
    await audit({ event: 'maintenance_request.note_added', entityType: 'maintenance_request', entityId: id }, this.ctx);
    return { id: data.id as string };
  }

  async listNotes(
    id: string,
  ): Promise<{ id: string; authorUserId: string | null; body: string; createdAt: string }[]> {
    // NOT module-gated (0314 Q3): notes are part of request history, and a
    // manage-holder still needs to read them (triage, wind-down) after a
    // disable. The manage permission check below is untouched — do not
    // "restore" the module gate here.
    assertPermission(this.ctx, 'maintenance_requests:manage');
    const { data, error } = await this.db
      .from('maintenance_request_notes')
      .select('id, author_user_id, body, created_at')
      .eq('organization_id', this.ctx.organizationId)
      .eq('maintenance_request_id', id)
      .order('created_at', { ascending: true })
      // M4: an internal notes thread has no pagination UI — cap it so a
      // pathological request can't pull an unbounded row set.
      .limit(500);
    if (error) throw new ServiceError('internal_error', error.message);
    return ((data ?? []) as Record<string, unknown>[]).map((n) => ({
      id: n.id as string,
      authorUserId: (n.author_user_id as string | null) ?? null,
      body: n.body as string,
      createdAt: n.created_at as string,
    }));
  }

  /** Records that a DRAFT WAS OPENED. Nothing more is knowable (brief §20/
   *  21) — StockPilot cannot observe Send, delivery, or Zendesk ticket
   *  creation. The first-open timestamp is sticky; only the count moves on
   *  a re-open. */
  async recordDraftOpened(id: string): Promise<{ openCount: number }> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    const detail = await this.get(id);

    // C1: get() only decided whether this caller may VIEW the row (owner OR
    // read_all/manage — I1). Recording a draft-open is a WRITE, and 0314's
    // UPDATE policy is narrower than that: the requester may write ONLY
    // while archived_at/cancelled_at are both null, and a plain read_all
    // holder who is neither the requester nor a manage-holder has no write
    // path at all. Without this explicit decision, that combination
    // reached the .update() below, RLS matched 0 rows, `error` came back
    // null (a no-op UPDATE is not a Postgres error), and the method
    // returned an openCount that was never persisted while audit()
    // recorded a draft_opened event for a mutation that never happened.
    const isManager = can(this.ctx, 'maintenance_requests:manage');
    if (!isManager && detail.requesterUserId !== this.ctx.userId) {
      throw new ServiceError('forbidden', 'Not your request.');
    }
    // C1: closed-state guard mirroring RLS's `using` clause — the
    // requester's own write path there requires archived_at IS NULL AND
    // cancelled_at IS NULL; manage/manager bypasses it entirely, same as
    // update()'s identical guard.
    if (!isManager && (detail.archivedAt || detail.cancelledAt)) {
      throw new ServiceError('conflict', 'This request is closed and can no longer be edited.');
    }

    const openCount = detail.outlookDraftOpenCount + 1;
    const now = new Date().toISOString();
    const { data, error } = await this.db
      .from('maintenance_requests')
      .update({
        outlook_draft_opened_at: detail.outlookDraftOpenedAt ?? now,
        outlook_draft_open_count: openCount,
        status: detail.status === 'saved' ? 'draft_opened' : detail.status,
        updated_at: now,
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    // C2: the checks above already confirmed existence + writability — a
    // zero-row result here means state moved between that read and this
    // write. Conflict, not not_found. Audit only fires AFTER this guard, so
    // a phantom mutation is never recorded as though it happened.
    if (!data) {
      throw new ServiceError(
        'conflict',
        'This request changed state and can no longer be edited this way. Reload and try again.',
      );
    }
    await audit(
      {
        event: 'maintenance_request.draft_opened',
        entityType: 'maintenance_request',
        entityId: id,
        extra: { open_count: openCount },
      },
      this.ctx,
    );
    return { openCount };
  }

  /** Assembles the pure-builder input SERVER-side: related-record facts are
   *  snapshotted from the database (never client payloads), and record URLs
   *  use the APP_URL convention (never window.location — there is no window
   *  here). Read-only: never writes, never audits.
   *
   *  NOT module-gated (0314 Q3, by extension of get()): this only renders
   *  text off data get() already exposes post-disable, and the requester
   *  could copy the same content straight off the detail page — gating the
   *  render would just be theater on top of an already-readable read. Do
   *  not add an assertModuleEnabled call here. */
  async emailInput(id: string, opts: { shareUrl: string | null }): Promise<MaintenanceEmailInput> {
    const detail = await this.get(id);
    const requestNumber =
      formatMaintenanceRequestNumber(detail.requestNumber, detail.createdAt) ?? String(detail.requestNumber);

    let relatedItem: MaintenanceEmailInput['relatedItem'] = null;
    if (detail.relatedItemId) {
      // Master brief §8's item field list — name/SKU/barcode/model number/
      // warehouse/location/link, deliberately NO asset tag (audit Q6: no
      // `asset_tag` column exists anywhere). Warehouse/location are two
      // hops out: item -> primary_location_id -> locations row ->
      // warehouse_id -> warehouses row. Same 2-hop embed shape the
      // relatedRental block below already uses successfully
      // (rentals -> rental_lines -> inventory_items) — cast through
      // `unknown` first for the same reason (Database=any makes
      // supabase-js infer a structurally different, incompatible shape for
      // a nested embed than the real PostgREST response).
      const { data: item } = await this.db
        .from('inventory_items')
        .select('id, name, sku, barcode, model_number, locations!primary_location_id(name, warehouses!warehouse_id(name))')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', detail.relatedItemId)
        .maybeSingle();
      if (item) {
        const loc =
          (item.locations as unknown as { name: string; warehouses: { name: string } | null } | null) ?? null;
        relatedItem = {
          name: item.name as string,
          sku: (item.sku as string | null) ?? null,
          barcode: (item.barcode as string | null) ?? null,
          modelNumber: (item.model_number as string | null) ?? null,
          warehouseName: loc?.warehouses?.name ?? null,
          locationName: loc?.name ?? null,
          url: `${APP_URL}/dashboard/inventory/${item.id}`,
        };
      }
    }

    let relatedOrder: MaintenanceEmailInput['relatedOrder'] = null;
    if (detail.relatedOrderRequestId) {
      // order_requests has no `requested_for` column (0044_order_requests.sql
      // defines requester_name/requester_email/requester_user_id) — the
      // brief's sketch named the wrong column; requester_name is the real
      // "who this order is for" field or-requests.ts reads elsewhere.
      const { data: order } = await this.db
        .from('order_requests')
        .select('id, order_number, requester_name')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', detail.relatedOrderRequestId)
        .maybeSingle();
      if (order) {
        relatedOrder = {
          handle: formatOrderNumber(order.order_number as number | null) ?? (order.id as string).slice(0, 8).toUpperCase(),
          requestedFor: (order.requester_name as string | null) ?? null,
          url: `${APP_URL}/dashboard/orders/${order.id}`,
        };
      }
    }

    let relatedRental: MaintenanceEmailInput['relatedRental'] = null;
    if (detail.relatedRentalId) {
      // 0131_rentals.sql: rental line items live in `rental_lines`
      // (rental_id, item_id, quantity), NOT `rental_items` — the brief's
      // sketch used the wrong table name. borrower_name IS a real, always-
      // populated column on `rentals` itself (0131:40-41), so no embed is
      // needed for that half.
      const { data: rental } = await this.db
        .from('rentals')
        .select('id, borrower_name, rental_lines(inventory_items(name))')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', detail.relatedRentalId)
        .maybeSingle();
      if (rental) {
        // Cast through `unknown` first: with Database=any, supabase-js's
        // select-string parser infers a structurally different (and
        // incompatible) shape for a nested embed than the real PostgREST
        // response, so a direct `as` is rejected as a "may be a mistake"
        // conversion — same reason every other row in this file is cast
        // via `Record<string, unknown>` rather than trusting inference.
        const lines =
          (rental.rental_lines as unknown as { inventory_items: { name: string } | null }[] | null) ?? [];
        const items = lines.map((l) => l.inventory_items?.name).filter((n): n is string => Boolean(n));
        relatedRental = {
          itemNames: items,
          borrowerName: (rental.borrower_name as string | null) ?? null,
          url: `${APP_URL}/dashboard/rentals/${rental.id}`,
        };
      }
    }

    // Org timezone display for the Submitted line. Read via ctx.supabase
    // (user-authed, RLS-scoped to the caller's own org) rather than the
    // admin-client-backed getCachedOrgTimezone() dashboard-layout helper —
    // a service has no reason to escalate for a column any org member can
    // already read about their own org.
    const { data: org } = await this.db
      .from('organizations')
      .select('timezone')
      .eq('id', this.ctx.organizationId)
      .maybeSingle();
    const tz = (org?.timezone as string | null) || ORG_TIMEZONE_DEFAULT;
    const submittedAtDisplay = formatOrgDateTime(detail.createdAt, { dateStyle: 'long', timeStyle: 'short' }, tz);

    return {
      requestNumber,
      subject: detail.subject,
      description: detail.description,
      category: detail.category,
      priority: detail.priority,
      submittedAtDisplay,
      requesterName: detail.requesterName,
      requesterEmail: detail.requesterEmail,
      requesterPhone: detail.requesterPhone,
      siteName: detail.siteName,
      department: detail.department,
      building: detail.building,
      roomOrArea: detail.roomOrArea,
      accessInstructions: detail.accessInstructions,
      relatedItem,
      relatedOrder,
      relatedRental,
      photoCount: detail.photoCount,
      shareUrl: opts.shareUrl,
    };
  }

  /**
   * Real, per-event rows for the detail page's "StockPilot activity"
   * timeline (fix wave Important 1) — the same precedent
   * components/orders/order-timeline.tsx already established for orders,
   * adapted for maintenance's distinct audit-read permission boundary (see
   * the TIMELINE_ALLOWED_EVENTS doc comment above this class).
   *
   * `this.get(id)` re-derives get()'s OWN view boundary (requester-own OR
   * read_all OR manage) FIRST, on the RLS-scoped `ctx.supabase` client —
   * exactly mirroring emailInput()'s own shape. If this caller cannot view
   * the request at all, get() throws not_found and the admin client below
   * is never even constructed, let alone queried: a viewer who cannot see
   * the request never reaches the audit read.
   *
   * NOT module-gated (0314 Q3, by extension of get()): this only surfaces
   * history off rows get() already exposes post-disable.
   */
  async listTimelineEvents(id: string): Promise<MaintenanceTimelineEvent[]> {
    await this.get(id);

    const admin = createAdminClient();
    const { data, error } = await admin
      .from('audit_logs')
      .select('event, created_at, metadata')
      .eq('organization_id', this.ctx.organizationId)
      .filter('metadata->>entity_id', 'eq', id)
      .in('event', TIMELINE_ALLOWED_EVENTS)
      .order('created_at', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);

    return ((data ?? []) as Record<string, unknown>[])
      .map((r) => ({
        event: r.event as string,
        createdAt: r.created_at as string,
        extra: (r.metadata as Record<string, unknown> | null) ?? {},
      }))
      // JS-side re-filter (suspenders to the query's `.in()` belt): never
      // trust a query-shape guard alone to be the ONLY thing standing
      // between an unlisted event and the page — same defensive-redundancy
      // posture maintenance-attachments.ts's validateFinalizePath uses.
      .filter((r): r is MaintenanceTimelineEvent => TIMELINE_ALLOWED_EVENT_SET.has(r.event));
  }
}
