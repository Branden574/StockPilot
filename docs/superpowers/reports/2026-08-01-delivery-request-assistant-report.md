# Delivery Request Assistant — Final Implementation Report (Section 41)

Branch: `feat/delivery-request-assistant`, HEAD `8124daca`.
Plan: `docs/superpowers/plans/2026-08-01-delivery-request-assistant.md` (commit `7795e101`).
Verification report: `docs/superpowers/reports/2026-08-01-delivery-request-assistant-verification.md` (run against HEAD `ba9dfc82`, before the final fix-wave commit `8124daca` described below).

This report describes what the branch's code actually does, checked against the files listed in each section, not what any brief or plan intended. Every claim below is either read directly from the cited file or copied verbatim from the verification report's real command output.

---

## A. Summary

An employee opens `/dashboard/orders/new`, builds a cart from the storefront catalog, and submits through the "Review order request" confirm step. The order is persisted as a real `order_requests` row at status `pending_approval`, carrying a real, canonical `order_number` (the same number that appears everywhere else in the product — the orders list, search, the detail page).

The success stage of the review modal then shows two new controls next to "View order" and "Done": **"Email delivery request"** and **"Preview."** Preview opens a dialog that displays both email recipients (`dc4@learn4life.org` and `arosas@cvwest.org`, neither editable), the exact subject line, and the exact plain-text body that will be used — nothing is generated fresh at send time; preview and send read the same prepared draft. "Email delivery request" opens that same message as a prefilled draft in Outlook Web, in a new tab, via `window.open`. The employee reviews it there and presses Send themselves — StockPilot never sends mail and never claims to. If the popup is blocked, the app falls back to a `mailto:` navigation in the same tab; if that also cannot be verified (Safari silently no-ops an unregistered `mailto:` handler), a "Copy the details" control and, if the Clipboard API is denied or absent, a selectable text box, both carry the identical To/CC/Subject/Message content.

The only thing StockPilot itself records is that a draft was opened — one audit-log row per real draft attempt (`order.delivery_request_drafted`), with a narrow, allow-listed metadata payload. It never records that a ticket was submitted, because it has no way to know.

---

## B. Repository inspection — the actual files

- **Order creation:** `apps/web/src/app/(dashboard)/dashboard/orders/new/page.tsx` renders `OrdersStorefront` (`apps/web/src/components/orders/storefront/orders-storefront.tsx`). The page also computes `ORDER_URL_BASE` (`env.NEXT_PUBLIC_APP_URL`, falling back to `SITE_URL`) and passes it down as `orderUrlBase` — the same value the delivery-request draft uses to build its order link.
- **Order submission logic:** `handleConfirmSubmit` in `apps/web/src/components/orders/storefront/orders-storefront.tsx` (around line 764), which calls `createOrderRequestAction` (`apps/web/src/server/actions/order-requests.ts:83`) — this in turn calls `OrderRequestsService.create`.
- **Order-success component:** the `stage === 'success'` branch inside `ReviewModal`, `apps/web/src/components/orders/storefront/storefront-overlays.tsx` (around lines 474-523). This is a modal stage rendered conditionally inside the existing review dialog — not a route, not a separate page. It renders `successRefLine(...)` for the reference line and mounts `<DeliveryRequestAction>` with the order's full context as `input`.
- **Order detail query:** `OrderRequestsService.get(id)` returns `OrderRequestDetail`, exposed at `GET /api/v1/orders/[id]` (`apps/web/src/app/api/v1/orders/[id]/route.ts`, confirmed calling into `OrderRequestsService`). This is not touched by this feature; it is named here because Section I's recommendation reuses it as-is.
- **Requester profile source:** `order_requests.requester_name` / `.requester_email`, falling back to the joined `user_profiles` row, combined with `||` — not `??` — so an empty string also falls through (`apps/web/src/server/services/order-requests.ts:780-783`, read verbatim: `((h.requester_name as string | null) ?? null) || profile?.fullName?.trim() || null`). The storefront's own client-side twin, used to build the delivery-request draft's `requestedFor` field before submission returns, is `state.onBehalfOf?.name ?? viewerLabel` (`orders-storefront.tsx:1185`).
- **Destination source:** `order_requests.delivery_charter_id` → `charters` (name, code, `address` jsonb), loaded by `loadChartersForWarehouse` in `apps/web/src/server/loaders/orders-new-catalog.ts`. The `address` column now rides along in that same cached query specifically so the delivery-request draft can print a street address without an extra round trip (comment at line 237 of that file); the cache key was bumped from `orders-new-v2-charters` to `orders-new-v2-charters-v2` to invalidate stale cached entries missing the new column. (The catalog cache key, `orders-new-v2-catalog-v2`, was untouched by this branch — it was already at that suffix at base, from an earlier, unrelated bump. `git diff main...HEAD -- apps/web/src/server/loaders/orders-new-catalog.ts` shows only the charters-key line changing.)
- **Requested-date field:** `order_requests.needed_by` (timestamptz), captured client-side as a `datetime-local` string on `CartState.neededBy` and passed to the draft builder as `neededByLocal` — explicitly not an ISO instant (`storefront-logic.ts` doc comment on `neededByLine`, warning against `slice(0,10)`-style truncation which shifts the day for local times after 16:00 PT).
- **Order-item relationship:** `order_request_lines.item_id` → `inventory_items`, quantity in `order_request_lines.quantity_requested`, surfaced to the builder as `CartLineState[]` plus an `itemMap` lookup.
- **UI components reused:** the storefront's own `sf-*` CSS classes (`storefront.css`), `lucide-react` icons (`Mail`, `Eye`, `Copy`), `sonner` (`toast.success`/`toast.error`), and Radix `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogDescription` for the preview dialog only — the review/success modal itself remains the storefront's own hand-rolled `.sf-modal`.
- **Test setup reused:** vitest with `happy-dom` for `src/components/**`, `@testing-library/react` + `user-event`, the `Object.defineProperty(navigator, 'clipboard', ...)` idiom borrowed from `mfa-recovery-codes.test.tsx:60-88`, `vi.stubGlobal` for `open`, and the `makeItem()` factory already present in `storefront-logic.test.ts`.

