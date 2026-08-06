# Maintenance Requests — Phase 1 Repository Audit (2026-08-05)

Owner brief: `.superpowers/sdd/maintenance-requests-brief.md`. This audit is the evidence base the
implementation plan is built from. Eight subsystem audits were run with file:line verification;
where auditors disagreed, the code was re-read and the disagreement resolved with evidence (noted
inline as RESOLVED). All line numbers were verified against the working tree at commit 97bdd03d.

---

## 1. Executive summary

**What exists and is reusable.** The hard, owner-tested part of this feature — the Outlook compose
transport — is already shipped and byte-pinned in the delivery-request assistant:
`OUTLOOK_COMPOSE_BASE = 'https://outlook.cloud.microsoft/mail/deeplink/compose'`, the single
`mailtouri=` param form (plain `cc=` is silently dropped by OWA — owner-tested on the live L4L
tenant 2026-08-01), %20-based `encodeDraftQuery` (never URLSearchParams), name-addr display chips,
`DRAFT_URL_LIMIT = 1800`, and the full fallback-chain component (popup-blocked mailto, clipboard,
selectable textarea, duplicate-draft warning, dual aria-live regions)
(`apps/web/src/components/orders/storefront/storefront-logic.ts:577-789`,
`delivery-request-action.tsx:158-224`). The L4L recipient addresses the maintenance module needs
(`dc4@learn4life.org` / `arosas@cvwest.org`) already live as frozen constants in
`apps/web/src/lib/site.ts:48-51`. Module gating (`organization_modules` + MODULE_REGISTRY +
resolveSurface), the configurable-permission system (registry + role/user overrides + realtime
propagation without re-login), attachment buckets with org-prefix storage RLS, signed-URL services,
client-side HEIC transcode on both platforms, the per-org advisory-lock number generator (0254),
audit/notification/cron skeletons, and complete test templates for every layer all exist and are
mapped below.

**What must be built.** Everything maintenance-shaped is net-new: the module id + 4 permissions +
migration (tables, RLS, seed rewrite, pgTAP bump), the `MR-` number clone, the shared
`createOutlookComposeEmail` utility (the transport is currently welded to `DeliveryRequestDraft`
and module-private; it must be extracted into `packages/core` because mobile can only import
`@stockpilot/core` — RESOLVED, see §2.1), the pure `createMaintenanceRequestEmail` builder, all
web/mobile routes and screens, a request-scoped revocable share-link system (no precedent — 0261
is the nearest analog), upload-time magic-byte MIME verification and upload rate limiting (neither
exists anywhere), draft-open persistence (`outlook_draft_opened_at` / `open_count`), and mobile
deep-link rewrite rules.

---

## 2. Per-subsystem findings

### 2.1 Delivery-request Outlook compose workflow (the transport to extract)

The binding mechanics — each one an owner-proven correction of a naive approach:

- **Endpoint**: `OUTLOOK_COMPOSE_BASE = 'https://outlook.cloud.microsoft/mail/deeplink/compose'`
  (`storefront-logic.ts:577`; corrections history 550-576). `outlook.office.com` now bounces
  through a domain-migration redirect that drops the compose path (owner hit it live 2026-08-02).
  Pinned by `storefront-logic.test.ts:1037-1041`.
- **Param form**: a single `mailtouri=` param whose value is
  `encodeURIComponent('mailto:<encoded to>?<encodeDraftQuery({cc,subject,body})>')` — exactly two
  encoding layers, each applied once (`storefront-logic.ts:675-685`). Plain `to=/cc=/subject=/body=`
  params are asserted ABSENT by tests (`storefront-logic.test.ts:1043-1070`), because OWA silently
  drops a plain `cc=` (owner live-tenant test 2026-08-01, history at 607-674).
- **Encoding**: `encodeDraftQuery` is `k + '=' + encodeURIComponent(v)` joined with `&` —
  deliberately NOT URLSearchParams, whose `+`-for-space form-encoding is rendered literally by
  RFC 6068 mailto clients (`storefront-logic.ts:592-604`). It is module-PRIVATE (no export) — the
  extraction must export or relocate it. Byte pins: `%20` never `+` at test 1077-1091, 1157-1169,
  1217-1229.
- **Display-name chips**: To rides in the mailto PATH position as name-addr
  (`Fresno Warehouse DC4 <dc4@learn4life.org>`) — an OWA-only parser extension; Cc name-addr rides
  in the RFC-legal `cc=` value. `buildMailtoUrl` and `buildClipboardText` deliberately stay
  bare-address (untested on desktop clients — a documented do-not-extend boundary,
  `storefront-logic.ts:625-664`; names constant `lib/site.ts:85-88` with the RFC 5322 specials
  warning at 73-83).
- **window.open**: called with NO features string — `'noopener'` makes the spec return null EVEN ON
  SUCCESS, which is the exact blocked-popup signal the fallback chain keys on; the component severs
  `opened.opener = null` manually in try/catch (`delivery-request-action.tsx:168-182`; pinned by
  test 202-219 asserting the third arg is `undefined`).
- **Fit measurement**: `prepareDeliveryRequest` measures both URLs against `DRAFT_URL_LIMIT = 1800`,
  auto-condenses once, and sets `linkFits` (`storefront-logic.ts:760-789`). `clipboardText` is
  ALWAYS built from the FULL draft even when the URLs are condensed (:771, :786; test 1322-1333).
  `linkFits=false` opens NOTHING — not even mailto — because both transports truncate silently
  (`delivery-request-action.tsx:159-165`; test 463-491, 821-875).

