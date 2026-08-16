# The Zendesk DC4 email intake: what StockPilot sends it, and what may not change without a Zendesk-side check

Status: contract documentation, written 2026-08-16. No code was changed for this
document; every claim cites the file and, where one exists, the pinning test
that enforces it. Same-file citations use TEST NAMES rather than line
numbers — line numbers drift the moment a neighbouring test is added, and
this document has already outlived one such drift.

## Why this document exists

Learn4Life's warehouse ticketing runs on Zendesk's **email intake**: mail sent
to `dc4@learn4life.org` becomes a Zendesk ticket. Two StockPilot features
compose mail to that address — the **delivery-request assistant** (web
storefront, web order-detail page, and the mobile order screen) and the
**maintenance-request email** (web and mobile). Ticket creation therefore
depends on properties of our email that, until now, nothing outside code
comments protected. This document records those properties, states which of
them StockPilot can and cannot verify, and lists what must be confirmed with
whoever administers the Zendesk instance before certain changes are safe.

The single most important structural fact: **StockPilot never sends this
mail.** It composes a draft and opens it in the employee's own mail client
(`apps/web/src/components/orders/storefront/delivery-request-action.tsx:28-31`);
the employee reviews, may edit, and presses Send from their own mailbox.
Consequences:

- The Zendesk **requester** is the employee who sent the mail, not StockPilot.
- StockPilot can never confirm a ticket exists and no UI copy may claim one
  does (`packages/core/src/orders/delivery-request-recipients.ts:37-41`;
  status vocabulary deliberately has no "sent" or "ticket created" state,
  `packages/core/src/maintenance/constants.ts:62-68`).
- Everything below describes what the compose window is **prefilled** with.
  The employee can edit any of it before sending, so the Zendesk side must
  already tolerate deviation from these shapes — a fact worth remembering when
  weighing how much any trigger can safely depend on them.

## How the mail reaches the intake (transports)

Four transports carry the same composed message; which one is used changes
nothing about the intended recipients, subject, or body, but the mechanics are
the reason the mandatory CC arrives at all:

1. **Outlook Web deep link** — `https://outlook.cloud.microsoft/mail/deeplink/compose?mailtouri=<encoded inner mailto URI>`
   (`packages/core/src/email/outlook-compose.ts:48,323-339`). Two quirks are
   load-bearing and tenant-verified:
   - A plain `cc=` parameter on the compose deep link is **silently dropped**
     by OWA (owner test against the live L4L Microsoft 365 tenant,
     2026-08-01). The whole message therefore rides inside a single
     `mailtouri=` parameter, whose mailto parser honors `cc` per RFC 6068
     (`packages/core/src/orders/delivery-request.ts:701-755`).
   - The host must be `outlook.cloud.microsoft`, never `outlook.office.com` —
     the office.com domain-migration redirect drops the compose path and lands
     the user on their bare inbox (owner hit this live, 2026-08-02;
     `packages/core/src/email/outlook-compose.ts:6-9`, pinned as a literal at
     `packages/core/src/email/outlook-compose.test.ts:49`).
2. **Native Outlook app** — `ms-outlook://compose?to=&cc=&subject=&body=`,
   used by the phone when the app is installed
   (`packages/core/src/email/outlook-compose.ts:341-377`; CC-presence gate
   pinned at `packages/core/src/email/outlook-compose.test.ts:202`).
3. **`mailto:`** — the popup-blocked / no-Outlook fallback on web and a
   button on mobile (`packages/core/src/email/outlook-compose.ts:389-401`).
4. **Clipboard text** — labelled `TO:` / `CC:` / `SUBJECT:` / `MESSAGE:`
   blocks the employee pastes by hand when no link can open
   (`packages/core/src/email/outlook-compose.ts:412-421`, pinned at
   `packages/core/src/email/outlook-compose.test.ts:140`). On this path the
   delivered message's byte shape is whatever the employee assembles.

## The recipients, and what each address means