---

## C. Files changed

From `git diff --stat main...HEAD` (19 files, 8,011 insertions / 48 deletions):

| File | Why |
|---|---|
| `apps/web/src/lib/site.ts` | Adds the single, frozen `DELIVERY_REQUEST_EMAIL` constant (`to`/`cc`) and `DELIVERY_REQUEST_CC_NOTICE` helper text — the one definition of the recipients in the codebase. |
| `apps/web/src/lib/site.test.ts` | New — asserts the constant is frozen, its two literal values, and that the notice sentence never claims Zendesk assignment. |
| `apps/web/src/components/orders/storefront/storefront-logic.ts` | Adds `successRefLine`, `toPlainTextLine`, `formatSiteAddressLines`, `buildDeliveryRequestDraft`, `buildOutlookComposeUrl`, `buildMailtoUrl`, `buildClipboardText`, `prepareDeliveryRequest` — the pure draft builder and both transports' URL construction, with no React/DOM/network dependency. Also removes the old fabricated `orderRef()` (owner decision 2). |
| `apps/web/src/components/orders/storefront/storefront-logic.test.ts` | Unit coverage for all of the above: encoding, condensation, CC presence on every branch, pickup vs delivery bodies, empty-field placeholders. |
| `apps/web/src/components/orders/storefront/delivery-request-action.tsx` | New client component — the button, the open/mailto/clipboard fallback chain, the honesty notices, the repeat-draft warning, the live region, and the preview dialog. |
| `apps/web/src/components/orders/storefront/delivery-request-action.test.tsx` | New — component-level coverage for every path listed in Section G. |
| `apps/web/src/components/orders/storefront/storefront-overlays.tsx` | Wires `DeliveryRequestAction` into the success stage's `.acts` row; renders the canonical `successRefLine` instead of the old fabricated handle; adds the focus-trap/focus-restore effects for the review/success modal (Task 9) so the two dialogs' Escape handlers do not fight. |
| `apps/web/src/components/orders/storefront/storefront-overlays.test.tsx` | New — success-stage rendering, focus trap/restore, and modal-stage assertions. |
| `apps/web/src/components/orders/storefront/storefront.css` | Adds the recipient block (`.sf-recip`), fallback panel (`.sf-fallback`), and note (`.sf-note`/`.sf-note-warn`) styles, plus the `.acts` flex-wrap fix so the fallback panel takes its own row instead of squeezing onto the button row. |
| `apps/web/src/components/orders/storefront/orders-storefront.tsx` | Threads `orderUrlBase`, the resolved requester email, the delivery charter's address, and `neededBy` down to the success screen's `DeliveryRequestAction` input; widens the local submit handling to read the canonical `orderNumber` back from `createOrderRequestAction`. |
| `apps/web/src/components/orders/v2/types.ts` | Adds `CharterAddress` and widens `StorefrontCharter` to carry `address`. |
| `apps/web/src/server/actions/delivery-request.ts` | New Server Action — `recordDeliveryRequestDraftedAction`, the one write path to the audit log for this feature; validates input with zod, never throws to the caller. |
| `apps/web/src/server/actions/delivery-request.test.ts` | New — asserts the allow-list, that it never throws, and that invalid input is a silent no-op. |
| `apps/web/src/server/actions/order-requests.ts` | Widens `createOrderRequestAction`'s return type from `{ id }` to `{ id, orderNumber }` (owner decision 2) so the canonical number reaches the success screen and the email. |
| `apps/web/src/server/loaders/orders-new-catalog.ts` | Adds `address` to the charter select and bumps both `unstable_cache` keys to `-v2` so stale cached rows missing the column are not served after deploy. |
| `apps/web/src/server/services/audit.ts` | Adds the `order.delivery_request_drafted` member to the `AuditEvent` union, with an inline comment fixing its meaning permanently ("records that a draft was OPENED and nothing more"). No migration: `audit_logs.event` is plain text with no CHECK or enum in Postgres. |
| `docs/superpowers/plans/2026-08-01-delivery-request-assistant.md` | The implementation plan itself (Task 1's commit). |
| `docs/superpowers/reports/2026-08-01-delivery-request-assistant-verification.md` | Task 11's verification report. |

No `supabase/` migration diff exists on this branch (`git diff --stat main -- supabase/` is empty) — this feature required no schema change.

---

## D. Data mapping table

| Brief field | Actual field / relationship |
|---|---|
| Order number | `order_requests.order_number` (bigint, per-org sequence, assigned by a trigger at insert) → `formatOrderNumber()`. `createOrderRequestAction` now returns `{ id, orderNumber }` (previously `{ id }` only), so the success screen and the email both render this same canonical number — never the old `orderRef()` fabrication. |
| Requester name | `order_requests.requester_name`, else `requester_user_id` → `user_profiles.full_name`, combined with `\|\|` (`order-requests.ts:780-783`). Client-side (before the round trip returns), `state.onBehalfOf?.name ?? viewerLabel`. |
| Requester site | **ABSENT.** The internal storefront captures no site for the requester. The only site an order carries is the delivery charter (the destination), not the requester's own site — there is no column, join, or client state anywhere that records where the requester is standing. |
| Destination site | `order_requests.delivery_charter_id` → `charters.name` / `.code` / `.address` (jsonb: `line1`, `line2`, `city`, `region`, `postalCode`, `country` — the field is `region`, not `state`). |
| Requested delivery date | `order_requests.needed_by` (timestamptz), sourced client-side from `CartState.neededBy`, a raw `datetime-local` string with no offset. |
| Ordered items | `order_request_lines.item_id` → `inventory_items.name` / `.sku`; quantity is `order_request_lines.quantity_requested`. |
| Order notes | `order_requests.notes` — printed under an `ORDER NOTES` heading when present and not condensed. |
| Delivery instructions | **ABSENT.** No `delivery_instructions`, `dropoff_instructions`, or `ship_to` column exists anywhere in the public schema. |

Additional fields the brief's structure implies but that do not exist as real data, each omitted rather than stubbed (per `storefront-logic.ts`'s `DeliveryRequestInput` doc comment, lines 302-319):

