# Maintenance Requests — Engineering Report and Ship Checklist

Branch `feat/maintenance-requests`, HEAD `6075016d` at the time this report was
written (clean working tree, verified via `git status` before any of this
document was drafted). Program duration: 2026-08-05 to 2026-08-06, 26 tasks
across seven phases (A: module/permission foundation; B: shared email
transport + maintenance email builder; C: server foundation — service, audit,
attachments, share links, API routes; D: web UI — list, form, review, detail,
settings, launch points; E: mobile — registration, list, form, detail; F:
notifications + onboarding; G: verification — full gate, honesty sweeps,
manual authed browser walk, this report). Every task went through an
adversarial opus review before being marked complete; nine of them (Tasks 1,
9, 10, 12, 14, 17, 18, 23, 25) surfaced a real defect the review or the walk
caught and a fix wave closed — the review catch-list is summarized under
"Follow-ups and open items" below.

This is a documentation task: no source file was modified while writing it.

---

## 1. Repository inspection — systems reused

The brief required inspecting the codebase before writing anything new and
reusing generic infrastructure rather than forking it. What was actually
found and reused:

- **Outlook compose mechanics.** The order-delivery-request assistant already
  had a tenant-verified Outlook Web compose pipeline in
  `apps/web/src/components/orders/storefront/storefront-logic.ts` (functions
  `buildOutlookComposeUrl` / `buildMailtoUrl` / `buildClipboardText`, roughly
  lines 421-537 and 577-789 of that file). The mechanics — `outlook.cloud.microsoft`
  (never `outlook.office.com`, which drops the compose path on this tenant's
  Microsoft 365 domain-migration redirect), a single `mailtouri=` parameter
  (plain `cc=` is silently dropped by OWA), and `%20` encoding via a private
  `encodeDraftQuery` (URLSearchParams' `+` has no space meaning in RFC 6068
  mailto clients) — were extracted **verbatim**, not reimplemented, into a new
  generic transport: `packages/core/src/email/outlook-compose.ts`
  (`composeOutlookWebUrl` / `composeMailtoUrl` / `composeClipboardText` /
  `createOutlookComposeEmail`, `OUTLOOK_COMPOSE_BASE`, `DRAFT_URL_LIMIT = 1800`).
  Byte-for-byte equivalence against the original was proven with a 13-case
  dual-import comparison script (unicode, `&`, `+`, apostrophes, long bodies,
  CRLF/LF mixes, empty strings, special characters) before the delivery
  component itself was rewired to delegate to the shared module — the
  four historical delivery-request test suites (120 + 50 + 10 + 14 = 194
  tests) still pass unmodified today.
- **Recipient constants.** `DELIVERY_REQUEST_EMAIL` /
  `DELIVERY_REQUEST_EMAIL_NAMES` in `apps/web/src/lib/site.ts:48-51` and `85-88`
  were the pattern for frozen, compile-time-literal recipients that no
  parameter can override. The maintenance equivalents,
  `L4L_MAINTENANCE_EMAIL` / `L4L_MAINTENANCE_EMAIL_NAMES`, live in
  `packages/core/src/maintenance/constants.ts:14-24` and follow the same
  shape and the same security rationale, copied into the doc comment.
- **Human-readable numbering.** Migration `0254`'s advisory-lock counter
  pattern (an org-scoped `pg_advisory_xact_lock` plus `max()+1`, security
  definer so a requester-scoped lookup can't re-issue a number another
  requester already claimed) was cloned for `assign_maintenance_request_number()`
  in migration `0314` (lines 146-168 below).
- **Storage bucket + RLS conventions.** The org-prefix private-bucket pattern
  from `0142`/`0143` (order-attachments) and `0260` (support-attachments,
  insert-only, no select policy) was reused for the new `maintenance-photos`
  bucket (migration `0315`); the inline disabled-account guard is the `0312`
  pattern (its RPC has EXECUTE revoked from `authenticated`, so only the
  inlined `not exists` form works inside a storage policy).
- **Share-link tokens.** Migration `0261`'s 64-hex CSPRNG token pattern was
  reused for `maintenance_request_share_links` (Task 10), including its
  entropy and its revocable/expiring shape.
- **Permission system.** No new permission mechanism — the four new
  permissions (`maintenance_requests:submit` / `:read_all` / `:manage` /
  `:configure`) are ordinary rows in `role_default_permissions` plus entries
  in `packages/core/src/constants/permissions.ts` (grouped under `'Maintenance'`,
  lines 651-669), which is what makes them appear automatically in the
  existing per-user override UI at `/dashboard/settings/roles` with zero new
  UI code.
- **Module registry.** The existing `organization_modules` system
  (`packages/core/src/modules/registry.ts`) gained one row,
  `maintenance_requests` (optional tier, off by default), following the exact
  pattern of the most recent module addition (`sports`, migration `0297`) —
  the new-org seed function in `0314` is a byte-faithful copy of `0297`'s body
  with one row appended, not a hand-edited rewrite.
- **Notification system.** `apps/web/src/server/services/maintenance-notify.ts`
  reuses the existing effective-permissions computation (the same batched
  role/user-override load `loadEffectivePermissions` uses) to compute
  audience, and fires through the same push pipeline everything else in the
  product uses — migration `0028`'s AFTER-INSERT trigger is still the only
  path from a `notifications` row to a device push; nothing new was built
  there.
- **Audit logging.** `apps/web/src/server/services/audit.ts`'s existing
  `audit()` helper is called from every mutating service method
  (`maintenance_request.created`, `.updated`, `.archived`, `.cancelled`,
  `.draft_opened`, `.owner_assigned`, `.note_added`, `.settings_updated`,
  `.share_link_created`, `.share_link_revoked`) — no parallel audit path.
- **Image handling.** HEIC-to-JPEG/WebP transcoding on web reuses `heic2any`
  (already a dependency, used elsewhere for item images); mobile forces JPEG
  output from `expo-image-manipulator`, already compiled into the shipped
  1.1.0 binary. Magic-byte sniffing (`apps/web/src/lib/image-signature.ts`)
  mirrors the PNG/JPEG signature logic already living in
  `inventory-export-xlsx.ts:58-95`, extended with a full 8-byte PNG signature
  check, an `IHDR` tag check, a dimension range guard, and a real WEBP
  RIFF/WAVE-fourcc check — none of that existed anywhere in the repo before
  this program (see §29 Security and Privacy below: this closed a real gap
  the pre-existing export helper did not need to care about).
- **Types.** No duplicate profile, organization, site, or item types were
  created — the service reads the same `ChartersService`, `order_requests`,
  `inventory_items`, `rentals`, and `locations` tables the rest of the product
  already models, joining rather than re-declaring.

## 2. User workflow

1. An employee with `maintenance_requests:submit` opens **Maintenance
   Requests** in StockPilot (web `/dashboard/maintenance`, mobile
   `/maintenance`), or launches the flow from a **Report a problem** button on
   an item, book, rental, or order detail page, or from the mobile
   barcode-scanner result — each launch point prefills the relevant
   relationship.