Defined once, in `packages/core/src/orders/delivery-request-recipients.ts:58-61`
(delivery) and `packages/core/src/maintenance/constants.ts:14-17`
(maintenance) — both currently the same pair:

- **To: `dc4@learn4life.org`** — the ticket-creating intake. Mail here becomes
  a Zendesk ticket through Zendesk's email channel, which is entirely outside
  StockPilot's observation. Nothing in this repository calls a Zendesk API for
  this flow (the separate Zendesk console work, PR #39/#40, is unrelated to
  intake mail).
- **Cc: `arosas@cvwest.org`** — Andrew Rosas receives a **direct copy**. This
  CC is the workflow's acceptance gate: the builder throws rather than compose
  a draft without it (`packages/core/src/orders/delivery-request.ts:135-140`),
  and every transport is separately pinned to carry it
  (`packages/core/src/orders/delivery-request.test.ts:116-129`).
  **The copy is the only promise.** Existing Zendesk rules MAY use the CC to
  route or assign, but StockPilot cannot observe that, so no StockPilot copy
  may promise it. The allowed sentence is interpolated, never retyped:
  "A copy will also be sent to arosas@cvwest.org"
  (`packages/core/src/orders/delivery-request-recipients.ts:138-139`,
  `packages/core/src/maintenance/constants.ts:39-40`). "This ticket will be
  assigned to him" is not an allowed sentence.

A branch in flight (per-org email routing) moves these constants to org
configuration. That changes where the values are read from, not the contract
in this document; the validation seam it will pass through is
`deliveryRequestRecipients(...)` in
`packages/core/src/orders/delivery-request.ts:238-251`.

### Display-name chips

On the Outlook Web transport only, the addresses ride as name-addr strings —
`Fresno Warehouse DC4 <dc4@learn4life.org>` and
`Andrew Rosas <arosas@cvwest.org>` (`delivery-request-recipients.ts:91-94`,
tenant-verified 2026-08-01). The native app, `mailto:` and clipboard transports
all carry **bare addresses**, deliberately
(`packages/core/src/orders/delivery-request.test.ts:131-144`). The intake
therefore already receives a mix of mail with and without display names, which
is positive evidence that no Zendesk rule can be depending on them.

## What the intake receives today: the delivery request

All shapes below are produced by `buildDeliveryRequestDraft` in
`packages/core/src/orders/delivery-request.ts` and pinned by the web suite
`apps/web/src/components/orders/storefront/storefront-logic.test.ts` (153
tests, running against the web re-export shim), plus
`delivery-request-action.test.tsx` (51), the cross-surface parity suite
`delivery-request-parity.test.tsx` (11), the mobile suite
`apps/mobile/src/lib/delivery-request-actions.test.ts` (66 authored blocks, 84 at runtime via it.each), and core's own
`delivery-request.test.ts` / `outlook-compose.test.ts`.

### Subject

Two formats since 2026-08-16 (owner decision; one shared format before that),
exact bytes (em-dash, not hyphen):

```
Delivery Request — <location>     (delivery orders)
Pickup Request — <warehouse>      (pickup orders)
```