| Field | Status | Why omitting beats stubbing |
|---|---|---|
| Destination building / room | ABSENT | No such column on `charters` or `order_requests`. Printing a labelled row with nothing under it would imply the system asked a question it never asked. |
| Priority / urgency | ABSENT | No column captures this anywhere in the order flow. |
| Site contact (name/email) | Present as columns, 0 of 16 prod charters populated | A perpetually-empty field reads as a broken feature, not an absent one — worse than not printing the row. |
| Requester phone | Hardcoded null on this path | The internal storefront never asks for a phone number; there is no input to source it from. |
| Per-line note | Present as a column, 0 of 150 prod `order_request_lines` rows populated | Same reasoning as site contact — a column existing does not mean the data exists. |
| Unit of measure | Present but unselected, free text, inconsistent | Printing it would surface messy internal data as if it were a considered field; the assistant would be dressing up noise as signal. |

Each of these is a data-**capture** gap, not a rendering gap — closing any of them is a separate product decision and a separate spec, not a change to the draft builder.

---

## E. The Outlook strategy

**URL generation.** `buildOutlookComposeUrl` (`storefront-logic.ts:607`) targets `https://outlook.office.com/mail/deeplink/compose`, chosen over `outlook.live.com` because the organization runs managed Microsoft 365 and the latter is the consumer host — it would land a work account on the wrong tenant.

**Encoding.** Both the Outlook URL and the `mailto:` fallback are built by a hand-rolled `encodeDraftQuery` (`storefront-logic.ts:589`), not `URLSearchParams`. `URLSearchParams` serializes per `application/x-www-form-urlencoded`, which turns a space into `+`; web query parsers decode that symmetrically, but RFC 6068 gives `+` no space meaning in a `mailto:` URL, and desktop Outlook, Apple Mail, and Thunderbird render it literally — the whole draft would read as `Delivery+Request+...`. `encodeDraftQuery` emits `%20`, which both kinds of decoder read correctly, and encodes each parameter exactly once (nothing is pre-encoded going in, nothing is encoded twice going out). `to`, `cc`, `subject`, and `body` are all real, separate parameters on both URLs — the CC is never folded into `to` and never appears only in the body.

**Plain-text formatting.** `buildDeliveryRequestDraft` (`storefront-logic.ts:430`) assembles the body as an array of blocks joined with `\n\n` — an omitted block (e.g., no needed-by date, no notes) leaves no trace: no heading, no stray blank line, never three consecutive newlines. Every user-sourced string passes through `toPlainTextLine`, which collapses any control character (including CR/LF) to a single space before trimming — so no value can inject a newline that forges a header-looking line in a client that parses the pasted text.