**Generalizable vs order-specific**: the transport core (~115 lines: constant, limit,
`encodeDraftQuery`, the three builders' mechanics, the measure-then-degrade pattern) reads only
`{to, cc, subject, body}` plus the names constant. Order-specific and staying behind:
`DeliveryRequestInput`, `buildDeliveryRequestDraft` (all block assembly, 435-548), the condense
POLICY (what to drop is domain policy; the measuring pattern generalizes), and the component's
storefront wiring (sf-* CSS, z-[100] override for the storefront modal's z-90 backdrop, order copy).

**Blast radius**: only three non-test consumers exist (storefront-logic itself,
delivery-request-action.tsx via `prepareDeliveryRequest`, lib/site.ts doc comments; zero mobile
consumers) — one call-site file to migrate, four pinning test files to keep green
(storefront-logic.test.ts, delivery-request-action.test.tsx, site.test.ts, storefront-overlays.test.tsx).

**RESOLVED (cross-auditor conflict) — home of the shared utility**: the delivery auditor suggested a
client-safe module in apps/web; the mobile auditor required `packages/core`. Verified:
`apps/mobile/package.json:29` — mobile's ONLY shared workspace dependency is
`"@stockpilot/core": "workspace:*"`; mobile cannot import from apps/web. The §30
`createOutlookComposeEmail` utility must land in `packages/core` (plain TS, no `'use server'` /
`'server-only'`, importable by client components on both platforms), with the delivery exports kept
as thin delegating wrappers in `storefront-logic.ts` so all four pinning test files stay green
unchanged.

**What the shared utility needs beyond a move** (per the delivery auditor, confirmed against the
code): (1) export the currently-private `encodeDraftQuery`; (2) parameterize the builders on
`{to, cc?, subject, body}` plus OPTIONAL toName/ccName — `buildOutlookComposeUrl` currently
hard-reads `DELIVERY_REQUEST_EMAIL_NAMES` (:676-677), so names become parameters, with names
either restricted to literal-constant callers or RFC-5322-quoted/validated (site.ts:73-83 hazard);
(3) cc-optional is NEW behavior — every current builder unconditionally emits cc; omit-when-absent
needs its own tests; (4) keep fit measurement in the util, leave condensing policy to the domain
builder; (5) preserve the invariant that domain draft builders take NO recipient argument
(storefront-logic.ts:421-428; test 536-554) — each wrapper reads its own frozen constant at exactly
one hardcoded call site.

### 2.2 Module gating + permissions + RLS conventions

- `organization_modules`: PK (organization_id, module_id), enabled bool, tier check, `settings`
  jsonb; `module_enabled(p_org, p_module)` is STABLE SECURITY DEFINER granted to authenticated
  (`supabase/migrations/0144_org_modules_entitlements.sql:22-67`).
- TS registry is the single catalog: `ModuleId` union + `MODULE_REGISTRY` with placements carrying
  `requires`/`requiresAnyOf`/`requiresAdmin`; web sidebar and mobile drawer both derive 1:1 via
  `resolveSurface` (`packages/core/src/modules/registry.ts:27-76`,
  `packages/core/src/modules/resolve.ts:63-106`, `apps/web/src/components/dashboard/nav.ts:57-77`).
- Server gates: page-level `checkModuleAccess()` (fails CLOSED,
  `apps/web/src/lib/modules/module-gate.ts:18-33`) and service/API `assertModuleEnabled(ctx, id)`
  → ServiceError `module_disabled` → 403 (`apps/web/src/server/services/context.ts:208-227`).
- STALE seeded expectation corrected: `useEnabledModules` exists ONLY on mobile
  (`apps/mobile/src/lib/enabled-modules.ts:71-91`, fed by the snapshot endpoint); web is
  server-derived via `navForRole`.
- New-module migration recipe = the sports template
  (`supabase/migrations/0297_sports_module.sql`): grandfather enabled=false rows for every org;
  rewrite `seed_org_modules()` WHOLESALE from the latest body + the new row; seed
  `role_default_permissions`; flip enabled=true for one org (0174 pattern). L4L org id is
  `63c13e64-92a6-4ea4-9936-6a2c26a85b4a` — verified in two independent sources
  (`apps/web/src/app/api/cron/prewarm-orders-catalog/org-sweep.ts:18` and
  `supabase/migrations/0031_reset_l4l_fresno_test_data.sql:3,31`); one-line prod confirm still
  advisable before hardcoding into the migration.
- Permission system: `PERMISSIONS` + `ROLE_PERMISSIONS` + `effectivePermissions` (owner
  short-circuit) + `FULLY_GRANTABLE_PERMISSIONS` + `PERMISSION_META`
  (`packages/core/src/constants/permissions.ts`); SQL mirror `has_permission()` (0207, rewritten by
  0310 to also fail for disabled accounts/expired impersonation); write RLS is ADDITIVE:
  `has_org_role(org,'manager') OR has_permission(org, perm)` (0208:8-39). pgTAP pins
  `role_default_permissions` at exactly **111 rows** with an itemized provenance message
  (`supabase/tests/0207_permission_overrides.test.sql:41-45`).
- Andrew's grant needs ZERO new code: once the permissions are registered they appear in the
  per-user exceptions matrix at `/dashboard/settings/roles`
  (`apps/web/src/server/actions/permissions.ts:189-258`,
  `role-permission-matrix.tsx:112-116,346-391`); changes propagate live via
  `broadcastPermissionsChanged` → web `PermissionsRealtime` router.refresh / mobile
  `usePermissionsRealtime` (`apps/web/src/lib/realtime/broadcast.ts:10-29`,
  `apps/mobile/src/lib/use-permissions-realtime.ts:23-56`) — brief §6's
  no-re-login requirement is already solved.
- A true platform super-admin exists (`/platform`, STOCKPILOT_PLATFORM_ADMIN_EMAILS + AAL2), but
  per-user grants are org-level — brief §6's "God Admin" maps to the L4L owner using the per-user
  exceptions UI, not `/platform`.
- No existing RLS policy calls `module_enabled()` — module gating today is app-layer only; RLS-level
  module gating is technically possible (function is SECURITY DEFINER, granted) but new ground.
- `organization_modules.settings` jsonb is the established home for per-module config (b2b_portal
  pricingMode precedent, `apps/web/src/app/(dashboard)/dashboard/customers/page.tsx:41-57`).

### 2.3 File/photo upload infrastructure

- **Clone target**: the order-attachments trio — `0142_order_attachments.sql` (private bucket,
  `{org_id}/{record_id}/{uuid}.{ext}` path convention, storage RLS keyed on
  `(storage.foldername(name))[1]::uuid`), 0143's bucket MIME/size pins,
  `apps/web/src/server/services/order-attachments.ts` (30d signed URLs cached 25d via
  unstable_cache, throw-on-failure, org-prefix re-assertion in `add()`).
  `0260_support_ticket_attachments.sql` is the requester-scoped alternative (insert-only own-folder
  policy, no select policy, service-role signed reads).
- **Image pipeline**: web `compressImageVariants` (2048px WebP master + thumb + LQIP, heic2any
  HEIC→JPEG in a worker, `apps/web/src/lib/image-variants.ts:192-239`); mobile `resizeForUpload`
  (1600px JPEG q0.85, forced HEIC transcode, `apps/mobile/src/lib/image-resize.ts:18-60`); mobile
  uploads MUST use `fetch(uri).arrayBuffer()` — `blob()` uploads 0 bytes in RN (documented at every
  call site, e.g. `po-attachments.tsx:133-134`). Object-then-row with rollback on RLS-rejected
  metadata insert (`po-attachments.tsx:128-171`).
- **VERIFIED DRIFT (re-read, real)**: `image-variants.ts:29` `THUMB_DIMENSION = 400` but
  `image-variants.worker.ts:20` still `= 200`, and the worker path wins on all modern browsers —
  new uploads actually get 200px thumbs. Anyone cloning this pipeline inherits it; fix or knowingly
  accept.
- **Nothing validates real bytes at upload time**: bucket `allowed_mime_types` checks only the
  DECLARED Content-Type; the only magic-byte parser in the repo is `readImageDimensions`
  (`apps/web/src/lib/inventory-export-xlsx.ts:58-95`, PNG/JPEG signature walk) and it lives in the
  export read path. Brief photo test 6 (fake MIME rejected) requires new code.
- **No upload rate limit exists**: web uploads go browser→storage directly with the user JWT,
  bypassing Next entirely (`order-attachments-panel.tsx:117`). The rate-limitable chokepoint
  pattern is `ItemImagesService.createUploadUrl()` (`item-images.ts:762-809`: presigned mint after
  in-org entity check + extension allowlist) + DB-backed `checkRateLimit`
  (`apps/web/src/lib/rate-limit.ts:5-84`; multi-key closed-mode usage in
  `support-tickets.ts:55-119`).
- **Share-link precedent**: `public_request_links` (0261) — 256-bit hex token via
  crypto.getRandomValues, unique + length CHECK 16-128, active flag + expires_at, `rotateToken()`
  revocation, full audit, cache invalidation (`apps/web/src/server/services/public-links.ts:126-134,
  406-454, 780-788`); anonymous token-gated GET template with generic 404s and per-IP/per-token
  closed-mode limits (`apps/web/src/app/api/v1/public/order-requests/[id]/route.ts:13-62`).
  Nothing today issues a token scoped to ONE request — net-new table required.
- **Storage policy hardening**: 0312's inline disabled-account guard must be appended to new write
  policies (`account_is_disabled()` EXECUTE is revoked from authenticated, so only the inline
  `not exists (... disabled_at is not null)` form works — 0312:50-61).
- Returns/RMA have NO attachment infrastructure (verified: zero storage/bucket hits in the returns
  migration wave) — the seeded pointer is answered: nothing there to reuse.

### 2.4 Request numbering + audit + notifications

- **Numbering**: SO-000021 is a per-org bigint assigned by a BEFORE INSERT trigger serialized via
  `pg_advisory_xact_lock(hashtext('order_number:'||org_id))` + `coalesce(max)+1` + unique index
  (org, number), with explicit-number passthrough
  (`supabase/migrations/0254_order_request_numbers.sql:38-67`). Display formatting is separate:
  `formatOrderNumber` in `packages/core/src/orders/order-number.ts:6-9`. Do NOT clone
  `next_po_number` (0005:103-116 — count(*)+1, no lock, collides and reuses) or the returns
  RMA-random handle. MR recipe = clone 0254 + a `formatMaintenanceRequestNumber` beside
  `formatOrderNumber`.
- **Audit**: `audit(payload, ctx?)` is best-effort/never-throws with allow-list metadata
  (`apps/web/src/server/services/audit.ts:305-361`); `audit_logs.event` is un-CHECKed text, so new
  `maintenance_request.*` events are a TS-union-only change (:160-172, the
  `order.delivery_request_drafted` precedent whose doc comment pins its meaning to
  "a draft was OPENED", never "sent"). The draft-opened recorder template is
  `apps/web/src/server/actions/delivery-request.ts:47-78`: zod → silent return, RLS-scoped
  visibility read via plain `createClient` (NOT `requireOrgContext` — it `redirect()`s, pattern
  #23), allow-listed metadata, outer try/catch.
- **Notifications**: `createNotification()` is the ONE code insert path (disabled-user guard,
  admin-client insert, `notifications.ts:18-95`); the 0028 AFTER-INSERT trigger is the ONE push
  path (double-push incident 2026-07-14). Muteable-pref recipe (0265/0267): one
  `notification_preferences` column + key in `NOTIFICATION_PREF_KEYS`
  (`lib/notification-prefs.ts` — a REGULAR module, never `'use server'`) + a `TOGGLE_DEFS` entry;
  gates are fail-OPEN (only explicit false mutes).
- **Mobile links**: notification `link` values are WEB paths translated SOLELY via
  `rewriteWebPath` — VERIFIED three doors, not two: `+native-intent.ts:19` (OS deep links),
  `use-push-notifications.ts:103` (push tap), `(drawer)/notifications.tsx:145` (in-app inbox); the
  file header claiming "BOTH" is stale. The `/dashboard/*` catch-all (`web-path-rewrite.ts:36`)
  silently rewrites unknown paths to home, so `/dashboard/maintenance/[id]` links dead-end on
  mobile until a REWRITES rule + native route exist.
- **Cron**: `schedule-reminders` is the skeleton (timingSafeEqual CRON_SECRET, stamp-FIRST dedupe
  via `.is(guard, null)` guarded update, shorter-window-suppresses-longer rule from the 2026-07-11
  duplicate bug, pref-gated createNotification + sendEmail with its own disabled_at re-check —
  `apps/web/src/app/api/cron/schedule-reminders/route.ts:17-227`); register in
  `apps/web/vercel.json` crons[].
- `_notify_recipients()` is role-hardcoded (owner/admin/manager) and shared by other features —
  maintenance audiences must be resolved from permission grants, never by widening that helper
  (0265:20-22).

### 2.5 Web UI conventions

- Route shape: `src/app/(dashboard)/dashboard/<feature>/{page,new/page,[id]/page,loading}.tsx`
  (cycle-counts is the exact template; returns for list+detail). Pages open with
  `checkModuleAccess` → `ModuleNotEnabled`, then `requireOrgContext` + `can()` →
  `redirect('/dashboard')` (`cycle-counts/page.tsx:26-38`).
- Forms: RHF + zodResolver with schemas in `packages/core/src/schemas/` for the big form
  (`item-form.tsx:328-338`), or useState + server action returning `{ok} | {error:{message}}` +
  sonner toast + `router.refresh()` for simple ones (`start-cycle-count-form.tsx:34-43`).
  `Field`/`Section`/`SelectField` are file-LOCAL to item-form.tsx (2248-2350) — copy, don't import.
- `DialogContent` bakes `max-w-lg` (`ui/dialog.tsx:41-43`); wide dialogs override per call site via
  className (twMerge) — precedent `'max-w-2xl z-[100]'` at `delivery-request-action.tsx:393`. The
  z-[100] exists only for the storefront modal's z-90 backdrop; a dashboard route does not need it.
- List convention: server component, `ui/table` in a `bg-card overflow-x-auto rounded-xl border`
  div, searchParams-driven Link filter pills (returns `STATUS_FILTERS`), `EmptyState`
  (required icon), `TablePageSkeleton` loading.tsx. Detail convention: returns/[id] two-col grid +
  aside Details/Timeline dl (`returns/[id]/page.tsx:94-294`).
- Settings: per-org config lives in `organization_modules.settings` read server-side +
  can()-gated client Card panel + server action (inventory-cleanup + auto-archive-panel template);
  the settings hub tile array is hand-maintained (`settings/page.tsx:13-129`) — forgetting the tile
  makes the page URL-only.
- Onboarding registries are DATA wired in three hand-maintained places: `lib/onboarding/tours.ts` +
  `ALL_TOURS` (help page) + `TOUR_ROUTES` (workflows.ts); announcements append to TOP.
- There is NO `ui/alert.tsx`; inline notices are hand-rolled dashed-border paragraphs. `sf-*`
  classes are storefront-only CSS — port delivery-request-action's LOGIC, restyle its UI in
  dashboard Tailwind.
- Member-picker query shape for the local-owner assign UI: `organization_members` embedding
  `user_profiles!user_id` filtered `.not('accepted_at','is',null)`
  (`cycle-counts/new/page.tsx:36-57`).

### 2.6 Mobile (Expo)

- Structure: `(drawer)/(tabs)` for tabs, `(drawer)/*.tsx` for drawer pages (must be explicitly
  registered as Drawer.Screen or they auto-append under the raw file path —
  `(drawer)/_layout.tsx:32-109`), root stack routes for detail/new screens registered in
  `app/_layout.tsx:226-241`.
- The **zendesk module** is the exact L4L-only optional-module precedent: tier `'optional'`,
  `defaultOnFor: []`, mobile_drawer placement (`registry.ts:651-665`); it never enters
  `DEFAULT_MODULE_IDS`, so the permissive while-loading drawer default cannot flash it into
  non-L4L orgs.
- Bearer pattern: `api()` attaches `Authorization: Bearer` + `X-Organization-Id`
  (`apps/mobile/src/lib/api.ts:89-130`); the support feature is the complete route-pair template
  (mobile form + camera/library + arrayBuffer upload + path-only POST ↔
  `apps/web/src/app/api/v1/support/route.ts:27-63` with withApiContext, zod, path-prefix
  re-assertion, closed-mode rate limit).
- Scan-result insertion point for "Report a problem": the secondaryActions row of the result sheet
  (`(tabs)/scan.tsx:885-896`) with item id/sku/name/barcode in scope. Item detail insertion:
  overview action stack (~`item/[id].tsx:1387-1421`).
- **OTA posture**: runtimeVersion.policy='appVersion', live binary 1.1.0; OTA-ing JS that imports a
  new native module crashes existing binaries (`app.config.ts:7-28`). Installed and OTA-safe:
  expo-camera, expo-image-picker, expo-image-manipulator, expo-linking, expo-file-system. NOT
  installed (native → EAS build + store release): expo-sharing, expo-media-library, and ANY
  clipboard module (no expo-clipboard, no @react-native-clipboard — verified against
  package.json:20-65). Release path is `pnpm release:ota`, never raw `eas update`.
- Mobile permission/nav updates without sign-out are already wired (`use-effective-permissions.ts`
  + `usePermissionsRealtime` mounted in drawer-content.tsx:44).
- No upload-progress or multi-photo precedent exists (every flow is `res.assets[0]` + indeterminate
  spinner); `FileSystem.createUploadTask` would be the OTA-safe progress route but is net-new
  plumbing.
- Zero 'outlook' matches in apps/mobile — mobile email compose has no precedent; mailto precedents
  use `Linking.openURL` (`settings.tsx:444` with `?subject=`).

### 2.7 Related-record launch points

- **Web item detail** covers items, books, AND rental-items (books/[id] and rentals/items/[id] are
  thin wrappers over the same `ItemDetail`); insertion point is the sticky action row
  (`item-detail.tsx:379-437`), a SERVER component — the launch button must be a client child taking
  primitive props. Full `inventory_items` row is available for prefill.
- **Asset tag does not exist as data** (verified): no `inventory_items.asset_tag` column; the CSV
  importer accepts-validates-then-DROPS it (`csv-import.tsx:52-59`,
  `packages/core/src/inventory/items-csv-import.ts:72,169-170`). `model_number` DOES exist
  (0133/0151). The brief's "Asset Tag: HVAC-204" example has no backing data.
- **No assets table / assigned-asset view exists**; the nearest concept is rentals
  (borrower_user_id, 0131) — and rentals have NO human-readable number (0131:45-66), and mobile has
  NO native rental detail (RentalCard opens the web URL).
- **Orders**: there is NO `orders` table — canonical is `order_requests` (0044) and every existing
  FK is named `order_request_id`, never `order_id` (0050:22, 0142:57, 0153:94, 0255:18). The
  brief's `related_order_id` must target `order_requests(id)`. Convention for optional cross-record
  pointers is `on delete set null` (0010:81, 0233:9, 0040:71).
- **Record URLs in email bodies are new territory for the Outlook-draft path**: the delivery draft
  body contains NO URL by owner decision (condensed note at `storefront-logic.ts:381`); Resend
  transactional emails build `${appUrl}/dashboard/orders/${id}` with
  `process.env.NEXT_PUBLIC_APP_URL ?? 'https://stockpilotusa.com'`
  (`lib/email/order-requests.ts:259`, `order-requests.ts:2302`) — that is the convention for
  maintenance body links; never `window.location`.
- Mobile item/scan selects lack `model_number` (and scan lacks warehouse_id/charter_id) — email
  prefill should be snapshotted SERVER-side from `related_item_id` at request creation so client
  payloads cannot forge item facts.

### 2.8 Test conventions

- Web vitest: happy-dom ONLY via environmentMatchGlobs on `src/components/**` and `src/app/**`
  (`apps/web/vitest.config.ts:16-24`); global setup no-ops the audit service (per-file vi.mock to
  assert on it — `delivery-request.test.ts:5-17` precedent).
- `supabase-mock.ts` replays canned `'<table>.<op>'` results and **ignores every filter**
  (:62-70) — returned-row assertions prove nothing about org scoping; pin query shape via
  `chains`/`chainArgs` (JS) AND pgTAP (DB). `makeServiceContext` defaults enabledModules to the
  FULL `DEFAULT_MODULE_IDS` set (:265-270); gate tests must exclude the module
  (`modules.gate.test.ts` ctxWithout pattern).
- happy-dom idioms (all proven in `delivery-request-action.test.tsx`): Object.defineProperty for
  window.location/navigator.clipboard (vi.stubGlobal unreliable); `vi.unstubAllGlobals()` does NOT
  undo defineProperty — capture original descriptors and restore in beforeEach (:147-169, isolation
  test 531-546); noUncheckedIndexedAccess forces rest-param mocks and `let release!: () => void`;
  mailto is an opaque-path scheme — decode inner query by slicing at the first `?`, never
  `new URL().searchParams` (decodeCompose, :120-145).
- The seeded "ARIAMixin comment" is STALE as a citation — no file mentions it; but the universal
  practice is attribute-based aria assertions (`toHaveAttribute('aria-live','polite')`), which the
  plan should encode as convention without an in-repo citation.
- E2E posture VERIFIED: a Playwright harness exists (`playwright.config.ts`, tests/e2e/*.spec.ts)
  but is NOT in CI (`.github/workflows/ci.yml` runs typecheck, vitest, build, `supabase test db`
  only) and no e2e spec covers any email flow; the delivery program satisfied E2E-shaped
  requirements with component tests + a manual authed browser walk. `location.assign` is
  unstubbable in real Chromium (program memory) — popup/mailto paths are component-test-only.
- pgTAP: file per migration under `supabase/tests/`; become users via
  `set local request.jwt.claim.sub` + `set local role authenticated`; RLS denials via `throws_ok`
  SQLSTATE 42501; module-registration template is `0297_sports_module.test.sql`; attachment-bucket
  RLS template is `0211_po_attachments.test.sql`. Locally requires `supabase db reset` after new
  migrations.
- Mobile vitest is node-env pure-logic only (`src/**/*.test.ts`); screens are untestable by design;
  UI verification is simulator hand-testing per owner rule.

---

## 3. Reuse map (brief requirement → existing system → file)

| Brief § | Requirement | Existing system | File(s) |
|---|---|---|---|
| 4 | L4L-only optional module | organization_modules + MODULE_REGISTRY + resolveSurface; zendesk = off-by-default template; sports = migration template | `packages/core/src/modules/registry.ts:651-665`; `supabase/migrations/0297_sports_module.sql`; `0174_enable_returns_module.sql`; `0144_org_modules_entitlements.sql` |
| 4 | Hidden nav when disabled (web+mobile) | resolveSurface filtering; drawer auto-derives | `packages/core/src/modules/resolve.ts:63-106`; `apps/mobile/src/lib/drawer-nav.ts:63-78` |
| 4 | Rejected by server actions/APIs when disabled | checkModuleAccess (pages) + assertModuleEnabled (services/APIs) | `apps/web/src/lib/modules/module-gate.ts:18-33`; `apps/web/src/server/services/context.ts:208-227` |
| 5 | Four permissions, defaults, grantability | PERMISSIONS registry + ROLE_PERMISSIONS + FULLY_GRANTABLE + 0207 SQL mirror | `packages/core/src/constants/permissions.ts`; `supabase/migrations/0207_permission_overrides.sql` |
| 6 | Andrew's per-user grant, live propagation | Per-user exceptions UI + user_permission_overrides + broadcast | `apps/web/src/server/actions/permissions.ts:189-258`; `apps/web/src/lib/realtime/broadcast.ts:10-29`; `apps/mobile/src/lib/use-permissions-realtime.ts` |
| 7 | Form conventions + validation | RHF+zod (big) / useState+action (simple); core schemas | `apps/web/src/components/inventory/item-form.tsx:328-338,2248-2350`; `start-cycle-count-form.tsx` |
| 7 | Client-side control-char sanitizer | toPlainTextLine (C0+DEL strip; COLLAPSES newlines — description needs a newline-preserving variant) | `storefront-logic.ts:272-275` |
| 8 | Launch points web (item/book/rental/order) | ItemDetail action row (covers 3 routes); orders/[id] header action row | `item-detail.tsx:379-437`; `orders/[id]/page.tsx:551-583` |
| 8 | Launch point mobile (scan result, item detail) | scan result sheet secondaryActions; item overview action stack | `(tabs)/scan.tsx:885-896`; `item/[id].tsx:1387-1421` |
| 8 | FK conventions | optional pointer → `on delete set null`; target order_requests(id) | `0010_po_imports.sql:81`; `0050_shipments.sql:22` |
| 9 | Photo storage + RLS | order-attachments trio (org-prefix) / support-attachments (uid-prefix, MIME-pinned) | `0142_order_attachments.sql`; `0143:73-85`; `0260_support_ticket_attachments.sql`; `services/order-attachments.ts` |
| 9 | Web resize/HEIC/thumbs | compressImageVariants + heic2any worker | `apps/web/src/lib/image-variants.ts:192-239` |
| 9 | Mobile resize/HEIC + upload | resizeForUpload + arrayBuffer + rollback | `apps/mobile/src/lib/image-resize.ts:18-60`; `po-attachments.tsx:128-171` |
| 9 | Rate-limitable upload chokepoint | createUploadUrl mint + checkRateLimit | `services/item-images.ts:762-809`; `apps/web/src/lib/rate-limit.ts:5-84` |
| 9 | Magic-byte sniffing (only in-repo parser) | readImageDimensions (PNG/JPEG signatures; lift into upload finalize) | `apps/web/src/lib/inventory-export-xlsx.ts:58-95` |
| 9 | Safe filenames | sanitizeFilenameSegment (tested vs traversal/CRLF) | `apps/web/src/lib/exports/filename.ts:10-23` |
| 10 | Revocable share token (pattern) | public_request_links: token mint/rotate/audit + anonymous GET template | `0261_public_request_links.sql`; `services/public-links.ts:126-134,406-454,780-788`; `api/v1/public/order-requests/[id]/route.ts:13-62` |
| 11 | Request number | 0254 advisory-lock trigger + core formatter | `0254_order_request_numbers.sql:38-67`; `packages/core/src/orders/order-number.ts:6-9` |
| 11, 21 | Draft-opened recording | recordDeliveryRequestDraftedAction + audit event precedent | `server/actions/delivery-request.ts:47-78`; `services/audit.ts:160-172` |
| 12, 16-19 | Review screen + Outlook/mailto/copy/fallbacks | delivery-request transport + component (extract per §30) | `storefront-logic.ts:577-789`; `delivery-request-action.tsx:158-224,277-291,372-503` |
| 13 | Frozen recipient constants (same addresses) | DELIVERY_REQUEST_EMAIL pattern — mint a SEPARATE L4L_MAINTENANCE_EMAIL (delivery tests pin two-keys/delivery semantics) | `apps/web/src/lib/site.ts:48-92`; `site.test.ts:11-80` |
| 15 | Record links in body | appUrl convention (Resend emails) | `lib/email/order-requests.ts:259`; `order-requests.ts:2302` |
| 22 | List + filters + badges + empty states | returns/cycle-counts list conventions | `returns/page.tsx:27-170`; `cycle-counts/page.tsx:100-160`; `ui/empty-state.tsx` |
| 23 | Detail + StockPilot-only timeline | returns/[id] layout + OrderTimeline label-map | `returns/[id]/page.tsx:94-294`; `order-timeline.tsx:44,127` |
| 24 | Settings page + per-org config | organization_modules.settings + inventory-cleanup/auto-archive panel | `settings/inventory-cleanup/page.tsx:19-45`; `auto-archive-panel.tsx:31-126`; `settings/page.tsx:13-129` (hub tile) |
| 24 | Onboarding | tours/HelpTip/announcements registries | `lib/onboarding/{tours,workflows,announcements}.ts`; `components/onboarding/` |
| 25 | Mobile screens + API | support.tsx form template; api() helper; support route pair | `(drawer)/support.tsx:44-133`; `src/lib/api.ts:89-130`; `api/v1/support/route.ts:27-63` |
| 26 | Notifications + muteable prefs + reminder cron | createNotification + 0028 push trigger + 0265 pref recipe + schedule-reminders skeleton | `services/notifications.ts:18-95`; `0265`; `api/cron/schedule-reminders/route.ts` |
| 25, 26 | Mobile deep links | rewriteWebPath REWRITES table (+ test) | `apps/mobile/src/lib/web-path-rewrite.ts` |
| 31 | Test templates, every layer | see §2.8 | `storefront-logic.test.ts`; `delivery-request-action.test.tsx`; `delivery-request.test.ts`; `modules.gate.test.ts`; `supabase/tests/0297,0211,0207` |

---

## 4. Landmines the plan MUST encode

### Outlook compose (the §16 adjudication)

1. **Brief §16's conceptual mechanics are SUPERSEDED by the adjudication embedded in the brief
   itself** (brief:258-262): a planner reading only §16's first paragraph would reintroduce all
   four owner-proven failures. Binding mechanics: `outlook.cloud.microsoft` (never
   `outlook.office.com` — the domain-migration redirect eats the compose path and lands a bare
   inbox; NO automated test can catch a regression here, it is comment-and-constant enforced only,
   `storefront-logic.ts:556-576`); `mailtouri=` wrapper only (plain `cc=` silently dropped by OWA,
   tests assert plain params ABSENT, `storefront-logic.test.ts:1061-1064`); %20-based encoding
   (never URLSearchParams — `+` renders literally in RFC 6068 clients); NO features string on
   `window.open` (`'noopener'` returns null even on success — the exact blocked-popup signal;
   sever `opener` manually in try/catch, `delivery-request-action.tsx:168-182`).
2. **R3 ordering**: nothing side-effecting may precede `window.open` in the click handler — an
   await/setState/analytics call before it makes Chrome/Safari return null; `prepared` is computed
   in a useMemo precisely so the handler's first statement after the guard is the open
   (`delivery-request-action.tsx:39-44,59,167`; ordering asserted from inside the mocks, test
   248-266, 999-1017). Draft bookkeeping runs strictly AFTER the open.
3. **linkFits=false opens NOTHING** — not even mailto (both transports truncate silently); only the
   clipboard carries the full body, and `clipboardText` is ALWAYS the FULL draft even when the URLs
   are condensed (`storefront-logic.ts:736-746,771,786`).
4. **Do not "unify" the two builders' To handling**: name-addr in the mailto PATH is an OWA-only
   extension; `buildMailtoUrl` stays bare-address RFC 6068 (`storefront-logic.ts:656-664`).
5. **Display names are interpolated UNQUOTED** into `${name} <${addr}>` — a comma in a name splits
   one recipient into two and silently drops the mandatory CC; safe only for compile-time literals.
   Any parameterized-name path in the shared util must RFC-5322-quote or boundary-validate
   (`lib/site.ts:73-83`).
6. **Recipients never in the email BODY** (pinned, `storefront-logic.test.ts:530-534`) and the
   domain draft builder takes NO recipient parameter (test 536-554) — recipients enter at exactly
   one hardcoded call site reading a frozen constant. Never props/state/env.
7. **Condensed-mode disclosure sentence stays byte-intact and contiguous** (multiple toContain
   pins; suffixes append after it, never inside, `storefront-logic.ts:380-381`).

### No-send honesty (brief §2, §20)

8. **Never claim send/ticket/assignment anywhere.** Forbidden-phrase sweeps already exist at four
   layers (`delivery-request-action.test.tsx:742-756`, `site.test.ts:74-79`, overlays test 100-105,
   server-action test 95-103) — clone them for maintenance with the brief §20 list (`Ticket
   created`, `Request submitted to Zendesk`, `DC4 notified`, `Andrew notified`, `Ticket assigned`,
   `Email sent`). Audit event semantics pin "draft OPENED", never wider (`audit.ts:160-172`). A
   fetch spy proves no network call happens on the open click (test 514-528).

### Web UI

9. **DialogContent bakes `max-w-lg`** (`ui/dialog.tsx:41-43`) — override per call site via
   className (twMerge); do NOT restructure ui/dialog.tsx. The z-[100] override is
   storefront-modal-specific; it does not travel to a dashboard route.
10. **Radix modal mode aria-hides every sibling of the portalled DialogContent** — a live region
    outside the dialog is silenced while it is open; mirror a second live region INSIDE
    DialogContent (`delivery-request-action.tsx:464-482`; test 899-924).
11. **A plain `<button>` trigger leaves Radix's triggerRef unpopulated** — default focus restore
    no-ops to `<body>`; explicit `onCloseAutoFocus` + preventDefault + own ref required
    (`delivery-request-action.tsx:108-116,400-403`).
12. **sf-\* classes are storefront-only CSS** — port delivery-request-action's logic, re-express its
    UI in dashboard Tailwind. No ui/alert.tsx exists; dashed-border note is the inline-notice idiom.
13. **Nav gating**: use `requiresAnyOf` (not `requires`) so read_all/manage-only users still see the
    entry (`registry.ts:44-55`; returns precedent :568). Section must be in SECTION_ORDER or it
    never renders. Hand-maintained registries (settings hub tiles, ALL_TOURS, TOUR_ROUTES,
    announcements-at-TOP) must each be touched explicitly.

### Modules, permissions, RLS, migrations

14. **Pattern #24**: `alter policy ... with check` REPLACES the whole WITH CHECK and leaves USING
    behind — when touching both clauses, drop + recreate the policy verbatim (in-repo instances:
    0282:32-41, 0298:310, 0301:84, 0273:6).
15. **Pattern #23**: `requireOrgContext` throws NEXT_REDIRECT inside /api routes — API routes use
    withApiContext/withContext; best-effort actions use plain `createClient` reads; `audit()` from
    Bearer routes MUST pass ctx or the event is silently dropped (`audit.ts:320-327`). Also:
    PostgREST `not.in` drops NULL rows — lifecycle filters stay JS-side; use
    `is distinct from` in SQL.
16. **`seed_org_modules()` is rewritten WHOLESALE by every module migration** — copy the LATEST
    body (currently 0297:26-87) byte-for-byte and append the new row; an omission silently stops
    seeding that module for every future org.
17. **pgTAP count gate**: `role_default_permissions` pinned at exactly 111 rows with an itemized
    provenance message (`supabase/tests/0207_permission_overrides.test.sql:41-45`) — new default
    rows move the literal (4 perms seeded for admin+manager = 8 rows → 119; final number depends on
    which roles get defaults) and the message must be appended in the same format. Owner rows are
    never seeded. Local pgTAP needs `supabase db reset` first. TS↔SQL parity is manual: every
    ROLE_PERMISSIONS change requires matching migration rows or grants work in-app and fail at RLS.
18. **Explicit grants**: every new table needs `enable row level security` PLUS
    `grant select,insert,update,delete to authenticated` (0144:69, 0207:170) or everything 42501s.
    Write policies stay ADDITIVE (`has_org_role('manager') OR has_permission(...)`); requester-scoped
    rows invert to `requester_user_id = auth.uid() OR has_permission(read_all/manage)`; the 0310
    has_permission already excludes disabled accounts.
19. **Strict L4L-only is NOT achievable with a plain optional module**: Settings→Modules lists
    every registry entry and any org's `organization:update` holder can self-enable an optional
    module (`modules/page.tsx:28-32`; RLS 0219 only plan-gates premium). See open question Q2.
20. **Storage policies need the 0312 inline disabled-account guard** (`account_is_disabled()` is
    EXECUTE-revoked from authenticated; only the inline `not exists (... disabled_at is not null)`
    form works in a storage policy, 0312:50-61).
21. **registry.test.ts pins every mobile drawer href to a real Expo route** (EXPO_ROUTES list,
    `registry.test.ts:129-145`) — a mobile_drawer placement without the shipped screen fails CI or
    ships a dead tap (the sports module shipped exactly this bug).
22. **`makeServiceContext` defaults to the FULL DEFAULT_MODULE_IDS set** — keep
    `maintenance_requests` OUT of DEFAULT_MODULE_IDS (defaultOnFor: [] does this) and write gate
    tests with ctxWithout('maintenance_requests').

### Photos and links

23. **Signed storage URLs are NOT "secure links safe for email"**: max in-repo TTL is 30 days and
    Supabase signed URLs are irrevocable once minted; brief §10 forbids links that expire before
    the request is handled and requires revocability — the email must carry an app-URL token (0261
    pattern) resolved server-side at view time, never a raw signed URL. Never log signed URLs
    (`export-images.ts:89-90,200`).
24. **Bucket MIME pins validate the DECLARED header only** — no magic-byte check exists at upload
    time anywhere; brief photo test 6 requires new sniffing code (lift readImageDimensions'
    signature logic into a finalize path).
25. **No upload path is rate-limited today** (direct browser→storage bypasses Next) — route
    maintenance uploads through a rate-limited server mint/finalize, not a verbatim copy of the
    order-attachments flow.
26. **HEIC**: the order-attachments bucket accepts raw HEIC but the thumb transform can't decode it
    (attachmentWantsThumb excludes heic/heif) → unrenderable originals. Maintenance photos should
    REQUIRE client transcode (heic2any web / expo-image-manipulator mobile) and pin the bucket to
    png/jpeg/webp like 0260:29-35.
27. **Thumb drift is real (verified)**: `image-variants.worker.ts:20` = 200px vs
    `image-variants.ts:29` = 400px, and the worker wins in every modern browser — fix in passing or
    knowingly inherit 200px thumbs.
28. **Never on-demand transforms of full-size masters for list surfaces** (attempted 2026-07-01,
    multi-second stalls, reverted same day — `item-images.ts:211-217`); pre-generate thumbs at
    upload. **unstable_cache signers must THROW on failure** or a transient error is cached 25 days
    (recurring bug #6, `order-attachments.ts:20-24`).
29. **Mobile uploads: `fetch(uri).arrayBuffer()`, never `blob()`** (0-byte uploads; documented at
    every call site); object-then-row with rollback on RLS-rejected insert.
30. **URLs in the draft body are new for the compose path** and eat the 1800-char budget — build
    with the appUrl convention (`NEXT_PUBLIC_APP_URL ?? 'https://stockpilotusa.com'`), never
    `window.location`, and design the condense policy around them (open question Q13).

### Notifications, crons, mobile

31. **Every maintenance notification link needs a `web-path-rewrite.ts` REWRITES rule + test BEFORE
    shipping** — the `/dashboard/*` catch-all (:36) silently rewrites unknown paths to home; three
    doors consume links (native-intent :19, push tap :103, in-app inbox notifications.tsx:145 —
    verified; the file header claiming "BOTH" is stale).
32. **0028 AFTER-INSERT trigger is the ONE push path** — never also push from code
    (double-push incident 2026-07-14). `createNotification()` is the one code insert path.
33. **Reminder crons**: stamp the dedupe column BEFORE sending via `.is(guard, null)` guarded
    update; shorter-window reminders suppress longer-horizon ones (2026-07-11 duplicate bug);
    direct sendEmail beside createNotification must re-check disabled_at itself.
34. **Pref keys live in a regular module, never a `'use server'` file** (build breaks during page
    collection); pref gates are fail-OPEN (only explicit false mutes). Do not widen
    `_notify_recipients()` (role-hardcoded, shared by other features) — resolve maintenance
    audiences from permission grants.
35. **OTA constraints**: keep phase 1 pure-JS (no expo-sharing/media-library/clipboard native
    modules) so it ships via `pnpm release:ota` onto the live 1.1.0 binary; any native dep = version
    bump + EAS build + store release. Drawer routes must be registered as Drawer.Screen; stack
    routes in app/_layout. Simulator hand-test after any mobile change (owner rule).
36. **Site pickers must stay sites-only**: `locations.kind` NULL + site-ish type IS the Site
    encoding — never backfill `kind`, never write a rack id into `primary_location_id`
    (memory: L4L DC4 is 413 items' primary).

### Test harness

37. **supabase-mock ignores filters** — org/permission scoping must be pinned via chains/chainArgs
    (JS) AND pgTAP (DB); returned-row assertions alone prove nothing.
38. **happy-dom**: environmentMatchGlobs means DOM only under `src/components/**`/`src/app/**`;
    defineProperty (not vi.stubGlobal) for location/clipboard; `vi.unstubAllGlobals()` does NOT
    undo defineProperty — capture and restore original descriptors in beforeEach (+ an isolation
    test); noUncheckedIndexedAccess forces rest-param mocks and `let release!: () => void`; decode
    inner mailtouri by slicing at the first `?` (opaque-path scheme); global setup no-ops audit —
    per-file vi.mock to assert on it; `vi.restoreAllMocks()` doesn't reset module-level vi.mock
    factories (clearAllMocks in beforeEach).
39. **Playwright is not a CI gate and `location.assign` is unstubbable in real Chromium** — §31's
    E2E checklist is satisfied per the delivery precedent (component tests + manual authed walk),
    not by claiming "CI e2e passes".

---

## 5. Gaps — everything net-new

1. **Module + permissions**: no `maintenance_requests` ModuleId, registry entry, or
   `maintenance_requests:{submit,read_all,manage,configure}` permission strings anywhere (grep
   verified zero hits for "maintenance" in apps/mobile, packages/core, and routes). Full recipe:
   registry entry (tier optional, defaultOnFor: [], surfaces web+mobile+api, placements with
   requiresAnyOf) + PERMISSIONS/ROLE_PERMISSIONS/PERMISSION_META/'Maintenance' group +
   FULLY_GRANTABLE additions + registry.test.ts EXPO_ROUTES + permissions.test.ts +
   0207 pgTAP bump.
2. **Tables**: `maintenance_requests`, `maintenance_request_attachments`,
   `maintenance_request_notes` (+ share-links table if adopted, Q7) — with organization_id, RLS
   (requester-own OR has_permission; child tables EXISTS-join parent), explicit grants, indexes;
   one migration also grandfathers module rows, rewrites seed_org_modules, enables for L4L
   (63c13e64-92a6-4ea4-9936-6a2c26a85b4a), seeds role defaults. Migrations land BEFORE code
   (guards fail closed; `supabase db push --linked` after merge is the assistant's job).
3. **MR numbering**: clone 0254 (advisory-lock trigger + unique index) +
   `formatMaintenanceRequestNumber` in packages/core; typed-handle search needs a parse step
   (display string never exists in the DB).
4. **Shared Outlook utility** (§30): `createOutlookComposeEmail` in packages/core with optional cc
   (new behavior), parameterized names (quoted/validated), fit measurement; delivery re-exported as
   delegating wrappers. Then the new pure `createMaintenanceRequestEmail(input)` builder — subject
   `[StockPilot Maintenance MR-...] <issue>` (note: delivery deliberately DROPPED its number from
   the subject; do not copy that decision), requester/location/related-record/photos/access blocks,
   and a newline-PRESERVING control-strip sanitizer for the description (toPlainTextLine collapses
   newlines; the server-only twin `sanitizePlainText` cannot be imported client-side).
5. **Share-link system**: nothing today issues a long, revocable, expiring token scoped to ONE
   request + its photos with audit + rate limiting; 0261 provides every building block piecemeal.
6. **Upload hardening**: magic-byte MIME verification, upload rate limiting, a finalize/verify step
   (HEAD + sniff + record verified size/dimensions), per-request photo-count and total-size caps —
   none exist anywhere. `order_request_attachments` has no sort_order — copy item_images'
   sort_order/is_primary if reordering ships.
7. **Draft-open persistence**: delivery keeps draftCount in component state and writes only an
   audit row; `outlook_draft_opened_at` + `outlook_draft_open_count` columns, the confirm dialog
   (Cancel / Open Another Draft), and the unsent-draft reminder cron (+ vercel.json entry + stamp
   column) are all net-new.
8. **Web routes**: all four (`/dashboard/maintenance`, `/new`, `/[id]`,
   `/dashboard/settings/maintenance`) + settings hub tile + onboarding entries (tour, ALL_TOURS,
   TOUR_ROUTES, announcement) + a dashboard-styled port of the compose/fallback component.
9. **Mobile**: all screens (`/maintenance`, `/maintenance/new`, `/maintenance/[id]`), drawer/stack
   registrations, web-path-rewrite rules, scan-sheet and item-detail launch buttons, multi-photo
   selection UI, upload progress/retry (no precedent; FileSystem.createUploadTask is the OTA-safe
   route), clipboard strategy (Q9). Mobile email compose has zero precedent — depends on the
   packages/core extraction.
10. **API**: the entire `/api/v1/maintenance-requests` tree (list, create, detail, attachments,
    draft-opened stamp) via withApiContext + assertModuleEnabled + rate limits.
11. **Notifications**: maintenance pref columns/keys/toggles, audience resolution from permission
    grants, and §26's God-Admin-chooses-audience model (no precedent — Q12).
12. **HEIC status**: conversion utilities EXIST on both platforms (heic2any web,
    expo-image-manipulator mobile) — so brief §9's "HEIC when the existing conversion utilities
    support it" is satisfiable, but only by REQUIRING the client transcode and pinning the bucket
    to png/jpeg/webp (landmine 26).
13. **Asset tag**: no data exists (column absent; CSV import drops it) — Q6.
14. **"Assigned asset view"**: no asset entity exists; nearest surface is rental detail (web only;
    mobile has no native rental screen) — Q11.
15. **image-cache.ts** is hardcoded to the item-images bucket — needs a bucket parameter (or second
    instance) before mobile can display maintenance photos.
16. **Test suites**: every §31 layer starts from zero but each has a direct template (§2.8);
    photo-upload harnesses (fake MIME/oversize/HEIC fixtures) and share-link expiry/revocation
    vitest patterns are genuinely new.

---

## 6. Open questions for the plan (engineering adjudications, each with a recommendation)

**Q1. Where does the shared Outlook utility live?**
RESOLVED by cross-check: `packages/core` (new module, e.g. `packages/core/src/email/outlook-compose.ts`),
because mobile's only shared workspace dependency is `@stockpilot/core`
(apps/mobile/package.json:29). Plain TS, no server directives. Delivery exports become thin
delegating wrappers in storefront-logic.ts (same names/signatures) so all four pinning test files
stay green unchanged; the byte-level pins are all reachable through the wrappers.

**Q2. How is "L4L-only" reconciled with self-serve Settings→Modules?**
Recommendation: tier `'optional'` + `defaultOnFor: []`, exactly like zendesk (registry.ts:651-665) —
the brief explicitly wants future enablement for other orgs, and premium/minPlan gating or a new
allowlist mechanism is over-engineering. Accept that another org's admin could self-enable; the
residual risk (their drafts would target the L4L addresses) is bounded because recipients live in
constants/settings the plan can later make org-configurable (brief §13 anticipates this). Note the
risk explicitly in the plan.

**Q3. Does "protected by database RLS" (brief §4) mean module-off blocks rows?**
No precedent exists for `module_enabled()` in a policy. Recommendation: add
`(select public.module_enabled(organization_id,'maintenance_requests'))` to the INSERT/write
policies only, keeping SELECT scoped by org + permission — disabling the module stops new
submissions at the DB layer without hiding existing history from the org. App-layer gates
(checkModuleAccess/assertModuleEnabled) remain the primary enforcement.

**Q4. MR number: cosmetic year or per-year counter reset?**
Recommendation: single per-org counter (clone 0254 verbatim: bigint `request_number`, advisory
lock keyed `'maintenance_request_number:'||org`, unique (organization_id, request_number)); the
year in `MR-2026-000123` is derived from `created_at` at format time. A per-year reset would have
to thread the year through the lock key, the max() WHERE, and the unique index for no user-visible
benefit. Search by typed handle parses prefix/year/padding off before matching the bigint.

**Q5. `related_order_id` vs repo convention?**
Recommendation: name the column `related_order_request_id` referencing `public.order_requests(id)
on delete set null` — every existing FK into that table is `order_request_id` (0050:22, 0142:57,
0153:94, 0255:18) and there is no `orders` table. Document the deliberate deviation from the
brief's §27 sketch. All three related FKs use `on delete set null`.

**Q6. Asset Tag line in the email?**
Recommendation: OMIT it in phase 1 (the builder convention is "fields that do not exist are
omitted, never stubbed"). No column exists and the CSV importer validates-then-drops the header
(csv-import.tsx:52-59). If the owner later wants it, that is a data-capture feature (column +
form + import apply), not an email-builder change. `model_number` exists and CAN be included.

**Q7. Secure photo links: authenticated URLs or a share-token system?**
Recommendation: build `maintenance_request_share_links` on the 0261 pattern (256-bit token, active
flag, expires_at, rotate/revoke, audit, closed-mode per-IP/per-token rate limits, generic 404s).
Required because the To recipient is a Zendesk-ingested mailbox — DC4 agents have no StockPilot
accounts, and brief §10 forbids links that expire before handling (rules out raw signed URLs:
30-day max, irrevocable). Default expiry: long (recommend 180 days) + revocable + surfaced in the
detail UI; whether links appear in the email at all is a `maintenance_requests:configure` setting
per brief §5. The share page resolves photos server-side at view time; storage paths never appear.

**Q8. Upload flow: direct browser→storage (order-attachments clone) or server-minted?**
Recommendation: server-minted signed-upload URL (createUploadUrl pattern, item-images.ts:762-809)
+ a finalize step (magic-byte sniff via lifted readImageDimensions logic, verify declared MIME and
size, record dimensions, generate/verify thumb) + `checkRateLimit` on both mint and request
creation. This is the only way to satisfy brief §9's "server-side verification", "MIME validation"
(test 6: fake MIME rejected), and "upload rate limits" — none of which the direct-upload precedent
provides. Bucket pinned to png/jpeg/webp + 10MB; HEIC handled by mandatory client transcode.

**Q9. Mobile clipboard fallback without a native module?**
Recommendation: phase 1 ships the selectable-text fallback only (brief §18 explicitly allows it;
pure JS, OTA-safe). No clipboard module is installed and expo-clipboard is native (EAS build +
store release). Fold expo-clipboard + expo-sharing (share sheet / Download Photos enhancements)
into a single later EAS-build track; Download Photos on mobile can use expo-file-system
downloadAsync (already in the 1.1.0 binary) to fetch via the share/API endpoint.

**Q10. E2E posture for §31's 20-step web E2E?**
Recommendation: follow the delivery precedent — exhaustive component tests (window.open
interception, decodeCompose assertions, fallback branches) + a scripted manual authed browser walk
in the Demo/L4L org recorded in the engineering report. Playwright is not a CI gate and
location.assign is unstubbable in real Chromium; a new non-CI Playwright smoke spec is optional,
not load-bearing. State this explicitly in the plan so "E2E passes" is honestly defined.

**Q11. What is the "assigned asset view" launch point?**
Recommendation: map brief §8's "asset" onto rentals — add the launch button to the web rental
detail page (`rentals/[id]/page.tsx` action area) and skip mobile (no native rental screen
exists). Do not invent an asset entity. The email's related-rental block identifies the rental by
borrower + dates + item names (rentals have no human-readable number — never promise an "R-…"
handle).

**Q12. §26's God-Admin-configured notification audiences (all new / urgent only / assigned to me /
unsent-draft)?**
Recommendation: phase 1 ships (a) audience = holders of read_all/manage resolved from effective
permissions at send time, (b) standard self-service muteable prefs (0265 recipe) for
new-request/urgent/assigned-to-me keys, and (c) the requester-facing set (saved, draft-opened
reminder, coordinator update, photo failure). Defer the admin-configured per-user audience matrix
(net-new design with no precedent) or, if required, store it as a simple per-user map in
`organization_modules.settings` edited from `/dashboard/settings/maintenance` — never widen
`_notify_recipients()`.

**Q13. Condense policy when the body carries URLs (1800-char budget)?**
Recommendation: the maintenance condensed draft preserves, in order: recipients (always), subject,
request number, requester name/site, truncated description with the byte-intact disclosure
sentence, and the ONE share/record link that fits; it drops location detail, related-record
detail, and access instructions first. Clipboard always carries the full body (invariant from
delivery). The builder measures both URLs against DRAFT_URL_LIMIT exactly like
prepareDeliveryRequest and returns linkFits.

**Q14. Description sanitizer?**
Recommendation: new `toPlainTextBlock` (working name) beside `toPlainTextLine` in the shared
layer: strips C0 (except \n) + DEL, preserves intentional line breaks, caps consecutive newlines
at two — because toPlainTextLine COLLAPSES newlines (correct for subject, wrong for the
description, brief §7 requires preserved line breaks). Subject keeps using the collapsing variant.
C1 passthrough stays as-is (documented scope boundary; every egress is percent-encoded).

---

*Audit compiled 2026-08-05 from eight subsystem audits (delivery-request compose transport; module
gating/permissions/RLS; file/photo upload; numbering/audit/notifications; web UI conventions;
mobile; related-record launch points; test conventions), cross-checked where they disagreed. The
implementation plan must treat §4 (landmines) as hard constraints and resolve §6 as written or
with documented cause.*
