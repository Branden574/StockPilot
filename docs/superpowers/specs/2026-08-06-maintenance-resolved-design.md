# Maintenance Resolved — Design

Date: 2026-08-06. Status: owner-approved product decisions D1-D5 (verbatim adjudications below are BINDING — this spec encodes them; it does not reopen them). Base: the Maintenance Requests module as shipped in PR #73 (merged to `main` at `95ba14da`; engineering report `docs/superpowers/reports/2026-08-05-maintenance-requests-report.md`; migrations 0314-0316). Every file/line cited below was read from the shipped code, not from memory.

---

## 0. The owner's binding decisions (verbatim summary)

- **D1.** New `resolved` status. Resolve is the close-out (requires `maintenance_requests:manage`, the same persona as Archive today); resolved requests drop out of Active. Archive REMAINS as a quiet tidy-up for old resolved/cancelled rows. Cancel unchanged.
- **D2.** The Resolve action is a dialog requiring a RESOLUTION NOTE (owner's example: "The issue for the leaking roof tile has been resolved.") and allowing OPTIONAL PROOF PHOTOS as evidence, reusing the shipped attachment pipeline (same validation/bucket/caps machinery), labeled as resolution proof distinctly from requester photos on the detail page AND on the public share page (DC4/Andrew see proof through the same `/m/` link from the original email).
- **D3.** Requester notification on resolve, BOTH channels: (a) in-app/push via `createNotification` with a NEW muteable pref (fail-open, 0028-trigger delivery, link `/dashboard/maintenance/{id}`); (b) a REAL EMAIL via the repo's Resend template system, containing the resolver's display name, the resolution note VERBATIM, the proof photo(s), and a link to the request. THE HONESTY LINE IS NON-NEGOTIABLE: the email says resolution was recorded by the team in StockPilot; it NEVER claims the Zendesk ticket is closed. Sent AT-MOST-ONCE per request (stamped column, guarded-update-first — the returns-email pattern).
- **D4.** Full history guarantee: resolved requests keep their own filter pill, remain fully viewable forever, archive only re-buckets them, nothing is ever deleted.
- **D5.** MOBILE PARITY in the same program: resolved status/badge/filter on mobile, PLUS the close-out actions promised on mobile — Resolve (note + proof photo via the existing `maintenance-upload.ts` helper), Archive, Assign owner, and internal notes. PURE JS / OTA-safe on the live 1.1.0 binary: no new native modules, `package.json`/lockfile diffs empty.

---

## 1. Status model

### 1.1 The five statuses

`MaintenanceStatus` (packages/core/src/maintenance/constants.ts:48) widens from four to five members:

```ts
export type MaintenanceStatus = 'saved' | 'draft_opened' | 'resolved' | 'archived' | 'cancelled';

export const MAINTENANCE_STATUS_LABELS: Record<MaintenanceStatus, string> = {
  saved: 'Saved',
  draft_opened: 'Email draft opened',
  resolved: 'Resolved',
  archived: 'Archived',
  cancelled: 'Cancelled',
};
```

Insertion order is load-bearing: the web list page's `STATUS_FILTERS` (apps/web/src/app/(dashboard)/dashboard/maintenance/page.tsx:32-42) and the REST list route's `STATUS_VALUES` (apps/web/src/app/api/v1/maintenance-requests/route.ts:18) both derive from `Object.entries`/`Object.keys` of this record, so `resolved` between `draft_opened` and `archived` yields the pill order Active · Saved · Email draft opened · Resolved · Archived · Cancelled with ZERO changes to either derivation site. **D4's "verify the shipped list supports adding one more pill cleanly" — verified: it does, by construction.** What does NOT auto-propagate and needs explicit edits: the Task-12 literal-pin test on pill labels (drift is caught in both directions by design — the pin must be updated to the new five-label set), the web badge variant map (`maintenance-status-badge.tsx` `VARIANTS` — a `Record<MaintenanceStatus, string>` that stops typechecking until `resolved` is added), and the mobile `STATUS_PILL` map (apps/mobile/app/maintenance/[id].tsx:60-65, same `Record` shape).

### 1.2 What each status means now

| Status | Meaning (unchanged semantics kept verbatim) | Terminal? |
|---|---|---|
| `saved` | Request recorded in StockPilot; no draft opened yet | no |
| `draft_opened` | An Outlook/mailto draft was opened at least once (nothing more is knowable) | no |
| `resolved` | **NEW** — a manage-holder recorded a resolution close-out with a note (and optional proof photos). A StockPilot-local record, never an observation of Zendesk state | yes (see reopen) |
| `archived` | Quiet tidy-up bucket. Reachable from any non-archived status incl. `resolved` and `cancelled` (D1) | yes |
| `cancelled` | Requester/manage withdrawal, pre-close. Unchanged (D1) | yes (archivable) |

**"Active" now means:** `status in ('saved','draft_opened')` — exactly the shipped JS-side filter in `MaintenanceRequestsService.list()` (maintenance-requests.ts:447-449). `resolved` drops out of Active **with no code change to that filter** (it already keeps only the two open statuses; a test literal-pins that a `resolved` row is excluded so the invariant is deliberate, not incidental).

**"Closed" now means:** `archived_at IS NOT NULL OR cancelled_at IS NOT NULL OR resolved_at IS NOT NULL`. Every shipped closed-state guard extends to include `resolved_at`: the requester edit gate in `update()` (maintenance-requests.ts:532), the `recordDraftOpened()` guard (:862), `MaintenanceAttachmentsService.assertParentOwnedAndOpen()` (:156), `remove()`'s refusal copy path (:402), and the RLS clauses listed in §5. Photos (both kinds) freeze at resolve; proof photos are uploaded *inside the resolve dialog, before the status flip* (§3).

### 1.3 Transition matrix

| From \ To | resolved | archived | cancelled |
|---|---|---|---|
| saved | manage | manage (unchanged) | requester-own or manage (unchanged) |
| draft_opened | manage | manage (unchanged) | requester-own or manage (unchanged) |
| resolved | — (conflict) | manage (D1 tidy-up) | refused (conflict: "This request is resolved.") |
| cancelled | refused (conflict) | **manage — NEW** (D1: archive is the tidy-up for old resolved/cancelled rows) | — |
| archived | refused (conflict) | — | refused (unchanged) |

**Archive-of-cancelled is a deliberate behavior change.** The shipped `archive()` refuses cancelled rows (the "M1" guard, maintenance-requests.ts:619-636) because two closed-state timestamps on one row used to be an incoherent history. D1 redefines archive as a pure re-bucket: `archive()` now accepts any non-archived row, flips `status='archived'` + stamps `archived_at`, and **preserves** `resolved_at`/`resolved_by`/`resolution_note`/`cancelled_at` untouched — the timestamps carry "how it closed", the status carries "which bucket it lives in". The detail timeline renders every stamp it finds (Marked resolved, Request cancelled, Request archived), so nothing is lost by the re-bucket, satisfying D4's "archive only re-buckets them, nothing is ever deleted".

### 1.4 Reopen: NO in v1 (decided)

There is no `resolved → saved/draft_opened` transition in v1. A wrong resolve is corrected the way a wrong archive is today: it isn't — the request stays viewable forever with its full history, and a new request can be filed. Rationale: reopen would need its own permission story, a second notification/email contract ("un-resolved"?), at-most-once-stamp reset semantics, and honest vocabulary for a state StockPilot cannot reconcile with the Zendesk thread. Recorded as a future option; the schema does not foreclose it (nothing is deleted; `resolution_email_sent_at` staying stamped after a hypothetical reopen is exactly the at-most-once behavior we'd want anyway).