**Popup handling.** `handleOpen` in `delivery-request-action.tsx:158` calls `window.open(prepared.outlookUrl, '_blank')` as its first statement after the `linkFits` guard — deliberately with no `'noopener,noreferrer'` features string, because that string makes `window.open` return `null` on success too (a documented browser spec behavior), which is indistinguishable from a genuinely blocked popup. The code takes the real handle and severs `opened.opener = null` manually instead, so the opened tab still cannot reach back into the page. A `null` return (real block) or a thrown exception both drive the fallback path.

**Default-email fallback.** When `window.open` returns `null`, `window.location.assign(prepared.mailtoUrl)` runs — the `mailto:` URL carries `To` in the path and `cc`/`subject`/`body` as query parameters, using the same `%20` encoding.

**Clipboard fallback.** `buildClipboardText` (`storefront-logic.ts:643`) always renders the FULL, uncondensed body (the clipboard has no URL length limit) as four labeled blocks — `TO:`, `CC:`, `SUBJECT:`, and a `MESSAGE:` section — via `navigator.clipboard.writeText`. When the Clipboard API is denied or absent, a read-only, auto-selecting `<textarea>` renders the identical text as the terminal fallback.

**Large-order handling.** `prepareDeliveryRequest` (`storefront-logic.ts:690`) measures both the full Outlook URL and the full mailto URL against `DRAFT_URL_LIMIT = 1800` characters. If either exceeds it, a condensed draft is built instead (drops the per-line item list and the street address, keeps counts and site) and re-measured. This is disclosed in two places: in the body itself (`CONDENSED_DISCLOSURE`, naming that notes were also dropped when they existed), and on screen (`data-testid="delivery-request-condensed"`), with a second, distinct on-screen variant for the rarer case where even the condensed URLs still exceed the limit (`linkFits === false`) — in which case neither link is opened at all and the UI routes directly to the copy path.