2. They enter a subject and description, pick their site (defaulted from
   their profile where known), optionally add building/room/department/access
   notes, a category and priority, and optionally attach up to 8 photos
   (JPEG/PNG/HEIC on web, JPEG/PNG on mobile — HEIC is transcoded client-side
   before it ever reaches the server).
3. Saving creates the request server-side (validated, permission-checked,
   module-gated), mints a human-readable request number (`MR-2026-000123`),
   uploads and finalizes any photos, and redirects to a **Review** screen.
4. The review screen shows everything that will go into the email — To, CC,
   subject, body — and states plainly: "Your request has been saved in
   StockPilot. Outlook will open with the email details filled in, but the
   email will not be sent automatically."
5. The employee clicks **Open in Outlook**. A new tab opens with a fully
   prefilled Outlook Web compose window (To `dc4@learn4life.org`, CC
   `arosas@cvwest.org`, subject, body). StockPilot records that a draft was
   opened; it does not and cannot know whether the employee actually presses
   Send.
6. The employee reviews the draft, optionally downloads and attaches the
   photos (Outlook compose links cannot pre-attach files), and clicks Send
   themselves.
7. Sending to `dc4@learn4life.org` creates the Zendesk ticket through the
   org's existing Zendesk email intake. Andrew's CC gives him a copy.
8. All further conversation happens in the Outlook/Zendesk email thread — not
   inside StockPilot.

## 3. Zendesk boundary

StockPilot's involvement ends at the drafted email. It never calls a Zendesk
API, never receives a webhook, and never learns whether Send was clicked,
what the ticket number is, what its status is, or what anyone commented. This
is not a scope gap that a future task will silently paper over — it is the
explicit shape of this phase, enforced at multiple levels:

- **No executable Zendesk surface exists.** A repository-wide grep for
  `zendesk` (case-insensitive) across every maintenance-requests source path
  during Task 24's gate run returned 39 hits; every one is a doc comment, a
  disclosure string rendered to a user, or a test's own banned-vocabulary
  literal array. Zero are an API call, an import, or a network reference.
  (Full breakdown is in the committed verification log,
  `docs/superpowers/reports/2026-08-05-maintenance-requests-verification.md`,
  "Zendesk grep" section.)
- **The status vocabulary is honest by construction.** The only states
  StockPilot ever records are `Saved`, `Email draft opened`, `Archived`, and
  `Cancelled` (`MAINTENANCE_STATUS_LABELS`,
  `packages/core/src/maintenance/constants.ts:52-57`). A repo-wide forbidden-phrase
  sweep (`Ticket created`, `Request submitted to Zendesk`, `DC4 notified`,
  `Andrew notified`, `Ticket assigned`, `Email sent`) returns zero matches in
  production source; the only hits anywhere are inside the sweep tests' own
  banned-word arrays, which have to spell the phrase to assert it never
  renders.