- Delivery order with a site: `Delivery Request — CVW Clovis`
  (pinned `storefront-logic.test.ts`, "carries just the destination for
  delivery").
- Legacy delivery rows with no charter: the warehouse name —
  `Delivery Request — DC4`.
- Pickup order: `Pickup Request — DC4` — the origin warehouse; a pickup order
  has no destination site by CHECK constraint (pinned `storefront-logic.test.ts`,
  "uses a PICKUP-specific format").
- Unusable warehouse name: `Delivery Request — (warehouse not recorded)` /
  `Pickup Request — (warehouse not recorded)`.

Consequence for Zendesk: any trigger matching the literal `Delivery Request`
no longer sees pickup mail. Whether such a trigger exists is unverified
assumption 2 below — confirm it with the Zendesk administrator.

The subject deliberately carries **no order number** (owner decision
2026-08-02; pinned in `storefront-logic.test.ts` ("no order number in the subject" pins)) and is guaranteed a
single line (the "subject is a single line" pin in `storefront-logic.test.ts`). Any Zendesk trigger keyed on
subject text can only be matching the literal words `Delivery Request` and the
location — nothing else is there.

### Body

Plain text. Blocks joined by one blank line; an inapplicable block is omitted
entirely, never printed empty. Block order is a truncation contract — identity
and routing before the item list (the block-order comment above the body composer in `delivery-request.ts`,
pinned by the block-order describe in `storefront-logic.test.ts`).

Header block, exact shape (pinned `storefront-logic.test.ts:619,729,793-794`):

```
DELIVERY REQUEST — StockPilot

Order: SO-000049
Requested by: Marissa Delgado (mdelgado@learn4life.org)
Fulfillment method: Delivery
```

- **The `Order:` line is the correlation handle** — the one machine-findable
  link from a ticket back to a StockPilot order, since the subject dropped the
  number. Format `SO-` + six-digit zero-padded number
  (`packages/core/src/orders/order-number.ts`); when the order number is
  missing it degrades to an eight-character id fragment, visibly not an SO
  number (`delivery-request.ts:463-466`). The body never contains an order
  URL (owner decision 2026-08-01; pinned `storefront-logic.test.ts:690-719`).
- `Requested by:` carries the requester's email when known — the one contact
  DC4 can actually reach.
- `Fulfillment method:` is `Delivery` or `Pickup / will-call` (pinned
  `storefront-logic.test.ts:794`).

Then, for delivery:

```
FROM (WAREHOUSE)
DC4

DELIVERY DESTINATION
CVW Clovis (CVW-CLO)
1295 Shaw Ave
Fresno, California 93612
```

(Address lines only when the charter has an address — 4 of 16 prod charters do
not; site-data typos are reproduced verbatim. A delivery order with no charter
gets an honest "Not recorded on this order..." destination block,
`delivery-request.ts:598-606`.)

For pickup (pinned by the pickup-body tests in `storefront-logic.test.ts`):

```
PICKUP FROM
DC4 will-call desk

COLLECTED BY
Branden Vincent-Walker (branden@cvwest.org)
```

Then, in order: `NEEDED BY` (org-timezone rendered, zone named, omitted when
unset — 70 of 78 prod orders have none), the item list, `ORDER NOTES`
(omitted when empty):

```
ITEMS (2 lines, 7 units)
1. L4L Polo (Women's) — APP-POLO-W — qty 5
2. L4L Water Bottle — GEN-BOTL — qty 2
```

### The shortened ladder — the body is not always complete

Compose URLs truncate silently past roughly 2,000 characters, so drafts are
fitted to a 1,800-character ceiling (`DRAFT_URL_LIMIT`,
`packages/core/src/email/outlook-compose.ts:69`) by dropping, in a measured
ladder: per-line SKUs and the street address and order notes, then item rows
from the end (`prepareDeliveryRequest`, `delivery-request.ts:1000-1088`).
Shortened rows read `1. Composition Notebook Wide Rule x12`. A shortened body
always **says what it dropped**, in a fixed disclosure sentence beginning:

```
This message was shortened because the full item list did not fit in a compose link.
```

(`delivery-request.ts:339-394`, count-accurate variants pinned at
`packages/core/src/orders/delivery-request.test.ts:697-717`.)

Consequence for Zendesk: the intake already receives full bodies, partially
listed bodies, and heading-only bodies for the same feature, and the row
format differs between full and shortened drafts. No Zendesk-side parsing of
the item section can be assumed stable, and none should be built without
moving this contract to something machine-stable first.

## What the intake receives today: the maintenance request

Same recipients, composed by `buildMaintenanceEmailDraft`
(`packages/core/src/maintenance/email.ts:270-283`). Subject:

```
[StockPilot Maintenance MR-2026-000123] Air conditioner is not working in Room 204
```

(pinned `packages/core/src/maintenance/email.test.ts:109`). The bracket prefix
is omitted entirely when there is no request number, and re-prefixing on reply
or paste is deduplicated so exactly one prefix survives
(`email.test.ts:434-435,486-489,501`). The body is labelled sections beginning
`MAINTENANCE REQUEST`, with a `StockPilot Request:` line as the correlation
handle. The maintenance subject's bracket tag is the one subject shape a
Zendesk rule could plausibly key on that carries a machine-ish token; if such
a rule exists it is undocumented on our side (see below).

## Safe to change vs. needs a Zendesk-side check first

StockPilot cannot see the Zendesk configuration, so "safe" below means one of
two things: the intake demonstrably already tolerates the variation today, or
the change cannot alter what is delivered.

Safe without a Zendesk-side check:

- **Transport mechanics** — which compose URL is used, encoding details,
  ladder thresholds, `DRAFT_URL_LIMIT`. Zendesk receives an email either way.
- **Display-name chips** — already present on one transport and absent on
  three, so nothing on the Zendesk side can be relying on them.
- **Item-section content and row format** — the intake already receives full,
  partial and heading-only variants; the employee can edit the body anyway.
- **Adding body content below the header block** — subject to the existing
  allow-list rules (no staff-only figures, no invented fields:
  the allow-list describe in `storefront-logic.test.ts`).
- **UI copy around the feature** — provided it keeps the accuracy rules: never
  claim a ticket exists, never promise CC-based routing.

Needs a Zendesk-side check (or an owner decision accepting the risk) first:

- **The To address.** Changing it points the feature at a different or
  nonexistent intake. This is the whole contract.
- **The CC address or its removal.** The copy to Andrew is the workflow's
  acceptance gate, and any Zendesk routing rules that DO reference the CC are
  invisible to us.
- **Subject wording** — the literal `Delivery Request` / `Pickup Request`
  text, the `[StockPilot Maintenance ...]` bracket tag, or the em-dash
  separator. A trigger or view keyed on any of these would silently stop
  matching. (The pickup-specific `Pickup Request — <warehouse>` subject is an
  owner decision that shipped 2026-08-16; any Zendesk rule matching `Delivery
  Request` no longer sees pickup mail. Confirm with the Zendesk owner
  promptly.)
- **The `Order:` / `StockPilot Request:` line format** — the only correlation
  handles a Zendesk macro or human search can rely on.
- **Anything that changes who the sender is** — e.g., ever moving from
  compose-in-the-employee's-client to server-side sending would change the
  Zendesk requester on every ticket, plus SPF/DKIM posture. That is a project,
  not an edit.

## Unverified assumptions — for the owner to confirm with the Zendesk administrator

StockPilot has no read access to the Zendesk instance. Each of the following
is assumed but has never been verified from this side:

1. Ticket creation is unconditional — any mail to `dc4@learn4life.org` becomes
   a ticket, with no allowlist, no subject filter, and no suspended-ticket
   trap that a first-time sender (a new employee's address) could fall into.
2. No trigger, automation, view or SLA rule matches on the subject literals
   `Delivery Request` or `[StockPilot Maintenance`. If any does, subject
   changes (including the pickup-subject change shipped 2026-08-16) need
   coordination.
3. The CC to `arosas@cvwest.org` is a courtesy copy only, and no Zendesk rule
   routes or assigns based on it. If a rule exists, changing the CC (including
   the per-org routing work in flight) needs coordination.
4. Nothing parses the body — the `Order:` line, the item rows, the block
   headings — beyond humans reading it. If anything does, the shortened-ladder
   variability documented above is a live risk to it.
5. Two drafts for one order (the repeat-draft case the UI warns about,
   `delivery-request-action.tsx:73-88`) create two tickets rather than
   threading into one; DC4's process tolerates the duplicates.
6. Replies from Zendesk go to the employee (the requester), and no
   StockPilot-side mailbox is expected to receive or act on them.
7. The intake accepts mail from every domain employees actually send from
   (`@cvwest.org`, `@learn4life.org`, personal accounts if any are in use).

Until confirmed, treat every one of these as unknown, not as false: the rule
for copy remains that StockPilot promises only what it can observe, which is
the compose window and nothing after it.