---

## 2. Data model — migration 0317

One migration: `supabase/migrations/0317_maintenance_resolved.sql` (+ pgTAP `supabase/tests/0317_maintenance_resolved.test.sql`). Migration inventory for this program: **0317 only.**

### 2.1 `maintenance_requests` changes

```sql
-- Widen the status CHECK. 0314 declared it inline on the column, so it holds
-- the Postgres default name maintenance_requests_status_check.
alter table public.maintenance_requests
  drop constraint maintenance_requests_status_check;
alter table public.maintenance_requests
  add constraint maintenance_requests_status_check
  check (status in ('saved','draft_opened','resolved','archived','cancelled'));

alter table public.maintenance_requests
  add column if not exists resolved_at               timestamptz,
  add column if not exists resolved_by               uuid references auth.users(id) on delete set null,
  add column if not exists resolved_by_name_snapshot text
    check (resolved_by_name_snapshot is null or length(resolved_by_name_snapshot) between 1 and 200),
  add column if not exists resolution_note           text
    check (resolution_note is null or length(resolution_note) between 1 and 2000),
  add column if not exists resolution_email_sent_at  timestamptz;
```

- `resolved_by_name_snapshot` follows the `requester_name_snapshot` precedent (0314:111): display and email both read the snapshot, so no cross-profile RLS read or PostgREST embed is ever needed to render "marked resolved by <name>" (there is no FK from `maintenance_requests` to `user_profiles`, so an embed is not even available — the snapshot is the correct house pattern, not just a convenience).
- `resolution_note` cap 2000 mirrors `access_instructions` (0314:124). The zod schema (§3.1) is the operative bound; the CHECK is the safety margin, same posture as C3 in the 2026-08-05 plan.
- `resolution_email_sent_at` is the D3 at-most-once stamp — the `return_prompt_sent_at` (0278) twin.
- No new index: `maintenance_requests_org_status_idx (organization_id, status)` already serves the new pill's query.

### 2.2 `maintenance_request_attachments.kind`

```sql
alter table public.maintenance_request_attachments
  add column if not exists kind text not null default 'requester'
    check (kind in ('requester','resolution'));
```

**Decision — kind column, not a separate table.** Justification from the shipped shapes: (a) proof photos need byte-identical machinery — bucket 0315, magic-byte sniff, path-shape validation, mint/finalize rate limits, and critically the 0316 uniqueness index `maintenance_request_attachments_org_path_uniq (organization_id, storage_path)`, which must keep covering proof photos or the phantom-photo cap bypass 0316 closed reopens for the new kind; a second table would need a cross-table uniqueness Postgres cannot express with a plain index. (b) The share page and its photo proxy index into ONE ordered list (`fetchValidAttachments`, maintenance-share-links.ts:179-192) shared by both surfaces so `photos[n]` on the page and `/m/<token>/photo/<n>` always name the same photo — a second table would force a merge with its own ordering bugs. One column, `default 'requester'`, backfills every existing row correctly with zero data migration.