**CORRECTION (2026-08-01, owner decision).** The paragraph above originally read "...keeps counts, site, and the order link." The body no longer carries an order link at all — the owner removed it the same day, along with the closing "Drafted in StockPilot..." provenance footer, on the reasoning that DC4 recipients are org members who can already see every order inside StockPilot, so a deep link back into the app is redundant, and the footer added no operational value. `CONDENSED_DISCLOSURE` no longer says "at the link above" — it now points at the order number printed in the body / at StockPilot itself, since there is no link left to point at. This is a body-only change: the on-screen honesty notices (`delivery-request-notice`, the repeat-draft warning, the preview dialog's disclosures) are unaffected. Full rationale in the requirements addendum's 2026-08-01 "trim the order link and the provenance footer" entry.

**Post-report fix wave (commit `2cfa41a4`).** The preview dialog's own "Copy the details" button calls the same `handleCopy` as the fallback panel, but reaching a clipboard-denied or clipboard-absent browser from inside the dialog never touches `handleOpen` — so `fallbackReason` stays `null` and the panel that used to be the textarea's only render site never mounts. The manual-copy `<textarea>` and the `announcement` live region are now each rendered a SECOND time inside `DialogContent`, fed by the same `manualText`/`announcement` state as the panel copies below them — the textarea is reachable regardless of which surface (panel or dialog) the failed copy happened on, and a copy triggered from inside the dialog is announced even though Radix's modal mode `aria-hide`s the always-mounted region outside the portal while the dialog is open.

**CORRECTION (2026-08-01, branch `fix/outlook-compose-mailtouri`).** The plain-param form described above (`to`/`cc`/`subject`/`body` as separate query parameters) has been replaced, in two steps.

*Step 1 (commit `bde3ab87`).* The owner tested the plain-param URL against the real L4L Microsoft 365 tenant and found Outlook Web opened the compose window with To, Subject and Body populated but Cc silently empty — Andrew (`arosas@cvwest.org`), a mandatory CC, never received the request; Microsoft Q&A confirms a plain `cc=` on `mail/deeplink/compose` is effectively unimplemented, not a bug specific to this app. `mailtouri` is the parameter OWA hands to the browser's registered mailto: protocol handler, whose parser must honor `cc` per RFC 6068; the owner hand-verified that form in the same tenant and confirmed both To and Cc populate correctly, with subject and body intact.

*Step 2 (commit `815615e0`, current shipped shape).* A second tenant test showed OWA's `mailtouri` parser also accepts a name-addr ("Name <addr>") in the To PATH position, producing chips that read 'Fresno Warehouse DC4 <dc4@learn4life.org>' (To) and 'Andrew Rosas <arosas@cvwest.org>' (Cc), correct addresses underneath — so `buildOutlookComposeUrl` no longer reuses `buildMailtoUrl`'s output. It now builds its own inner mailto: URI directly:

```ts
export function buildOutlookComposeUrl(draft: DeliveryRequestDraft): string {
  const toNameAddr = `${DELIVERY_REQUEST_EMAIL_NAMES.to} <${draft.to}>`;
  const ccNameAddr = `${DELIVERY_REQUEST_EMAIL_NAMES.cc} <${draft.cc}>`;
  const query = encodeDraftQuery({
    cc: ccNameAddr,
    subject: draft.subject,
    body: draft.body,
  });
  const innerMailto = `mailto:${encodeURIComponent(toNameAddr)}?${query}`;
  return `${OUTLOOK_COMPOSE_BASE}?mailtouri=${encodeURIComponent(innerMailto)}`;
}
```

The To PATH segment is `encodeURIComponent` of the name-addr string built from the new `DELIVERY_REQUEST_EMAIL_NAMES` constant (`apps/web/src/lib/site.ts`) and the routing address from `DELIVERY_REQUEST_EMAIL`; the Cc value carries the same name-addr shape through the existing `encodeDraftQuery`, so it still rides in the RFC-6068-legal hfield-value position. Two encoding layers total — one building this inner URI, one wrapping it as the `mailtouri` value — each applied exactly once, same non-double-encoding shape as step 1.

One RFC correction of our own: name-addr itself is RFC 5322 mailbox syntax, not RFC 6068. RFC 6068's `mailto:` scheme admits a name-addr only as the VALUE of an hfield (`to=`/`cc=` in the query string) — it does not define name-addr in path position at all. Putting the To name-addr in the path, as this builder does, is therefore an **OWA `mailtouri` parser extension beyond the RFC**, tenant-verified 2026-08-01, not a documented part of RFC 6068 itself.

That distinction sets the hard boundary: the display-name treatment is **OWA-only**. `buildMailtoUrl` — the popup-blocked desktop `mailto:` fallback — stays unchanged and bare-address, plain RFC 6068, because nothing says a generic `mailto:` consumer (desktop Outlook, Apple Mail, Thunderbird) would parse a path-position name-addr the same way OWA's `mailtouri` handler does; that combination was never tested. `buildClipboardText` and every on-screen recipient label likewise stay bare addresses — the owner-pinned strings, unaffected by the new constant.

---

## F. Status accuracy

StockPilot records only that a delivery-request draft was **opened** — never that a ticket was submitted, never that mail was sent. The one write path is `recordDeliveryRequestDraftedAction` (`apps/web/src/server/actions/delivery-request.ts`), which calls `audit()` with `event: 'order.delivery_request_drafted'` and an explicit allow-list, quoted verbatim from `apps/web/src/server/actions/delivery-request.ts:67-71` — the `extra` block lives in the server action itself, not in `delivery-request-action.tsx` (that file only ever calls the action; it does not construct the audit payload):

```ts
extra: {
  recipient_type: 'dc4-delivery-request',
  included_cc_recipient: true,
  is_condensed: parsed.data.isCondensed,
},
```

No compose URL, message body, destination address, order notes, recipient email address, or requester phone is ever written to this row — `audit.ts`'s doc comment for the union member states this is deliberate and permanent: "Never widen this event's meaning." The `AuditEvent` union entry itself (`audit.ts:172`) carries the same restriction in its own comment. This action is called only after `window.open` (or the one-shot `mailto:` fallback) has already run, is best-effort, and never throws to the caller.

The pre-existing sentence on the success screen — "Your manager has been notified. You'll get an email when it's approved..." (`storefront-overlays.tsx:490-494`) — was re-verified in Task 8 (per the execution ledger) and confirmed **true** for this path: an existing trigger (migration 0044) plus an existing notification body (migration 0265) notify the org's owner/admin/manager on INSERT for a `pending_approval` order, and a real approval email fires at `approve()`. The scope qualifier the ledger records: this is true for the **internal storefront** specifically — public-link or `pending_confirmation` order inserts defer the manager ping to a later status update rather than firing it at creation time. This screen is the internal storefront only, so the sentence is accurate as displayed here.

**Post-report fix wave (commit `2cfa41a4`).** Two additions, both narrow. First, `recordDeliveryRequestDraftedAction` now confirms `orderId` names an `order_requests` row actually visible to the caller — a plain `createClient()` read (RLS, migration 0044, scopes the SELECT to the caller's own organization), not `requireOrgContext()`/`withContext()`, which would pull a `redirect()` side effect into what is supposed to be invisible background bookkeeping. An unknown or not-visible id is now a silent no-op, same as a failed zod parse; nothing else about the action's best-effort, never-throws contract changed. Second, `order-timeline.tsx`'s `EVENT_LABELS` map gained an entry for this same event — `'order.delivery_request_drafted': 'Delivery request drafted'` — with a detail line, "A prefilled draft was opened — StockPilot did not send it.", so the audit row this section describes now also renders as a labeled, honestly-worded entry on the order's own timeline rather than falling through to the generic prettified-event-name fallback.

---

## G. Tests

Copied verbatim from the Task 11 verification report (`docs/superpowers/reports/2026-08-01-delivery-request-assistant-verification.md`), run against branch tip `ba9dfc82` (one commit before this branch's current HEAD):

- **`pnpm typecheck`** — PASS. `tsc --noEmit`, 3/3 successful.
- **`pnpm lint`** — PASS. 0 errors, 30 pre-existing warnings, none introduced by this feature.
- **`pnpm test`** (full workspace) — PASS. **399 test files / 4,375 tests, all passed** (28.42s test time).
- **`pnpm --filter @stockpilot/web build`** (production build) — PASS. Exit code 0, full route manifest, zero `error`/`failed` hits in the log.

The commit immediately after that report, `8124daca` ("fix the preview dialog's z-index and its Escape focus-restore," described further in the note at the end of this section), re-ran its own local suites after the fix: 264/264 in the orders test files and 48/48 in `delivery-request-action.test.tsx`, typecheck clean — per the execution ledger's Task 11 entry; these narrower re-runs are not a repeat of the full four-gate walk above.

### Deviation from brief section 34: no Playwright e2e was written

This is a deliberate deviation, made on the owner's explicit instruction (owner decision 3 in the requirements addendum), not an omission. The reasons, verified directly:

- Playwright is not wired into CI. `.github/workflows/ci.yml` runs three jobs — `lint-and-typecheck` (`pnpm typecheck` then `pnpm test`, lines 34-38), `build` (`pnpm build`, lines 40-57), and `db-tests` (`pnpm exec supabase test db`, pgTAP, lines 70-92). No job invokes `playwright test`.
- None of the five existing Playwright specs creates data. `apps/web/tests/e2e/` contains `dashboard.spec.ts`, `inventory.spec.ts`, `landing-intro.spec.ts`, `movements.spec.ts`, and `settings.spec.ts` — an order-placing spec would have been the first of its kind in this repo.
- `apps/web/tests/e2e/auth.setup.ts` (read in full) skips entirely when `TEST_USER_EMAIL`/`TEST_USER_PASSWORD` are unset (lines 20-25), and throws if the configured account has MFA enabled (lines 39-43) — there is no automated path through 2FA in this harness today.

Given those three facts together with the owner's hard testing prohibition (never trigger a real send, never open a real Outlook Web compose window against the real recipients, never send to `dc4@learn4life.org` or `arosas@cvwest.org` from any environment), a first-of-its-kind, data-creating, real-browser e2e spec for this specific feature was judged the wrong place to take on that combined risk. Component tests carry the coverage instead. By path name:

- `apps/web/src/components/orders/storefront/storefront-logic.test.ts` — the pure builder and both URL/clipboard-text generators: encoding correctness (`%20` not `+`, exactly-once encoding), the condensed variant, pickup vs. delivery body construction, empty-field placeholders, oversized/`linkFits` detection, and the CC appearing on every generated artifact.
- `apps/web/src/components/orders/storefront/delivery-request-action.test.tsx` — the open path (`window.open` stubbed via `vi.stubGlobal`), the popup-blocked path (open returns `null`, falls through to a stubbed `location.assign`), the mailto string itself, the clipboard path (`Object.defineProperty(navigator, 'clipboard', ...)`), the clipboard-denied path (falls to the selectable textarea), the duplicate-draft warning (second real draft attempt for the same mounted order), the condensed disclosure (both variants), the pickup body's absence of a delivery-destination block, keyboard/focus behavior (tab order, Escape, focus restore), and the CC recipient asserted present on every one of the above paths.
- `apps/web/src/components/orders/storefront/storefront-overlays.test.tsx` — the success-stage wiring, the review/success modal's own focus trap and restore, and that the two dialogs' Escape handlers do not conflict.
- `apps/web/src/lib/site.test.ts` and `apps/web/src/server/actions/delivery-request.test.ts` — the frozen recipient constant and the audit action's allow-list, respectively.

### What was verified by string assertion versus what awaits the owner's manual send

Every check above that touches `window.open`, `window.location.assign`, or `navigator.clipboard` was verified by **string assertion against a stubbed global** — the generated URL or clipboard text was decoded and its parameters checked; no real navigation, no real send, no real network call to Microsoft or to a mail provider ever occurred in any test or in the verification walk. Two checks remain genuinely **NOT RUN**, both requiring the owner's own environment and explicit manual action:

1. **Whether Outlook Web actually renders the prefilled compose draft correctly inside the organization's managed Microsoft 365 tenant**, on Edge and on Chrome. This requires a real, authenticated M365 session in that tenant and cannot be automated or safely simulated here.
2. **Whether the OS default mail app honors the `cc` parameter on a real `mailto:` handoff.** The only real-world signal obtained was the unintended incident described below; no compose window was ever confirmed open to inspect whether the CC field was actually populated.

### The verification-walk safety incident, recorded in full

During the popup-blocked check in Task 11's Demo Co walk, `window.location.assign` could not be stubbed in Chromium — `Location` is a spec-level exotic object whose own properties resist plain reassignment (`assign.toString()` still reported `"function assign() { [native code] }"` after the stub ran). As a result, clicking "Email delivery request" in the deliberately-forced blocked-popup test mode triggered a **real** `mailto:` navigation carrying the real `dc4@learn4life.org` / `arosas@cvwest.org` addresses, and macOS Mail.app launched (confirmed via `ps aux`, process start time matching the click). Zero Mail windows ever rendered; the query used to check for open windows returned empty. No Send was ever triggered — a `mailto:` navigation only opens a compose window and requires an explicit user Send inside the mail client, which never happened — and no mail account was configured on that machine, so a send could not have completed even if one had been attempted. Mail.app was quit within under a minute of the incident being noticed. The check was **not repeated**; every subsequent click in that walk used the success-mode stub instead. No email left the machine as a result of this incident.

The rule this produced, going forward: the blocked-popup → mailto path must never be exercised through a real browser click again. It is component-test only, where `jsdom`'s `Location` is a genuinely mutable plain object and a stub can actually intercept the call.

---

## H. Limitations

Stated plainly, as the addendum requires:

1. **StockPilot cannot confirm the employee pressed Send.** The assistant opens a prefilled draft; nothing in this application observes the mail client after that point.
2. **No Zendesk ticket number is captured this phase.** Zendesk's ticket creation happens entirely through its own email intake, outside this application; StockPilot has no visibility into it.
3. **Attachments cannot be auto-added through a compose link.** Neither the Outlook Web deep-link nor `mailto:` supports attaching a file via URL.
4. **Ticket status cannot sync without a future integration.** There is no connection today between an order's StockPilot status and whatever happens to the resulting Zendesk ticket.

Four more, found in the course of this implementation and not in the original brief's four:

5. **The destination address is a best-effort render of owner-maintained data**, reproduced verbatim, typos included — `formatSiteAddressLines` (`storefront-logic.ts:276`) explicitly does not correct anything, and its own doc comment notes that the KVA Tulare charter's stored address really does say "Calfornia." Silently correcting a site address inside a delivery instruction was judged a worse failure than reproducing the owner's data as entered.
6. **4 of 16 production charters have no address at all** (`address = null`); the assistant omits the whole `DELIVERY DESTINATION` address sub-block for those (site name/code only) rather than printing an empty "Address:" line that would imply the system captured something it did not.
7. ~~**Whether Outlook Web honors the `cc` deep-link parameter in the organization's managed tenant is unverified, owner-owed QA** — see Section G's two NOT RUN items.~~ **RESOLVED (2026-08-01).** The owner ran the QA this item called for, against the real L4L tenant, and it failed: the plain `cc=` param was silently dropped. The fix (branch `fix/outlook-compose-mailtouri`, see Section E's correction above) switched to the `mailtouri=` form, which the owner then re-verified in the same tenant — Cc now populates correctly alongside To, Subject and Body. This limitation no longer applies.
8. **The success surface is React component state, not persisted or routed.** `previewOpen`, `fallbackReason`, `draftCount`, and every other piece of this feature's state lives inside `DeliveryRequestAction`, which is only ever mounted inside the success stage of the review modal. A page refresh — or simply closing the modal and navigating away — makes the assistant unreachable for that order; there is no way back to it short of Section I's recommended durable second home.

Additional limitations, inherent to the design and disclosed rather than hidden:

- **The repeat-draft warning cannot know whether a `mailto:` actually produced a draft.** Safari treats a `mailto:` navigation with no registered handler as a silent no-op — the warning counts attempted opens, not confirmed drafts, because there is no signal available for the latter.
- **`toPlainTextLine` strips C0 control characters and DEL (Unicode range U+0000 through U+001F, plus U+007F) but not C1 controls** such as `U+0085` (NEL). This was flagged in Task 4's review and deliberately not fixed: every user-controlled string that reaches the body is also passed through one of the two percent-encoding transports (`encodeDraftQuery` for the URLs, the browser's own clipboard write for the copy path), and none of those transports treat a raw C1 control as a delimiter or header marker — so the gap is real but not weaponizable through any path this feature actually uses.

---

## I. Recommended next phase

**Recommendation only — nothing below is implemented on this branch.**

The single highest-value follow-on is a **durable second home for the delivery-request assistant on `/dashboard/orders/[id]`.** That page already loads the complete `OrderRequestDetail` server-side through the existing `OrderRequestsService.get(id)` / `GET /api/v1/orders/[id]` path described in Section B — no new query or endpoint is required to feed it. Unlike the success-stage modal, this page survives a refresh and normal navigation, which directly closes Limitation 8 above: it is where a manager or the original requester goes when the first draft was accidentally closed, when the browser tab was lost, or when the order was created days earlier and nobody drafted the request at the time.

Two things this next phase would additionally require, disclosed rather than solved here:

- **R8 handling for the 5 of 41 production delivery orders whose `delivery_charter_id` is `NULL`.** The coherence CHECK added in migration 0110 was applied `NOT VALID` (confirmed in `supabase/migrations/0110_orders_delivery_charter.sql` and the later, only-partial validation attempt in `0121_picker_assignment_and_picking_resolution.sql`), so pre-existing rows can still violate it. The current builder already has an honest fallback for this case on the success screen (`DELIVERY DESTINATION\nNot recorded on this order...`); a durable, revisitable surface would need the same honesty, every time the page is loaded, not just once at submission.
- **A decision on who may draft one** (open question 5, below) — today anyone who can reach the order at all inherits the existing `orders:request` gate; a durable, always-available entry point raises the same question with more weight, since it would be reachable long after the original submitter's session ended.

Alternatives considered and explicitly rejected for this phase, and why the durable entry point outranks each of them on value per unit of risk:

- **Persisting a Zendesk ticket number** — requires either manual back-entry by an employee (unreliable, adds a step) or a Zendesk API integration to look it up, which is explicitly out of scope (Global Constraint 4).
- **A direct Zendesk API integration** — the largest engineering and credentialing lift of the group (an OAuth/API-key wall, a new connector), for a capability (status sync) the owner has not asked for yet.
- **A Microsoft Graph integration** — would let StockPilot detect that a draft was actually sent, but requires an auth flow and a Graph dependency this plan explicitly does not add, for a single narrow benefit (closing Limitation 1).
- **An automatic packing slip attached to the request** — attachments cannot be added through a compose link at all (Limitation 3); solving this requires an entirely different transport (e.g., a real send-on-behalf-of API), which reopens the "does StockPilot send mail" question the owner has explicitly kept closed this phase.
- **Delivery status sync back into StockPilot** — depends on one of the two integrations above existing first; there is nothing to sync from without them.

The durable second home requires none of those and delivers the single most common real gap (a lost or never-drafted request) using infrastructure that already exists.

---

## Open questions for the owner

Reproduced unchanged from the plan's Global Constraints — none of these may be answered by an implementation detail, and none of them blocked building this feature.

1. **Pickup subject format.** The single "Delivery Request" subject format is used for both delivery and pickup orders today, keeping Zendesk routing uniform; the body's "Fulfillment method: Pickup / will-call" line carries the distinction instead. A second, pickup-specific subject format needs the owner's explicit sign-off before it is built.
2. **Is the recipient pair L4L-only, or a product feature every org gets?** `DELIVERY_REQUEST_EMAIL` is hard-coded today (`apps/web/src/lib/site.ts`). Per-org configuration is the only version of this that needs a migration.
3. **What is DC4's real Zendesk intake contract?** A required subject prefix, a ticket-form token, or a structured body block would change the builder's output. StockPilot cannot detect a mis-route from the application side — there is no feedback signal.
4. **Should the assistant have a durable second home on `/dashboard/orders/[id]`?** Recommended above as the next phase. It needs R8 handling for the 5 orphaned delivery orders and a decision on who may draft one.
5. **Who may draft a delivery request?** Today, anyone who reaches the success screen already holds `orders:request` and inherits that existing gate. Should this be narrowed to a specific role?
6. **Is the street address worth carrying at all?** This implementation carries it (one column on an already-cached loader, cache key bumped to invalidate stale rows). Given 4 of 16 sites have no address and at least one has a known typo, site name plus code alone may serve DC4 at least as well.

## Unrecorded brief details — stated defaults awaiting owner confirmation

The owner's brief was a chat message; only its tail and the CC addendum were captured on disk. These four points needed a section 1-40 detail that neither the addendum nor the audit spec records, and each was resolved here with a stated default rather than a guess dressed up as a transcription.

1. **The exact subject string.** Section 10 of the brief is known to require ONE consistent format for Zendesk routing, but the format's exact wording was never received. This implementation uses `Delivery Request — StockPilot Order SO-000049 — <site or warehouse>` for both fulfillment types (`storefront-logic.ts:456-458`). If the brief specified different words, a different separator, or a routing prefix DC4's intake filters on, this subject — and the tests asserting it — need to change.
2. **The exact body template.** The audit establishes which fields exist; the brief's actual headings, ordering, and wording were not recorded. This implementation's block order — header, method/status, from (or pickup/collected-by), destination, needed-by, items, notes — is a reasoned construction, not a transcription of anything the owner sent. (**CORRECTION, 2026-08-01:** the block order originally also ended in `link, footer` — an "Order link:" line and a "Drafted in StockPilot..." provenance footer. The owner removed both from the email body that same day, deciding DC4 recipients are org members who can already see every order in StockPilot and that the footer was noise; see the requirements addendum's 2026-08-01 entry.)
3. **Whether a "requester site" was required.** The brief's section 41-D asks for a "requester site" mapping. As recorded in Section D above, no such datum exists anywhere on the internal storefront — the only site an order carries is the delivery charter. If the brief meant the requester's own home charter, that is a new data-capture requirement and a separate spec, not something this implementation could have built from data that does not exist.
4. **The precise on-screen copy** for the "does not create a ticket" notice, the duplicate-draft warning, and the truncation disclosure. The addendum fixes the CC helper-text sentence verbatim, and this implementation uses it exactly (`DELIVERY_REQUEST_CC_NOTICE` in `apps/web/src/lib/site.ts`). The other three sentences — quoted in Sections E and G above — are written to the brief's stated principle (accuracy over optimism, never claim a ticket exists) rather than to any recorded exact string. If the owner's original brief specified different wording, these three sentences and the tests asserting them need to be updated.