- **The email body itself tells the employee this**, in the drafted text sent
  to DC4: "Please reply to this email thread for updates so the responses
  remain attached to the same Zendesk ticket" (§20/§16 truth summary below has
  the exact wording). The detail page and the mobile detail screen both carry
  an explicit disclosure ("Ticket replies happen in the Outlook/Zendesk email
  conversation and are not shown here").
- **Replying keeps the update on the same ticket** because the org's Zendesk
  email-channel configuration threads by the email conversation, not by
  anything StockPilot controls — StockPilot's only job is producing a correct
  first message; the org's own Zendesk setup does the rest.

### §16/§20 truth summary — what the email actually says and does

- StockPilot **prepares** the email; the user **sends** it. No code path
  anywhere calls `window.open` or navigates a `mailto:` URL without a direct
  click from the reviewing employee, and nothing StockPilot does constitutes
  sending.
- The compose transport is `outlook.cloud.microsoft/mail/deeplink/compose`
  with a single `mailtouri=` parameter (never separate `to=`/`cc=`/`subject=`/
  `body=` params, which OWA on this tenant silently mishandles), `%20`-based
  encoding (not `URLSearchParams`'s `+`), and `DRAFT_URL_LIMIT = 1800`
  characters as the hard ceiling both the Outlook URL and the mailto fallback
  are measured against.
- The full §15-style body (greeting, every optional section, sign-off)
  measures 2,553-2,612 encoded characters against that 1,800 limit — no
  encoding format rescues the maximal case. The shipped body drops the
  greeting/instruction/sign-off wrapper (saving 237 characters) and uses a
  denser but information-equivalent sectioning; every §15 data-bearing item
  (request number, issue, category, priority, submitted time, requester,
  site, location, description, related record, photos, access instructions,
  reply-thread sentence, footer) is still present in full.
- **Photo-bearing requests are the norm, not the exception, for condensing.**
  The photos block itself costs 334 Outlook-encoded characters; with a photo
  present the description budget before the body must condense drops to
  roughly 63 characters. The review screen surfaces this honestly — when the
  body needed to condense, an on-page note says so, and the **Copy Email
  Details** fallback always contains the full, uncondensed body regardless of
  what fit in the Outlook URL.
- If neither the Outlook URL nor the mailto URL fits even condensed
  (`linkFits = false`), the code refuses to open anything and directs the
  employee to Copy Email Details instead — it never truncates a URL and opens
  a broken draft.

## 4. Photo behavior

- **Storage.** Photos live in a private Supabase Storage bucket,
  `maintenance-photos` (migration `0315`), capped at 10 MB per file,
  restricted to `image/png` / `image/jpeg` / `image/webp` at the bucket
  level. There is no select/update/delete policy on the bucket at all — every
  read is a short-lived signed URL minted server-side, after the caller has
  already passed an RLS-visible check on the parent request.
- **Path scheme.** `{organization_id}/{maintenance_request_id}/{uuid}.{ext}`
  for the master image and `{uuid}-thumb.webp` for its thumbnail. The thumb
  path is **server-derived**, never accepted from the client, after a review
  finding that a client-supplied thumb path could otherwise be pointed at a
  sibling's master object.
- **Magic-byte verification.** The declared Content-Type at upload time is
  never trusted alone. At finalize, `apps/web/src/lib/image-signature.ts`
  reads the actual bytes: full 8-byte PNG signature plus `IHDR` tag plus a
  bounded dimension range, a hardened WEBP check requiring the real RIFF/WAVE
  fourcc (an earlier draft accepted any RIFF container), and a JPEG check
  that correctly skips legal `0xFF` fill-byte runs instead of misreading them
  as corruption. A file whose bytes don't match its declared kind is rejected
  and the uploaded object is deleted.
- **Path-traversal defense.** Finalize validates the storage path against a
  strict shape regex (uuid filename + allowed extension, no `.` segments, no
  `%`) before any storage call — this closed a real, proven exploit (see
  "Follow-ups and open items" below) where `..` and `%2e%2e` sequences were
  stripped by the HTTP client's URL parser before ever reaching the
  traversal check, letting a crafted path escape both the request's own
  folder and the bucket entirely.
- **Rate limiting and caps.** Photo minting is rate-limited (closed-mode:
  an outage in the limiter blocks uploads rather than allowing them
  unbounded); a maximum of 8 photos per request is enforced both at mint time
  and, after a review finding, again at finalize; a database-level unique
  index on `(organization_id, storage_path)` (migration `0316`) makes it
  physically impossible for two attachment rows to point at the same object,
  closing a photo-count-inflation bypass no application-layer check alone
  could fully close.
- **Share-link generation.** When a request has at least one photo, a
  revocable, 180-day, 64-hex-token share link is minted
  (`maintenance_request_share_links`, one active link per request enforced by
  a partial unique index). The public page (`/m/[token]`) and its photo proxy
  (`/m/[token]/photo/[n]`) expose only an explicit allow-list — request
  number, subject, description, site name, created date, and photo bytes
  through a proxy that never returns a signed Storage URL to the browser.
  Unknown, revoked, expired, and malformed tokens are all indistinguishable
  (a generic not-found), so no probe can learn which failure mode applies.
  Revoking a link is manage-permission-only; the owning requester gets a
  copy-only view of their own share link.
- **Download for manual attachment.** Because an Outlook Web compose link
  cannot reliably pre-attach files, the review and detail screens both offer
  a **Download Photos for Outlook** action (per-photo signed download links)
  and explain, in the product's own words: "Outlook cannot add StockPilot
  photos automatically. The photo links will be included in the message, and
  you can download the photos here if you want to attach them directly."
- **Visible inside StockPilot.** Photos render as thumbnails on the review
  screen, the detail page, and the mobile detail screen, independent of
  whether an email was ever opened.

## 5. Permissions

Four permissions, each with a narrow, product-accurate meaning:

- **`maintenance_requests:submit`** — create a request; view and manage one's
  own requests (edit before archival, reopen the Outlook draft, copy email
  details, add photos). Granted by default to every role including viewer
  (any employee can report an issue).
- **`maintenance_requests:read_all`** — see every request in the
  organization; search and filter; view requester information, photos, and
  related records. Does not grant configuration changes. Default: admin,
  manager.
- **`maintenance_requests:manage`** — everything `read_all` grants, plus
  assigning a **StockPilot-internal** local owner, adding internal notes,
  and archiving/cancelling requests. The UI is careful to label this "Internal
  coordinator" / "StockPilot owner" and to disclose explicitly that it is not
  a Zendesk assignment. Default: admin, manager.
- **`maintenance_requests:configure`** — owner-only (no default role rows
  exist for it at all; only the platform's owner short-circuit grants it).
  Governs categories, the share-link-in-email toggle, and per-member
  notification-audience settings, plus a link to the existing roles matrix
  rather than a parallel grants UI.
- **Owner.** The organization owner role always has full access through the
  existing owner short-circuit in `has_permission()` — no separate code path.
- **Andrew's grant.** Verified end to end against the shipped code: Settings
  → Maintenance requests → "Manage who can view or manage all requests" →
  `/dashboard/settings/roles` → Per-user exceptions → select Andrew → toggle
  "View all maintenance requests" and "Manage maintenance requests". This
  works because all four maintenance permissions carry
  `group: 'Maintenance'` in `packages/core/src/constants/permissions.ts:651-669`,
  so the existing `RolePermissionMatrix` groups them into the per-user
  override UI automatically — no new grants UI was built. The change takes
  effect on both platforms without a re-login: web via the existing
  `PermissionsRealtime` broadcast listener in the dashboard shell
  (`router.refresh()` on change), mobile via the existing
  `use-permissions-realtime` hook wired into the drawer content and CTA
  gating.

## 6. Files changed

134 files changed on this branch versus `main` (25,030 insertions, 71
deletions; `git diff main...HEAD --stat`). By area:

- **Database** (3 migrations + 3 pgTAP suites): `supabase/migrations/0314_maintenance_requests.sql`,
  `0315_maintenance_photos_bucket.sql`, `0316_maintenance_attachment_path_uniq.sql`;
  `supabase/tests/0314_*.test.sql`, `0315_*.test.sql`, `0316_*.test.sql`;
  plus a one-line count update to `supabase/tests/0207_permission_overrides.test.sql`.
- **Shared package** (`packages/core/src/`): `maintenance/constants.ts`,
  `maintenance/email.ts` (the pure builder), `maintenance/mr-number.ts`,
  `maintenance/text.ts` (sanitizers), each with its own test file;
  `schemas/maintenance.ts` (the `.strict()` zod schema shared by every
  intake path); `email/outlook-compose.ts` (the extracted generic transport);
  `constants/permissions.ts` (four new permissions); `modules/registry.ts`
  (the module row); `index.ts` barrel exports.
- **Web server** (`apps/web/src/server/`): `services/maintenance-requests.ts`
  (the core service — create/list/get/update/archive/cancel/assignLocalOwner/
  addNote/listNotes/recordDraftOpened/emailInput/listTimelineEvents),
  `services/maintenance-attachments.ts` (mint/finalize/remove/signedViewUrls),
  `services/maintenance-share-links.ts` (ensureActiveLink/revoke/resolve),
  `services/maintenance-notify.ts` (audience resolution + event emission),
  `actions/maintenance-requests.ts` (server actions), `actions/maintenance-settings.ts`;
  each with its own test file; small touches to `services/audit.ts` (new
  event names).
- **Web API** (`apps/web/src/app/api/`): `v1/maintenance-requests/route.ts`
  (list/create) and `[id]/route.ts` (get/update),
  `[id]/attachments/route.ts` + `finalize/route.ts` + `[attachmentId]/route.ts`,
  `[id]/draft-opened/route.ts`, `[id]/share-link/route.ts`,
  `cron/maintenance-draft-reminders/route.ts`; `app/m/[token]/page.tsx` and
  `photo/[n]/route.ts` (the public share page and photo proxy).
- **Web UI** (`apps/web/src/app/(dashboard)/dashboard/maintenance/`):
  `page.tsx` (list), `new/page.tsx` + `new-request-client.tsx` (create),
  `[id]/page.tsx` + `detail-client.tsx` (detail/review), `loading.tsx`;
  `dashboard/settings/maintenance/page.tsx` (God Admin configuration); small
  touches to `settings/page.tsx` (hub tile) and `help/page.tsx` (tour entry).
- **Web components** (`apps/web/src/components/maintenance/`): `maintenance-request-form.tsx`,
  `maintenance-photos-panel.tsx`, `maintenance-review.tsx`, `maintenance-email-action.tsx`,
  `maintenance-status-badge.tsx`, `maintenance-search.tsx`, `maintenance-notes-panel.tsx`,
  `assign-owner-select.tsx`, `share-link-panel.tsx`, `maintenance-settings-panel.tsx`,
  `report-problem-button.tsx` — each with a co-located test file; launch
  points added to `components/inventory/item-detail.tsx`,
  `dashboard/orders/[id]/page.tsx`, `dashboard/rentals/[id]/page.tsx`.
- **Web shared infrastructure touched incidentally**: `components/ui/pagination.tsx`
  (new serializable link flavor — the Task 25 fix, see §8 Tests below),
  `lib/image-signature.ts` (new), `lib/client-ip.ts` (reused for share-link
  rate limiting), `lib/share-paths.ts`, `lib/notification-prefs.ts`,
  `lib/onboarding/tours.ts` / `workflows.ts` / `announcements.ts` /
  `maintenance-onboarding.test.ts` (the tour), `app/error.tsx` and
  `app/global-error.tsx` (share-token redaction in error beacons),
  `app/robots.ts` (disallow `/m/`), `components/analytics/posthog-provider.tsx`
  (share-path redaction), `components/settings/notification-preferences-form.tsx`
  (four new toggle rows), `components/orders/storefront/storefront-logic.ts`
  (rewired to delegate to the shared transport), `components/dashboard/icons.ts`.
- **Mobile** (`apps/mobile/`): `app/(drawer)/maintenance.tsx` (list screen),
  `app/maintenance/new.tsx`, `app/maintenance/[id].tsx`;
  `src/lib/maintenance-api.ts`, `maintenance-upload.ts`,
  `maintenance-email-actions.ts` (each with a test file);
  `src/lib/debounced-list-load.ts` (extracted, tested search debounce
  helper); drawer/stack registration in `app/(drawer)/_layout.tsx` and
  `app/_layout.tsx`; launch points in `app/(drawer)/(tabs)/scan.tsx` and
  `app/item/[id].tsx`; rewrite rules in `src/lib/web-path-rewrite.ts`; icon in
  `src/lib/nav-icons.ts`.
- **Docs**: this report, plus the already-committed verification log
  (`docs/superpowers/reports/2026-08-05-maintenance-requests-verification.md`).

## 7. Data model

Three new tables plus one child, all under RLS, plus four new notification
preference columns. Verbatim from `supabase/migrations/0314_maintenance_requests.sql`
(the canonical source — reproduced here rather than re-described):

### `maintenance_requests`

```sql
create table if not exists public.maintenance_requests (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references public.organizations(id) on delete cascade,
  request_number            bigint,
  requester_user_id         uuid references auth.users(id) on delete set null,
  requester_name_snapshot   text not null check (length(requester_name_snapshot) between 1 and 200),
  requester_email_snapshot  text check (requester_email_snapshot is null or length(requester_email_snapshot) <= 320),
  requester_phone_snapshot  text check (requester_phone_snapshot is null or length(requester_phone_snapshot) <= 40),
  subject                   text not null check (length(subject) between 5 and 200),
  description               text not null check (length(description) between 1 and 5000),
  category                  text check (category is null or length(category) <= 80),
  priority                  text not null default 'normal'
                              check (priority in ('low','normal','high','urgent')),
  charter_id                uuid references public.charters(id) on delete set null,
  warehouse_id              uuid references public.warehouses(id) on delete set null,
  building                  text check (building is null or length(building) <= 200),
  room_or_area              text check (room_or_area is null or length(room_or_area) <= 200),
  department                text check (department is null or length(department) <= 200),
  access_instructions       text check (access_instructions is null or length(access_instructions) <= 2000),
  related_item_id           uuid references public.inventory_items(id) on delete set null,
  related_order_request_id  uuid references public.order_requests(id) on delete set null,
  related_rental_id         uuid references public.rentals(id) on delete set null,
  related_location_id       uuid references public.locations(id) on delete set null,
  local_owner_user_id       uuid references auth.users(id) on delete set null,
  status                    text not null default 'saved'
                              check (status in ('saved','draft_opened','archived','cancelled')),
  outlook_draft_opened_at   timestamptz,
  outlook_draft_open_count  integer not null default 0,
  draft_reminder_sent_at    timestamptz,
  archived_at               timestamptz,
  cancelled_at              timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
```

Indexes: `maintenance_requests_org_number_uniq` (organization_id,
request_number, unique), `maintenance_requests_org_created_idx`,
`maintenance_requests_org_requester_idx`, `maintenance_requests_org_status_idx`
(all organization-prefixed). Two deliberate deviations from the brief's §27
sketch, both adjudicated in the plan: the brief's `related_order_id` is
`related_order_request_id` because no `orders` table exists (every FK into
orders in this codebase is `*_order_request_id`); there is no `asset_tag`
column because no such data exists anywhere in the product yet. An explicit
`status` column backs the four §20 states rather than deriving them from
timestamp presence.

### `maintenance_request_attachments`

```sql
create table if not exists public.maintenance_request_attachments (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete cascade,
  maintenance_request_id uuid not null references public.maintenance_requests(id) on delete cascade,
  storage_path           text not null check (length(storage_path) <= 500),
  thumbnail_path         text check (thumbnail_path is null or length(thumbnail_path) <= 500),
  original_filename      text not null check (length(original_filename) <= 300),
  safe_filename          text not null check (length(safe_filename) <= 300),
  mime_type              text not null check (mime_type in ('image/png','image/jpeg','image/webp')),
  byte_size              integer not null check (byte_size > 0 and byte_size <= 10485760),
  width                  integer,
  height                 integer,
  sort_order             integer not null default 0,
  verified_at            timestamptz,
  uploaded_by            uuid references auth.users(id) on delete set null,
  created_at             timestamptz not null default now()
);
```

Indexes: `maintenance_request_attachments_req_idx`,
`maintenance_request_attachments_org_idx`, plus the `0316` fix-wave addition
`maintenance_request_attachments_org_path_uniq` (organization_id,
storage_path, unique) — the DB-level guarantee that one storage object can
back at most one attachment row.

### `maintenance_request_notes` (internal only)

```sql
create table if not exists public.maintenance_request_notes (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete cascade,
  maintenance_request_id uuid not null references public.maintenance_requests(id) on delete cascade,
  author_user_id         uuid references auth.users(id) on delete set null,
  body                   text not null check (length(body) between 1 and 4000),
  created_at             timestamptz not null default now()
);
```

### `maintenance_request_share_links`

```sql
create table if not exists public.maintenance_request_share_links (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete cascade,
  maintenance_request_id uuid not null references public.maintenance_requests(id) on delete cascade,
  token                  text not null unique check (length(token) between 16 and 128),
  active                 boolean not null default true,
  expires_at             timestamptz not null,
  created_by             uuid references auth.users(id) on delete set null,
  revoked_at             timestamptz,
  created_at             timestamptz not null default now()
);
```

Plus a partial unique index enforcing at most one *active* link per request:

```sql
create unique index if not exists maintenance_request_share_links_one_active_uniq
  on public.maintenance_request_share_links (maintenance_request_id)
  where active;
```

### RLS policies (verbatim)

Every helper call inside every policy predicate is wrapped in `(select ...)`
per the `0140` initplan-wrapping convention. All four tables have RLS
enabled.

```sql
-- maintenance_requests: SELECT is requester-own OR read_all OR manage.
-- NOT module-gated (history stays visible after a disable).
create policy maintenance_requests_select on public.maintenance_requests
  for select to authenticated
  using (
    (requester_user_id = (select auth.uid()) and (select public.has_org_role(organization_id, 'viewer')))
    or (select public.has_permission(organization_id, 'maintenance_requests:read_all'))
    or (select public.has_permission(organization_id, 'maintenance_requests:manage'))
  );

-- INSERT: submitter creates OWN rows only; module must be enabled.
create policy maintenance_requests_insert on public.maintenance_requests
  for insert to authenticated
  with check (
    requester_user_id = (select auth.uid())
    and (
      (select public.has_org_role(organization_id, 'manager'))
      or (select public.has_permission(organization_id, 'maintenance_requests:submit'))
    )
    and (select public.module_enabled(organization_id, 'maintenance_requests'))
  );

-- UPDATE: requester edits own pre-archival rows; manage/manager edit any.
create policy maintenance_requests_update on public.maintenance_requests
  for update to authenticated
  using (
    (requester_user_id = (select auth.uid()) and archived_at is null and cancelled_at is null
      and (select public.has_org_role(organization_id, 'viewer')))
    or (select public.has_org_role(organization_id, 'manager'))
    or (select public.has_permission(organization_id, 'maintenance_requests:manage'))
  )
  with check (
    (
      (requester_user_id = (select auth.uid()) and (select public.has_org_role(organization_id, 'viewer')))
      or (select public.has_org_role(organization_id, 'manager'))
      or (select public.has_permission(organization_id, 'maintenance_requests:manage'))
    )
    and (select public.module_enabled(organization_id, 'maintenance_requests'))
  );

-- Attachments: visibility and writes follow the parent row, with the parent
-- EXISTS join QUALIFIED against the attachments table's own organization_id
-- (see §"the cross-tenant EXISTS exploit" under Follow-ups below for why
-- this qualification is load-bearing, not decorative).
create policy maintenance_request_attachments_select on public.maintenance_request_attachments
  for select to authenticated
  using (
    exists (
      select 1 from public.maintenance_requests r
       where r.id = maintenance_request_id
         and r.organization_id = maintenance_request_attachments.organization_id
         and (
           (r.requester_user_id = (select auth.uid()) and (select public.has_org_role(r.organization_id, 'viewer')))
           or (select public.has_permission(r.organization_id, 'maintenance_requests:read_all'))
           or (select public.has_permission(r.organization_id, 'maintenance_requests:manage'))
         )
    )
  );

-- Notes: manage-only in BOTH directions. Requesters and read_all users can
-- never read internal notes, matching §5/§28.
create policy maintenance_request_notes_select on public.maintenance_request_notes
  for select to authenticated
  using (
    (select public.has_permission(organization_id, 'maintenance_requests:manage'))
    and exists (
      select 1 from public.maintenance_requests r
       where r.id = maintenance_request_id
         and r.organization_id = maintenance_request_notes.organization_id
    )
  );

-- Share links: SELECT for manage only. ALL writes happen through the
-- service-role client — there is no authenticated INSERT/UPDATE policy at
-- all, by design.
create policy maintenance_request_share_links_select on public.maintenance_request_share_links
  for select to authenticated
  using (
    (select public.has_permission(organization_id, 'maintenance_requests:manage'))
    and exists (
      select 1 from public.maintenance_requests r
       where r.id = maintenance_request_id
         and r.organization_id = maintenance_request_share_links.organization_id
    )
  );
```

(Attachment INSERT/DELETE policies and the notes INSERT policy follow the
same parent-EXISTS + org-qualification shape; the full text is in migration
`0314`, lines 314-405.)

### Storage bucket (migration `0315`)

Private bucket `maintenance-photos` (`public = false`, `allowed_mime_types =
{image/png,image/jpeg,image/webp}`, 10 MB file-size limit). One INSERT policy
only — org-prefix match on `(storage.foldername(name))[1]::uuid` against the
caller's accepted memberships, plus an inline disabled-account guard. No
SELECT/UPDATE/DELETE policy exists on the bucket; every read is a
server-minted signed URL.

### Notification preference columns (0314, §9)

```sql
alter table public.notification_preferences
  add column if not exists push_maintenance_new_request    boolean not null default true,
  add column if not exists push_maintenance_urgent_request boolean not null default true,
  add column if not exists push_maintenance_assigned       boolean not null default true,
  add column if not exists push_maintenance_draft_reminder boolean not null default true;
```

Permission seed rows (`role_default_permissions`, moving the pgTAP-pinned
`0207` count from 111 to 119):

```sql
insert into public.role_default_permissions (role, permission) values
  ('admin',   'maintenance_requests:submit'),
  ('manager', 'maintenance_requests:submit'),
  ('staff',   'maintenance_requests:submit'),
  ('viewer',  'maintenance_requests:submit'),
  ('admin',   'maintenance_requests:read_all'),
  ('manager', 'maintenance_requests:read_all'),
  ('admin',   'maintenance_requests:manage'),
  ('manager', 'maintenance_requests:manage')
on conflict (role, permission) do nothing;
```

`configure` deliberately has no default-role rows anywhere — it is
owner-only via the platform's owner short-circuit in `has_permission()`.

## 8. Tests

### Every gate command and its actual result (from the committed verification
log, `docs/superpowers/reports/2026-08-05-maintenance-requests-verification.md`,
Task 24, run 2026-08-06)

| Command | Result |
|---|---|
| `pnpm --filter @stockpilot/core test` | 46 files / 873 tests passed |
| `pnpm --filter web test` | 464 files / 5,348 tests passed (incl. the four historical R1 delivery-pinning suites at their unchanged 194-test count) |
| `pnpm --filter mobile test` | 53 files / 1,101 tests passed |
| `pnpm --filter web typecheck` | exit 0, zero diagnostics |
| `pnpm --filter mobile typecheck` | exit 0, zero diagnostics |
| `pnpm --filter web lint` | exit 0; 34 pre-existing warnings outside any maintenance path, 0 errors |
| `pnpm --filter web build` | exit 0; 113/113 static pages generated; route table includes `/dashboard/maintenance`, `/dashboard/maintenance/[id]`, `/dashboard/maintenance/new`, `/dashboard/settings/maintenance`, `/api/v1/maintenance-requests` (+ children), `/api/cron/maintenance-draft-reminders` |
| `supabase db reset` | applied every migration through `0316` clean |
| `supabase test db` | Files=114, Tests=1,676, Result: PASS (0314/0315/0316 suites all `ok`) |

The `0207_permission_overrides.test.sql` assertion pins the seeded
`role_default_permissions` row count at exactly `119`, with a comment
documenting the +8 maintenance contribution.

### Honesty and boundary sweeps (Task 24, Step 2)

- Zendesk grep across every maintenance path: 39 hits, all comments or
  disclosure copy, zero executable surface.
- Forbidden-phrase grep in production source only: zero hits.
- Emoji grep across the full branch diff: none.
- Co-authored-by trailer grep across branch commits: none.
- `EXPO_ROUTES` pin: the mobile drawer screen file that the route table
  points at actually exists.

### The manual authed browser walk (Task 25) — the program's real E2E, and its
headline finding

No Playwright CI gate exists in this repo, and `window.location.assign`
cannot be stubbed in real Chromium, so the brief's End-to-end web test
requirements (§31) were satisfied by a combination of Task 14's component
tests plus a scripted, MCP-driven Playwright walk against the real local
stack with real seeded data — not JSDOM mocks. The walk ran the brief's full
20-check script plus five controller-added checks (25 total).

**The walk found a real, user-facing bug that the entire automated stack —
873+5,348+1,101 tests, two clean typechecks, a clean lint, a clean production
build, and 1,676 pgTAP assertions — had missed:** `apps/web/src/app/(dashboard)/dashboard/maintenance/page.tsx`
passed an inline function (`hrefForPage={(n) => buildMaintenanceHref(...)}`)
from a server component into the `'use client'` `Pagination` component.
React Server Components cannot serialize a function across that boundary;
the runtime threw (`Functions cannot be passed directly to Client
Components...`, digest `3969804129`) and the error boundary replaced the
entire page. The pager block only renders when the list is non-empty, so
every empty-list check, every JSDOM component test, `tsc`, and `next build`
passed — none of them ever populated the list with a real row. The walk did,
because it drove the real UI against real seeded data, and both the
requester's "My requests" view and the manager's "All requests" view crashed
identically the moment a single row existed. This also silently broke the
maintenance onboarding tour for any user with at least one request, since
the tour's target page crashed before the tour could mount.

**The fix** (commit `6075016d`): `components/ui/pagination.tsx` gained a
second, serializable link flavor — `basePath` + `baseParams: Record<string,
string>` + `pageParamName` — so a server component can hand the client
component plain, serializable data instead of a function, and the client
component builds each page href itself. The maintenance list page now passes
`basePath` and `baseParams` (via a new `maintenanceListParams()` helper
factored out of the existing `buildMaintenanceHref`, so the filter pills and
the pager can never drift from the same query contract). The original
`hrefForPage` function-prop flavor is untouched and still fully supported for
every existing client-component call site (the inventory table, the
movements instant table, the public-link editor) — their tests pass
unmodified. Two new tests pin the page's source text against ever
reintroducing the function-prop flavor, with an honest limits note that a
source-text pin proves what the file says, not what React does at runtime —
the real proof is the re-run browser walk below.

**All four previously failed checks were re-verified passing in a real
browser** after the fix: the requester's list renders the row with no error
boundary and no React/RSC console errors; "My requests" shows the row; the
manager's "All requests" (`?scope=all`) renders it with the requester column,
and clicking a status-pill filter survives on a rows-bearing list; the
onboarding tour mounts and advances through its steps on the exact
requester/one-row persona that crashed during the original walk. `pnpm --filter
web build` re-ran clean afterward; a spot run of 19 files / 370 tests passed
(page suite, onboarding, every maintenance component/service/action suite,
inventory-table pagination client mode); typecheck clean across web, mobile,
and core; ESLint clean on the three touched files.

**Two confirmed-latent siblings exist on `main` today, unfixed on this
branch, sharing the identical pattern:** `dashboard/movements/page.tsx`
passes the same kind of function `hrefForPage` into `Pagination` at two
render sites, gated on `!instant` — it will crash exactly when an org's
unfiltered movement count exceeds the movements instant-mode cap and the
server-mode pager has to render. `dashboard/purchase-orders/imports/page.tsx`
passes the same shape (`hrefForPage={pageHref}`) — it will crash once an org
holds more than 30 imports, or the moment anyone deep-links `?page=2`; L4L is
realistically approaching that import count soon. **Recommendation: ship an
immediate fast-follow PR after this branch merges, applying the same
serializable-`Pagination`-flavor fix to both files.** The fix pattern is
already proven and ready-made; this is a small, low-risk, high-value
follow-up, not new design work.

### Walk pass/fail summary

21 of the 25 checks passed outright on the first run; the 4 that failed
(list-with-rows half of check 8, checks 17 and 18, and the requester path of
check 21) all failed on the single bug above and all four passed on re-verify
after the fix. Every no-send safety property held throughout: `window.open`
was proven patched before every click of Open in Outlook, exactly one
compose URL was ever captured (never opened), the network log was audited
clean of any request to `outlook.cloud.microsoft` / `learn4life.org` /
`cvwest.org`, and the real mailto path was never clicked at all. The
double-encoded `dc4%2540learn4life.org` To and `arosas%2540cvwest.org` CC,
the correct subject with request number, the description and `/m/<token>`
share link in the body, the draft-opened stamp and audit row, cross-org
isolation (a second org sees the module-off fallback, not a 404 that would
leak existence), the anonymous share page rendering real charter/site data,
the duplicate-draft dialog, and the copy-to-clipboard fallback were all
proven against real data, not mocks.

## 9. Limitations

Per the brief's required list, plus what device/production testing still
remains open:

- No direct Zendesk API integration exists or is planned for this phase.
- StockPilot has no way to confirm a Zendesk ticket was actually created —
  it only knows whether an Outlook draft was opened.
- No automatic ticket-status tracking. No comment synchronization. No
  in-app replies to the Zendesk thread.
- No automatic Outlook attachment insertion — photo links are included in
  the email body, and a **Download Photos for Outlook** action lets the
  employee attach them manually.
- Photo links in the email require either StockPilot access or the share
  link; DC4 and Andrew are expected to use the share link, since they are
  not necessarily StockPilot users.
- The employee must manually click Send in Outlook — nothing sends
  automatically, ever.
- **Residual risk (Q2, acceptance criterion 1):** the module is enabled only
  for L4L today via a targeted per-org row, and every other current
  organization is grandfathered off. But because the module system is
  general-purpose by design (so it *can* extend to another organization
  later without a rewrite), another organization's own owner *could*
  self-enable it through the same configuration surface an owner already has
  for every other optional module. If that happened, the drafted emails
  would still target the L4L-specific constants (`dc4@learn4life.org` /
  `arosas@cvwest.org`) — a real, if unlikely, misconfiguration risk that has
  no code-level guard today beyond "no other org's owner has a reason to
  enable it." Worth a per-org recipient override in a future phase if this
  becomes a real concern (see §30 in the master brief's own OPEN note on
  `lib/site.ts`).
- Scope cuts made explicitly during planning, not silently dropped:
  drag-to-reorder photos before saving, client-network-failure notifications
  during upload, and a native OS share-sheet path on mobile for attaching
  photos directly into Outlook (investigated as optional per §10's "Optional
  mobile enhancement" language, not built).
- The `/dashboard/maintenance` list's "All requests" view ships with two
  filters (status, search) rather than the master brief's full §22 facet set
  (category, priority, site, requester, date range, related item, local
  owner, draft-opened/not) — search does cover request number, subject,
  description, requester, site, SKU, asset tag, and order number, and
  archived/active is reachable via the status filter, but the remaining
  facets are a purely additive fast-follow candidate (two optional service
  params plus a pill each), not implemented in this phase.

### Verification debts (device testing not yet done)

- **Mobile simulator hand-test is owed.** The project convention requires a
  simulator walk after any mobile change; the current iOS simulator dev
  client has a pre-existing boot crash unrelated to this branch (traced to
  `ExpoRoot.js`'s `ContextNavigator`, pre-`_layout`, module-graph-inert
  against this branch's diff) — an infra A/B rebuild is owed separately and
  is not something this program can or should fix. Everything mobile in this
  program was verified through source-pin tests, extracted-and-unit-tested
  logic (the debounce/stale-response helper, the upload declared-MIME
  derivation), and typecheck/build, but not a live device or simulator
  render.
- **Notification tap-through has not been verified on a real device.** The
  push trigger, the link literal, and the mobile `web-path-rewrite` mapping
  are all unit-tested and cross-pinned against each other, but an actual
  device receiving a maintenance push notification and landing on the
  correct in-app screen has not been observed.
- **The reminder cron has not fired post-deploy.** `maintenance-draft-reminders`
  is unit-tested (stamp-first ordering, the 24-hour cutoff, the muted-user
  stamp-without-notify semantic) but has never run against live data on a
  schedule.

## 10. Future option

Nothing here forecloses a later, explicitly-approved Zendesk API
integration. If the organization later grants Zendesk API credentials, a
future phase could: create the ticket directly from StockPilot instead of
relying on the employee to send an email; attach photos programmatically
instead of requiring a manual download-and-attach step; capture and store
the real Zendesk ticket number against the StockPilot request; poll or
subscribe to ticket status and reflect it in the StockPilot list and detail
views; display Zendesk comments inside StockPilot; and allow in-app replies
that post back to the ticket. None of that is built, wired, or half-built in
this phase — the data model deliberately has no ticket-ID column, and no
Zendesk-shaped call exists anywhere in the diff for a future task to
"discover" and build on top of by accident.

---

## Follow-ups and open items

### Owner checkpoint items (decisions, non-blocking)

These do not block shipping; they are things the owner should be aware of
and, in a few cases, decide on:

- **The email greeting and sign-off were dropped from the shipped body**,
  not by preference but by URL-length physics: the brief's full illustrative
  §15 body measures 2,553-2,612 encoded characters against the 1,800-character
  compose-link ceiling on this tenant's transport, and no encoding format
  rescues the maximal case. Every data-bearing line from §15 is still present
  in full in the shipped body; only the conversational wrapper (greeting,
  "please create a ticket," sign-off) is gone from the Outlook-URL version.
  The Copy Email Details fallback is unaffected by this budget and always
  contains the complete body.
- **Condensed mode is the norm, not the exception, once a request has
  photos.** The photos block costs 334 encoded characters on its own; with a
  photo attached, the description budget before the body must condense drops
  to roughly 63 characters. This is disclosed on the review screen whenever
  it happens, but it means most real-world requests (which will usually have
  a photo) will show the condensed body by default.
- **The create-request rate limiter fails closed.** If the rate-limiting RPC
  itself has an outage, the effect is that maintenance-request submission is
  blocked entirely rather than allowed unbounded — a deliberate, brief-consistent
  choice, but one with a real availability tradeoff the owner should know
  exists.
- **Share-link tokens are stored in plaintext** in `maintenance_request_share_links.token`,
  matching the existing `0261` token pattern elsewhere in the product. A
  single-resolver funnel (`resolveMaintenanceShareToken`) was deliberately
  built so a future hash-migration is additive rather than a rewrite, but
  today a database read of that table yields usable tokens.
- **The "All requests" list ships without the full §22 facet set** (see
  Limitations above) — category/priority/site/requester/date-range/related-item/
  local-owner/draft-opened filters are not yet built; status and full-text
  search are.
- **`organization_modules.settings` writes are an unguarded read-modify-write**
  with no optimistic lock (`apps/web/src/server/actions/maintenance-settings.ts`).
  This is a systemic, pre-existing pattern shared identically by
  `auto-archive-settings.ts` and `inventory-cleanup-settings.ts` — nothing
  about maintenance requests introduced it, and no atomic `settings ||
  $1`-style jsonb merge exists anywhere in the repo today. Worth a systemic
  fix, not a maintenance-specific one.
- **The image-variants worker still produces 200px thumbnails** while the
  main upload path produces 400px thumbnails (`apps/web/src/lib/image-variants.worker.ts:20`
  vs. the main finalize path) — a pre-existing drift in a shared, high-blast-radius
  file that this program inherited rather than introduced, and did not fix.
- **What's New announcements remain ungated by module**, matching every
  other module-scoped announcement in the product today — an org without the
  maintenance module enabled can still see an announcement about it. This is
  the existing convention, not a maintenance-specific gap.
- **The local dev `SUPABASE_SERVICE_ROLE_KEY` in `stockpilot-env` is stale**
  for the local Supabase stack — every `createAdminClient()` path fails
  locally until it's refreshed (process-env overrides were used to work
  around this during the Task 25 walk; no file was edited). This is a
  local-dev-only issue and does not affect production.

### Program totals and the review catch-list

26 tasks across seven phases, every one reviewed by an adversarial opus pass
before being marked complete. Nine tasks had a review or the manual walk
catch something real enough to need a fix wave:

- **Task 1 (migration 0314) — cross-tenant EXISTS exploit.** An unqualified
  `organization_id` inside a correlated `EXISTS` compiled to
  `r.organization_id = r.organization_id` — always true — letting a foreign
  organization's attachment write succeed with only `module_enabled` as a
  precondition (no membership check). A second, related exploit let a note
  or share link bind to a request in a different organization. Fixed by
  qualifying every `EXISTS` join against the child table's own
  `organization_id` everywhere (now the ledgered pattern #25: "unqualified
  column inside EXISTS is a silent self-comparison tautology — always
  qualify the outer table"). Both exploits were re-run verbatim
  post-fix and both now correctly 42501 (permission denied).
- **Task 9 (attachment finalize) — path traversal.** The only tenant
  boundary on `finalize` was a `path.startsWith()` check, but the HTTP
  client's URL parser strips `..` and `%2e%2e` sequences *before* the
  request leaves the process — so a crafted path like
  `org/req/../../victim-org/victim-req/photo.png` passed the check, was
  downloaded via the service-role client (RLS cannot stop a service-role
  read), and could escape the bucket entirely into `item-images` via a
  guessable path. Fixed with a strict shape regex evaluated before any
  storage call, verified against the two original exploits plus 34
  additional hostile variants (unicode dot lookalikes, `%2f`, `%00`,
  RTL-override characters, double extensions, protocol-relative paths) — all
  rejected.
- **Task 9 — weakened MIME/dimension sniffing.** The review found the
  sniffer would accept a RIFF container without checking for the WEBP
  fourcc, accept a PNG on 4 of its 8 signature bytes without checking the
  `IHDR` tag, and had no guard against a corrupted header claiming
  4,294,967,295-pixel dimensions (which would overflow the `integer`
  column). All three closed with a hardened sniffer (full 8-byte PNG
  signature, `IHDR` check, dimension range guard, real RIFF/WAVE fourcc
  check for WEBP).
- **Task 10 (share links) — storage-path leak risk.** The original design
  had `resolveMaintenanceShareToken` touch Storage directly to build signed
  URLs for the public page, meaning any bug in that path could leak a real
  signed Storage URL. Closed structurally, not just patched: the resolver no
  longer touches Storage at all — photos on the public page are `{filename}`
  only, and a separate, tightly-scoped photo proxy
  (`/m/[token]/photo/[n]`) is the *only* code that ever touches
  `storage_path`, with double bounds-checking, org/request scoping derived
  from the resolved link row (never client input), and Content-Type taken
  from the sniffed MIME stored at upload time (a tampered MIME removes the
  attachment row from consideration entirely).
- **Task 12 (list page) — a titular test.** A mutation that changed the
  status-label constants survived all 24 existing tests because the list
  page's rendering wasn't actually pinned against the shared
  `MAINTENANCE_STATUS_LABELS` source of truth. Fixed by deriving the pill
  labels from that constant with a literal pin catching drift in both
  directions.
- **Task 14 (review screen + email action) — a live defect and a masked
  honesty sweep.** A rejected `recordMaintenanceDraftOpenedAction` call was
  painting Next.js's error overlay directly over the honest success message
  the user had just seen — fixed with proper `.catch` handling. Separately,
  the §20 honesty sweep (checking that no forbidden phrase like "Email
  sent" ever renders) was only checking two of five UI states and was
  checking the wrong DOM node — Radix portals dialogs outside the tested
  container — so a reviewer-planted "Email sent to DC4." string in a success
  node passed all 20 existing tests. Fixed by sweeping all five states
  against `document.body`.
- **Task 17 (related-record launch points) — cross-tenant disclosure via
  charter/warehouse re-derive.** The first fix (closing a cross-org
  item/order/rental attach via crafted deep-link IDs) stopped at columns
  literally named `related_*`, but `charter_id` and `warehouse_id` were the
  same client-suppliable shape and were missed. Worse, the public share page
  read the charter name through a service-role embed that scoped the outer
  request row by organization but not the embedded charter — so a foreign
  organization's site name could render on an anonymous share page. Fixed at
  both layers (write-time re-derivation and a standalone,
  organization-scoped read on the share-page path), each layer proven
  independently sufficient by reverting the other and confirming the
  original exploit still reproduces without it.
- **Task 18 (mobile registration) — a search-input DoS-shaped bug and a
  testing-technique gap.** Mobile search was firing a network request on
  every keystroke with no debounce or stale-response guard (the initial
  claim that mobile matched web's submit-gated search was wrong — mobile
  never had submit-gating to begin with). Fixed with a 250ms debounce plus a
  sequence-token stale-response guard, extracted into a pure, genuinely
  unit-tested helper rather than left as an unverifiable source-text pin —
  the review had separately proven that three different mutations (a dead
  module check, a dead permission gate, a missing early `return`) all
  survived the original source-text-only pins, since React Native screens
  cannot render under this repo's test harness.
- **Task 23 (notifications + onboarding) — the never-mounted tour.** The
  maintenance onboarding tour was fully registered across all three
  onboarding registries, and the Help page's "Start" link pointed at it
  correctly, but the `<PageTour>` component was never actually mounted
  anywhere — no task in the original 26-task plan had been assigned that
  step, so the Help entry was silently dead. Fixed by mounting it in the
  list page header after the module/permission gates.
- **Task 25 (manual walk) — the RSC pagination crash.** Covered in full
  under Tests above; the walk found what 7,000+ automated tests, two
  typechecks, a lint pass, and a production build all missed, because it was
  the only check that ever populated the list with a real row in a real
  browser.

Mutation testing was used throughout as the review's verification technique
of choice, not just code reading. Representative totals recorded in the
ledger: Task 7 (email builder) ran 10 mutations, 9 killed outright and the
10th (an Outlook-vs-mailto-URL-length comparison) proven mathematically
unfalsifiable by exhaustive sweep rather than a genuine gap; Task 8 (core
service) re-verified 22 mutations post-fix, 20 caught automatically and 2
fixture-level survivors closed by hand; Task 9 (attachments) ran 7
mutations with zero survivors on the final pass, plus the reviewer's own
32-variant exploit re-run; Task 14 (review/email action) ran 21 mutations,
18 killed pre-fix and all 21 confirmed post-fix; Task 17 ran mutations
M1-M6/M8/M12, all killed, including one that specifically proved the
organization-scope guard itself was pinned and not just the existence
check; Task 21 (notifications) ran 8 mutations plus 2 fix-wave mutations;
Task 22 (reminder cron) ran 7 mutations, all caught. No task in this program
shipped on review sign-off alone without an accompanying mutation check.

Final full-suite counts at Task 24's gate (the numbers also in the Tests
section above): core 873 tests, web 5,348 tests, mobile 1,101 tests, local
pgTAP 1,676 assertions across 114 files, `0207`'s permission-count pin at
119. All green, all captured with real command output in the committed
verification log.

---

## Ship checklist (controller executes)

Local work ends here (GC 20). The order below is binding (GC 7) — the
database guard fails closed, so deploying code before its migration is an
outage class, the same one the account-disable program hit on 2026-08-01.
**Supabase MCP may need re-authentication before step 1** (it was reported
disconnected during this program's audit phase).

```text
1. supabase db push --linked        # migrations 0314 + 0315 + 0316 FIRST
                                     # (linked project xizpqmhhslgzbuqtjubv)
2. Open PR feat/maintenance-requests -> main; merge after review.
   Vercel deploys on push — do NOT also POST /v13/deployments.
3. Prod verify: dashboard loads; /dashboard/maintenance 404-free but
   module-gated (invisible/fallback for every org except L4L).
4. Mobile OTA: cd apps/mobile && pnpm release:ota   (never raw `eas update`).
   OTA verdict from Task 19: ships pure-JS, NO EAS build required —
   expo-file-system, expo-image-manipulator, expo-image-picker, and
   expo-camera are all already compiled into the shipped 1.1.0 binary;
   package.json/lockfile diffs are empty across every mobile file this
   program touched.
5. L4L enable — PROD DATA resolution, never name-matching, never a
   migration. The repository's only candidate org id
   ('63c13e64-92a6-4ea4-9936-6a2c26a85b4a', from migration 0031's
   "l4l fresno TEST data") is STALE test data, not today's L4L organization
   — do not treat it as authoritative and do not print a guessed id into
   any SQL that will actually run. Resolve the real id from prod first
   (e.g. via a known-L4L record such as inventory item
   'eef7cac6-312c-4c21-aab9-0f7f88d01e08'), confirm the organizations row
   name, and only then run:
     update public.organization_modules set enabled = true, enabled_at = now()
      where organization_id = '<VERIFIED PROD L4L ORG ID>'
        and module_id = 'maintenance_requests';
6. Prod verify walk in Demo Co (71b27a4a-7948-4638-bc3f-535974713bd2):
   TEMPORARILY enable the module for Demo Co (same UPDATE shape), walk the
   Task 25 script's SAFE subset (create, review, Copy Email Details only —
   NEVER click Open in Outlook in prod), verify mobile drawer + deep link,
   then DISABLE the module for Demo Co again and record both SQL statements
   and timestamps in the ship log.
7. Andrew's grant via the UI (zero new code): /dashboard/settings/roles ->
   per-user exceptions -> grant maintenance_requests:read_all + :manage to
   Andrew's member row; confirm his session updates WITHOUT re-login
   (broadcastPermissionsChanged / PermissionsRealtime + use-permissions-realtime)
   on both web and mobile.
8. Owner hand-test on the live L4L tenant: one real request, owner reviews
   the Outlook draft and decides whether to press Send. StockPilot's job
   ended at the draft.
```

Recommended immediately after this ships: a small, low-risk fast-follow PR
applying the same serializable-`Pagination` fix from step 8 of the Tests
section to `dashboard/movements/page.tsx` and
`dashboard/purchase-orders/imports/page.tsx`, both of which share the
identical latent RSC-function-prop crash and are realistic to trigger soon
(L4L's import volume is approaching the 30-import threshold that would
trigger the purchase-orders/imports crash).