- The 0316 unique index is untouched and automatically covers both kinds.
- `MAINTENANCE_MAX_PHOTOS = 8` applies **per kind** (requester photos keep their 8; resolution proof gets its own 8): both cap counts (`createUploadUrl` mint-time and `finalize` live re-check, maintenance-attachments.ts:223-231/:303-312) add `.eq('kind', <kind>)`. The 0316 index remains the race-closing backstop for both.
- **RLS enforces who may label a row `resolution`** (not just the service): a requester inserting straight through PostgREST could otherwise plant a self-supplied image labeled as staff proof on the share page/email. The attachments INSERT policy's WITH CHECK gains `and (kind = 'requester' or (select public.has_permission(organization_id, 'maintenance_requests:manage')))`.

### 2.3 RLS changes (pattern #24 and #25 discipline)

Three policies change. **Every one is `drop policy` + `create policy` with the FULL predicate text — never `alter policy ... with check`, which REPLACES rather than amends (recurring pattern #24).** Every parent EXISTS keeps its outer-table qualification `r.organization_id = <child>.organization_id` verbatim (pattern #25 — the 0314 Task-1 exploit class).

1. `maintenance_requests_update` (0314:296-311): the requester's own-row USING clause becomes `... and archived_at is null and cancelled_at is null and resolved_at is null ...`. Manager/manage arms unchanged (a manager may still edit any row, matching the shipped `update()` service bypass).
2. `maintenance_request_attachments_insert` (0314:329-345): parent-open clause becomes `r.archived_at is null and r.cancelled_at is null and r.resolved_at is null`; plus the kind clause from §2.2. (Requester photo writes freeze at resolve; proof uploads happen pre-flip, §3.2.)
3. `maintenance_request_attachments_delete` (0314:347-361): same `r.resolved_at is null` addition (photos of a resolved request are frozen history, D4).

SELECT policies are untouched (history stays visible forever — 0314 Q3, reaffirmed by D4).

### 2.4 Notification preference column

```sql
alter table public.notification_preferences
  add column if not exists push_maintenance_resolved boolean not null default true;
```

The 0265 muteable-ping recipe, exactly as the four 0314 columns (0314:407-412). Fail-open: only an explicit `false` mutes.

### 2.5 pgTAP (`supabase/tests/0317_maintenance_resolved.test.sql`)

Asserts at minimum: the CHECK accepts `'resolved'` and rejects a garbage status; the five new columns exist with their constraints; a requester CANNOT update their own resolved row (42501/zero rows) while a manage-holder CAN archive it; a cancelled row is now archivable by manage; a viewer-requester CANNOT insert a `kind='resolution'` attachment on their own open request while a manager can; the attachments INSERT policy refuses any kind on a resolved parent; `push_maintenance_resolved` exists with default true; the 0316 unique index still exists (guard against accidental drop). No permission seed changes — the 0207 pgTAP count stays 119 (a comment in the test pins that expectation so a reviewer doesn't "helpfully" bump it).

---

## 3. The resolve() contract

### 3.1 Core schema (packages/core)

`packages/core/src/schemas/maintenance.ts` gains (same file as the form schema; `.strict()` per house rule):

```ts
export const maintenanceResolveSchema = z
  .object({
    note: z
      .string()
      .trim()
      .transform(sanitizeDescriptionBlock)   // newline-PRESERVING variant — the note is
                                             // multi-line content, exactly like description
      .pipe(
        z.string()
          .min(5, 'Describe how this was resolved (at least 5 characters).')
          .max(2000, 'Keep the resolution note under 2,000 characters.'),
      ),
  })
  .strict();

export type MaintenanceResolveValues = z.infer<typeof maintenanceResolveSchema>;
```

Sanitize-then-check ordering matches the shipped form schema's documented ORDERING DECISION (schemas/maintenance.ts:33-55). `.strict()` means a body smuggling `resolvedByName`, `sentAt`, or any recipient-shaped key is a hard rejection. `packages/core/src/maintenance/constants.ts` gains `MAINTENANCE_ATTACHMENT_KINDS = ['requester', 'resolution'] as const`, `type MaintenanceAttachmentKind`, and `MAINTENANCE_RESOLUTION_NOTE_MAX = 2000`.

### 3.2 Service method (`apps/web/src/server/services/maintenance-requests.ts`)

```ts
/** manage-only close-out (D1). Sets status + resolved_at + resolved_by +
 *  resolved_by_name_snapshot + resolution_note TOGETHER in one write (the
 *  archive()/cancel() lockstep discipline). Proof photos are uploaded by the
 *  dialog BEFORE this call, while the request is still open, via the
 *  attachments pipeline with kind='resolution' — resolve() itself never
 *  touches Storage. */
async resolve(id: string, input: unknown): Promise<void>
```

Mirrors `archive()`'s shape (maintenance-requests.ts:615-658) step for step:

1. `assertModuleEnabled(this.ctx, 'maintenance_requests')`; `assertPermission(this.ctx, 'maintenance_requests:manage')`.
2. Parse `input` with `maintenanceResolveSchema.safeParse` → `validation_error` on failure (first issue message, the `create()` convention).
3. Narrow pre-read (`archived_at, cancelled_at, resolved_at, requester_user_id, request_number, created_at, subject`) scoped `.eq('organization_id').eq('id')`; missing → `not_found`; any of the three stamps set → `conflict` with per-cause copy ("This request is archived." / "This request is cancelled." / "This request is already resolved.").
4. Resolver name: read own profile (`user_profiles` by `ctx.userId`, the `create()` snapshot pattern, :313-325) → `full_name || email || 'Unknown'` into `resolved_by_name_snapshot`.
5. Guarded write: `.update({ status: 'resolved', resolved_at: now, resolved_by: ctx.userId, resolved_by_name_snapshot, resolution_note, updated_at: now }).eq('organization_id', …).eq('id', id).is('resolved_at', null).is('archived_at', null).is('cancelled_at', null).select('id').maybeSingle()` — the `.is()` triplet makes the pre-read race-proof, and a zero-row result is the C2 conflict ("This request changed state…"), never fail-open.
6. `audit({ event: 'maintenance_request.resolved', entityType: 'maintenance_request', entityId: id, extra: { has_note: true, proof_photo_count } })` — **never the note text** (GC 27: audit metadata is an allow-list; the note is content like the description).
7. Share link: if the request now has ≥1 photo of ANY kind and the org's `includeShareLinksInEmail` setting allows (the shipped default-ON read, [id]/route.ts:27-39), `ensureActiveLink(id)` (the caller holds manage — always eligible), swallowing `ServiceError` to null exactly like the detail page (:137-144).
8. In-app/push: `this.emitNotify({ event: 'resolved', targetUserId: requester_user_id, … })` — fire-and-forget AFTER the audit write (the Task 21 hook shape, :218-225), **suppressed when `requester_user_id === ctx.userId` or is null** (self-resolve pings nobody, the `assignLocalOwner` self-suppression precedent :756).
9. Email: `void maybeSendMaintenanceResolvedEmail(createAdminClient(), id, { appUrl: APP_URL }).catch(reportError…)` — fire-and-forget, best-effort, at-most-once (§6). A send failure never fails `resolve()`; the status write has already committed.
10. `MaintenanceRequestDetail` gains `resolvedAt: string | null`, `resolvedByName: string | null`, `resolutionNote: string | null` (from the snapshot columns; `resolved_by` uuid stays server-side — no UI consumes it). `toListRow` unchanged — the list needs only `status`.

Adjacent method changes (all in the same file): `archive()` drops the cancelled-refusal pre-check and instead refuses only `archived_at IS NOT NULL` (D1 re-bucket, §1.3), keeping the guarded-update + C2 conflict; `cancel()` adds `if (detail.resolvedAt) throw conflict('This request is resolved and can no longer be cancelled.')`; `update()`/`recordDraftOpened()` requester closed-guards add `detail.resolvedAt`. `AuditEvent` union in `services/audit.ts` gains `'maintenance_request.resolved'`. `TIMELINE_ALLOWED_EVENTS` is NOT extended — the detail timeline renders "Marked resolved" straight off `resolved_at` (like the archived/cancelled rows, detail page :391-406), and the allow-list's own doc comment says silence is the default.

### 3.3 Attachments service changes

`MaintenanceAttachmentsService` (maintenance-attachments.ts):

- `createUploadUrl(requestId, { fileExt, originalFilename, kind })` and `finalize(requestId, { path, originalFilename, declaredMime, kind })` — `kind` optional, default `'requester'`, validated against `MAINTENANCE_ATTACHMENT_KINDS`. `kind === 'resolution'` additionally requires `can(ctx, 'maintenance_requests:manage')` (else `forbidden`) — mirroring the RLS clause (§2.2) so the service and the DB agree.
- Both cap counts add `.eq('kind', kind)` (per-kind cap of `MAINTENANCE_MAX_PHOTOS`).
- `assertParentOwnedAndOpen` adds `resolved_at` to its select + closed check ("This request is closed; photos can no longer change." — copy unchanged, cause widened).
- `signedViewUrls` selects `kind` and `SignedMaintenancePhoto` gains `kind: MaintenanceAttachmentKind` so the detail pages can split the sections. Ordering unchanged (`sort_order, created_at`) — the panels group by kind in JS.
- `remove()` unchanged except the widened parent-closed diagnosis; removing a proof photo pre-resolve is legal for the manage-holder who staged it (dialog "remove before confirm" affordance).

The attachment REST routes (`[id]/attachments/route.ts` + `finalize/route.ts`) add the optional `kind` enum field to `mintSchema`/`finalizeSchema` and forward it — one field each, no other route change; the web photos panel and mobile `maintenance-upload.ts` both thread `kind` through their existing mint/finalize bodies.

---

## 4. Proof photos on the detail page and the share page (D2)

### 4.1 Web detail page

`[id]/page.tsx` splits `photos` by `kind`:

- The existing "Photos (N)" card renders `kind === 'requester'` rows only (editable pre-close via `MaintenancePhotosPanelClient`, read-only after, exactly as shipped).
- A new "Resolution proof (N)" card renders `kind === 'resolution'` rows, read-only always (they exist only on resolved-or-about-to-be-resolved requests), with the caption "Added by the team when this request was marked resolved."
- A new "Resolution" card (rendered only when `detail.resolvedAt`) shows the note verbatim (`whitespace-pre-wrap`, like the description) and "Marked resolved by {resolvedByName} · {relative time}".
- The StockPilot-activity timeline gains a "Marked resolved" row off `resolved_at` (same `<dl>` shape as the archived/cancelled rows).

### 4.2 Public share page + photo proxy

`ResolvedMaintenanceShare.photos` (maintenance-share-links.ts:84-91) gains `kind` per entry, and the projection gains `resolution: { note: string; resolvedAtDisplay: string } | null` — **no resolver name on the anonymous surface** (the allow-list posture: DC4/Andrew need the evidence and the outcome, not a staff directory; the requester's email is where the name belongs). `fetchValidAttachments` adds `kind` to its select and keeps its single ordering (`sort_order` asc, with `created_at` asc appended as an explicit tiebreaker so the page/proxy index contract is deterministic for same-sort_order rows — both callers share the one function, so indices cannot drift, the shipped m4 invariant). The page renders two labeled sections — "Photos" (requester) and "Resolution proof" — each `<img>` still `/m/{token}/photo/{i}` where `i` is the index in the ONE combined list; the proxy route is unchanged except that `resolveMaintenanceSharePhoto` passes `kind` through (the proxy itself does not care).

When resolved, the share page header adds a "Marked resolved" line + date + the note under an "Resolution" heading. The footer disclosure stays; the page never says anything about the Zendesk ticket's state.

---

## 5. Notifications (D3 channel a)

`maintenance-notify.ts`:

- `MaintenanceNotifyEvent` gains `'resolved'`.
- `EVENT_PREF_KEY` gains `resolved: 'push_maintenance_resolved'` (literal string, the module's own convention :56-61).
- `titleFor` gains `case 'resolved': return `Maintenance request ${requestHandle} marked resolved`;` — "marked resolved", never "resolved by DC4"/"ticket closed" (§9 vocabulary).
- Targeted event (like `assigned`): single `targetUserId` = the requester, pref-gated fail-open via the existing `loadPrefFlags`, delivered through `createNotification` with `link: '/dashboard/maintenance/${requestId}'` — the exact literal the shipped mobile `web-path-rewrite.ts` maintenance rules already translate (verified: `/dashboard/maintenance/<uuid>` → `/maintenance/<uuid>`, web-path-rewrite.ts). Push rides the 0028 AFTER-INSERT trigger; nothing new is built there.
- `lib/notification-prefs.ts` `NOTIFICATION_PREF_KEYS` gains `'push_maintenance_resolved'`; the `TOGGLE_DEFS` array in `components/settings/notification-preferences-form.tsx` gains one `group: 'push'` entry — label "Maintenance request resolved", hint "In-app notification when a maintenance request you submitted is marked resolved."

The reminder cron (`api/cron/maintenance-draft-reminders/route.ts`) already filters `.eq('status', 'saved')`, so a resolved request naturally exits reminder eligibility; for lockstep symmetry with its existing `.is('archived_at', null).is('cancelled_at', null)` hedge (:133-134) it also gains `.is('resolved_at', null)`.

## 6. The resolution email (D3 channel b)

### 6.1 Registry + template

The es email system (`apps/web/src/lib/email/es/`) gains one registry row and one family file:

- `EsEmailFamily` gains `'maintenance'`; `ES_EMAILS` gains id `'maintenance-resolved'`, family `'maintenance'`, status `'live'`, category `'ess'` (a one-time transactional record notice, the `support-resolved` classification — NOT preference-footer: the muteable pref in D3 is explicitly the in-app/push channel; the email is at-most-once by construction and carries the `ess` footer), tag `'Maintenance'`, from `'StockPilot <maintenance@stockpilotusa.com>'` (Resend accepts any sender on the verified domain — resend.ts:20-23), subject `(p: { handle: string }) => `Maintenance request ${p.handle} marked resolved``, preheader `(p: { resolverName: string }) => `Recorded by ${p.resolverName} in StockPilot. The resolution note and any proof photos are inside.``, badge `{ variant: 'ok', label: () => 'Marked resolved' }`, cta `'View request'`, motionAsset `'check'` (exists in the produced set), footer `'ess'`.
- `families/maintenance.ts` exports `MAINTENANCE_RESOLVED_FROM` and `renderMaintenanceResolvedEmail(params): { subject: string; html: string; text: string }`. Built from the shared component layer (`brandStrip`/`statusPill`/`headline`/`bodyText`/`detailRows`/`verbatimMessage`/`ctaRow`/`footer`/`emailShell` — the `support.ts` family is the structural template). Archetype dark-block byte-fidelity and no-ink-classes-on-tonal-fills rules apply as everywhere in `es/`; `assertEmailWeight(html)` before return.

### 6.2 Content contract (binding)

| Slot | Content |
|---|---|
| Subject | `Maintenance request MR-2026-000123 marked resolved` (handle from `formatMaintenanceRequestNumber`) |
| Greeting/lead | `Hi {requesterFirstName} —` fallback `Hi —` (support-family convention); headline lead "Marked resolved." with the request subject as the serif turn |
| Resolver line | `Marked resolved by {resolverName}` — the display-name snapshot, verbatim, escaped |
| Note | The resolution note **VERBATIM** — `escapeHtml` + `\n → <br>`, rendered in the `verbatimMessage` block under an eyebrow "Resolution note — verbatim". Never truncated, never paraphrased |
| Proof photos | Up to 4 `<img>` elements whose `src` is the ABSOLUTE share-proxy URL `${APP_URL}/m/{token}/photo/{n}` for each `kind='resolution'` attachment (n = its index in the shared ordering contract, §4.2), width-capped, alt = safe filename; a "+N more photos on the request" line when >4. **Never a signed Storage URL** — signed URLs cap at short TTLs and are irrevocable once emailed (landmine 23 / audit Q7); the share proxy lives 180 days and dies with `revoke()`. When no active share link exists (org setting `includeShareLinksInEmail` off, or minting failed), the email renders "{N} proof photos are on the request in StockPilot." instead of images — honest fallback, since the CTA link reaches them anyway |
| Detail rows | Request (handle + subject, strong) · Resolved ({org-formatted datetime}) · Recorded by ({resolverName}) |
| CTA | `View request` → `${APP_URL}/dashboard/maintenance/{id}` |
| **Honesty line** | Verbatim, as a distinct body paragraph directly under the note, and repeated as the footer reason: **"This resolution was recorded by your team in StockPilot. It does not close or update the Zendesk ticket — replies and ticket status stay in the Outlook/Zendesk email conversation."** Exported as `MAINTENANCE_RESOLVED_HONESTY_LINE` and literal-pinned in tests |
| Footer | `ess` footer; reason = the honesty line's first sentence + "sent once when a request you submitted is marked resolved." No unsubscribe machinery (essential category) |

Known rendering caveat, recorded not solved: masters may be WEBP (one of the three bucket types), and Outlook desktop's Word engine does not render WEBP — the alt text + CTA are the fallback. In practice both platforms transcode uploads to JPEG (HEIC→JPEG on web, forced JPEG on mobile), so WEBP masters are rare. Thumbnails are always WEBP and are therefore NOT used in the email.

### 6.3 At-most-once sender

`apps/web/src/server/email/maintenance-resolved.ts` — the `return-prompt.ts` twin, module-for-module:

```ts
export type MaintenanceResolvedEmailResult =
  | { sent: true }
  | { sent: false; reason:
      | 'request_not_found' | 'not_resolved' | 'no_requester_email' | 'self_resolve'
      | 'already_sent' | 'lost_race' | 'send_failed' | 'error' };

export async function maybeSendMaintenanceResolvedEmail(
  admin: SupabaseClient, requestId: string, opts: { appUrl: string },
): Promise<MaintenanceResolvedEmailResult>
```

Guard order (each silent-skip): row exists → `status === 'resolved'` (and `resolved_at` set) → `requester_email_snapshot` non-null → `requester_user_id !== resolved_by` (self-resolve sends nothing — you don't email someone about their own click; both channels suppress identically) → cheap `resolution_email_sent_at` pre-check → **the authoritative guarded claim**: `.update({ resolution_email_sent_at: now }).eq('id', requestId).is('resolution_email_sent_at', null).select('id').maybeSingle()` — only the winner proceeds; a raced duplicate returns `lost_race`. Photo/link assembly happens AFTER the claim; if `sendEmail` then fails, **the marker deliberately stays set** (missed-email-over-duplicate, the documented returns posture — the content remains fully reachable at the CTA URL). Best-effort: never throws; failures `reportError` and resolve.

Transport: `sendEmail` from `@/lib/email/resend` — the ONE seam. Never the Supabase built-in mailer (capped ~2/hr, fails silent — the auth-emails landmine), never a direct fetch to Resend. **Test law: every test of this module stubs the seam with `vi.hoisted(() => vi.fn())` + `vi.mock('@/lib/email/resend', () => ({ sendEmail: sendEmailMock }))` — the exact `return-prompt.test.ts:22-25` pattern. No test anywhere in this program may compose toward or send to a real address; `sendEmail`'s no-key dry-run is NOT an acceptable substitute for the stub.**

---

## 7. API routes (mobile parity surface)

Shipped today under `api/v1/maintenance-requests`: GET/POST list-create, GET/PATCH `[id]`, POST `[id]/draft-opened`, POST/DELETE `[id]/share-link`, attachments mint/finalize/delete. **Missing for D5 and added by this program** (all `withApiContext` Bearer routes, uuid-validated ids at the edge, `serviceErrorStatus` mapping, delegating wholly to the services — the `[id]/route.ts` conventions):

| Route | Methods | Body / response |
|---|---|---|
| `[id]/resolve/route.ts` | POST | `{ note: string }` (re-parsed by the service via `maintenanceResolveSchema`) → `{ ok: true }` |
| `[id]/archive/route.ts` | POST | no body → `{ ok: true }` |
| `[id]/assign-owner/route.ts` | POST | `{ userId: string \| null }` → `{ ok: true }` |
| `[id]/notes/route.ts` | GET / POST | GET → `{ notes: […listNotes() shape] }`; POST `{ body: string }` → `{ id }` (service enforces manage-only both ways) |
| `members/route.ts` | GET | manage-gated; `{ members: { userId, name }[] }` — the web detail page's `fetchAcceptedMembers` query, exposed for the mobile owner picker. Static segment wins over `[id]` in the App Router; ids are uuid-validated anyway |
| `[id]/route.ts` GET | (modified) | response `request` carries the three new detail fields; `photos[]` gains `kind` |
| attachments mint/finalize | (modified) | optional `kind` field, §3.3 |

The GET list route needs **zero changes** for the new status filter (`STATUS_VALUES` derives from the labels record). The mobile list wrapper gains an optional `status` param it forwards.

## 8. Web UI

- **Resolve dialog** (`components/maintenance/resolve-request-dialog.tsx`): opened from the detail actions row. Required multi-line note (client hint of the 5-2000 bounds; server is the authority), an optional proof-photo area reusing `MaintenancePhotosPanel` with a new `kind="resolution"` prop (photos mint/PUT/finalize immediately, pre-flip, so a dialog cancel leaves removable proof rows on the still-open request — the panel's existing remove affordance handles that; disclosed in the dialog), and a confirm button calling the new `resolveMaintenanceRequestAction(id, { note })` (`actions/maintenance-requests.ts`, standard ActionResult + revalidate both paths). Dialog copy: "Marks this request resolved in StockPilot and emails {requesterName} the note and any proof photos. It does not close or update the Zendesk ticket."
- **Detail actions row** (`detail-client.tsx` / `[id]/page.tsx:220-224`): `showResolve = canManage && !closed` (closed now includes `resolvedAt`); `showArchive = canManage && !detail.archivedAt` (widened per §1.3 — Archive stays available on resolved/cancelled rows as the tidy-up); `showCancel = isOwningRequester && !closed` (unchanged semantics, `closed` widened). The Archive confirm copy updates to "Use this to tidy up old resolved or cancelled requests, or duplicates." (the shipped sentence "requests that are already resolved" predates a real resolved state).
- **List page**: zero structural changes (§1.1); badge variant `resolved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'`; label-pin tests updated.
- **Settings**: one new TOGGLE_DEFS row (§5). No new settings page surface.

## 9. Mobile scope (D5) — pure JS, OTA-safe

All changes are `.ts`/`.tsx` in already-shipped files or new pure-JS siblings; **no new native modules; `package.json`/lockfile diffs must be empty** (gate-checked). Existing binary 1.1.0 already contains everything used (expo-image-picker/camera/image-manipulator/file-system — the Task 19 OTA verdict).

- **Status parity**: `STATUS_PILL` gains `resolved: 'ok'` on both the list and detail screens; labels flow from `MAINTENANCE_STATUS_LABELS` automatically. The list screen gains a status chip row (Active · Resolved · Archived · Cancelled + All) driving a new `status` param on `listMaintenanceRequests` (the route already accepts it).
- **Detail parity**: Resolution card (note verbatim + "Marked resolved by {name}"), proof photos section labeled "RESOLUTION PROOF" split by the new `kind` field on `MobileMaintenancePhoto`, detail mirror gains `resolvedAt`/`resolvedByName`/`resolutionNote` (field-for-field mirror rule — never partial payloads).
- **Close-out actions** (rendered only when the GET response's existing `canManage` flag is true, and gated by request state exactly like web):
  - **Resolve**: an inline expanding card (the `copyOpen` selectable-TextInput pattern — no new dialog dependency): multi-line note `TextInput`, "Add proof photo" via the existing `maintenance-upload.ts` orchestration with `kind: 'resolution'` threaded into mint/finalize, per-photo progress/retry exactly as `new.tsx`, confirm → `resolveMaintenanceRequest(id, note)`.
  - **Archive**: `Alert.alert` confirm → `archiveMaintenanceRequest(id)`.
  - **Assign owner**: member rows fetched from `GET members` on card expand; tap to assign / clear → `assignMaintenanceOwner(id, userId | null)`.
  - **Internal notes**: list + add card (manage-only; fetched lazily so non-managers never trigger the call), `listMaintenanceNotes`/`addMaintenanceNote`.
- All new `maintenance-api.ts` wrappers keep the shipped contracts (409-not-429 on rate limit; `ApiError` on non-2xx). Screen logic that makes decisions is extracted into tested pure helpers (the Task 18 lesson — RN screens cannot render under this repo's vitest, so source-pin-only tests are not acceptable for decision logic).
- Simulator hand-test is owed after the mobile tasks per the owner rule — with the standing caveat that the current dev client has a pre-existing boot crash (infra track); the plan's walk task records whichever is achievable honestly.

## 10. Test strategy per layer

| Layer | Vehicle | Load-bearing assertions |
|---|---|---|
| DB | pgTAP 0317 (after `supabase db reset` — local stack needs the reset before new migs) | §2.5 list; RLS matrix for resolved-closed writes and the kind clause; archive-of-cancelled now allowed |
| Core | vitest (`packages/core`) | resolve schema: `.strict()` rejection of extra keys, sanitize-then-check (control-byte note accepted at post-sanitize length), 5/2000 bounds LITERAL-pinned; labels record pins all five literals; status union exhaustiveness via `Record<MaintenanceStatus, …>` compile checks |
| Web services | vitest + `supabase-mock` (`chains`/`chainArgs` query-shape pinning — the mock replays canned rows and ignores filters, so every `.eq`/`.is` guard is pinned by call-recording, and the logic under test lives in JS) | resolve happy path writes all six columns in ONE update with the `.is()` triplet pinned; conflict per prior stamp; self-resolve suppression; archive-accepts-resolved/cancelled + preserves stamps; per-kind cap `.eq('kind', …)` pinned on mint AND finalize; kind='resolution' requires manage |
| Email | vitest, transport stubbed at the seam (`vi.mock('@/lib/email/resend')`, §6.3 — mandatory in every suite that can reach a send) | honesty line LITERAL-pinned in html AND text; note verbatim (escaped, `<br>` newlines); proxy-URL shape `${APP_URL}/m/<token>/photo/<n>` literal-pinned; NEVER a supabase.co/storage/sign URL in the html (negative grep); guarded-claim-first ordering (claim update recorded BEFORE sendEmail call); marker-stays-on-failed-send; self-resolve skip; forbidden-phrase sweep over the rendered html/text/subject (§11 list) |
| Routes | vitest route tests (the `[id]/route.test.ts` conventions) | uuid edge validation; status mapping; notes/members manage gating; `kind` forwarding |
| Web UI | component tests, `document.body` sweeps for all dialog states (Radix portals — the Task 14 lesson) | dialog requires note; action argument pinned; §11 sweep across default/open/success/error states; archive copy update pinned |
| Mobile | vitest on extracted helpers + api wrappers; source pins only for pure rendering | wrapper URL/method/body pins incl. literal route paths; status-chip → `status` param mapping; kind threading in upload orchestration |
| E2E posture | scripted manual authed browser walk (no Playwright CI gate exists): resolve a Demo-Co request whose requester IS the demo account, with the local stack (no `RESEND_API_KEY` → dry-run) — **no real email may ever leave a walk**; verify pill, detail, share page proof section, at-most-once stamp in the DB | recorded in the verification log with real command output |

Anti-tautology rule (GC 19 carried forward): every cross-task contract value — the pref key `push_maintenance_resolved`, the five status literals, the label strings, the honesty line, the sender `maintenance@stockpilotusa.com`, the subject shape, route paths, the kind literals, the 2000 cap — gets at least one literal-string pin per suite, never only a comparison against the same imported constant the implementation reads.

## 11. Vocabulary (user-facing copy rules)

The §20/GC-8 discipline continues, amended for the one thing that changed: **StockPilot now has a real, locally-recorded resolution state, so "resolved" language is legitimately available FOR THAT STATE** — because it describes a StockPilot record a human made, not an observation of Zendesk.

**Allowed** (and only in these shapes):
- `Resolved` (the status label/pill/filter), `Marked resolved`, `marked resolved by <name>`, "recorded by your team in StockPilot", "resolution note", "resolution proof".
- The resolution note's own content is the author's verbatim text (e.g. the owner's "The issue for the leaking roof tile has been resolved.") — user content is never vocabulary-policed, only product copy is.

**Forbidden, unchanged and extended** — never in any product copy, status, notification, or email: `Email sent`, `Ticket created`, `Request submitted to Zendesk`, `DC4 notified`, `Andrew notified`, `Ticket assigned`, and NEW: `Ticket closed`, `Ticket resolved`, `Zendesk ticket closed/updated/resolved`, `Issue verified fixed`. StockPilot can observe none of these. The forbidden-phrase sweep tests at every rendering layer (list, detail, dialog states, share page, notification titles, email html+text+subject, mobile screens' extracted copy constants) extend their banned arrays with the new phrases; the sweeps' own arrays remain the only place the phrases may appear in source.

The honesty line (§6.2) is the canonical sentence pair for the email and the resolve dialog's disclosure derives from it. The status badge for `resolved` says `Resolved` — acceptable because the state IS a StockPilot record; every surface that elaborates says "marked resolved", never a claim about the ticket.

## 12. Consequences audited against the shipped code (things that resist, honestly)

1. **`fetchValidAttachments` ordering tiebreak** — the shipped share funnel orders by `sort_order` only; all rows default `sort_order = 0`, so page/proxy index stability today rests on Postgres's unguaranteed tie order. Adding `created_at` as an explicit secondary (§4.2) fixes a latent wobble but can renumber `/m/<token>/photo/<n>` URLs already embedded in old Outlook drafts for multi-photo requests where the DB happened to return a different tie order. Accepted: the URLs are page-relative indices re-derived on every page render (the share PAGE always agrees with the proxy), only a hand-copied bare photo URL could shift by one.
2. **Archive-of-cancelled reverses a shipped guard** (the M1 conflict) — deliberate, owner-decided (§1.3); the pgTAP + service tests flip accordingly, and the fix-wave history in the ledger is acknowledged rather than silently contradicted.
3. **`maintenance-api.ts`'s binding contract comment says the list route takes no params beyond scope/q** — it already takes `status` on the server; the mobile comment is simply stale and is corrected when the wrapper gains `status`.
4. **Outlook + WEBP** (§6.2 caveat) — recorded, mitigated by alt text + CTA, not solved.
5. **Proof uploads land before the status flip**, so a crashed/cancelled dialog leaves `kind='resolution'` rows on an open request. They are visible (labeled) and removable by the manage-holder; resolve() reports `proof_photo_count` from a live count, not dialog state. Accepted over a staging-table design that would fork the attachment pipeline D2 says to reuse.

---

Companion plan: `docs/superpowers/plans/2026-08-06-maintenance-resolved.md`.
