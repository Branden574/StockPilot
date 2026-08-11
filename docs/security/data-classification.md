<!-- Provenance: compiled 2026-08-10. Table and column references are read from the
     schema in supabase/migrations/. Third-party retention figures are quoted from
     SECURITY.md's vendor data-flow section, which sourced them from the provider
     dashboards at the time; they are provider defaults and should be re-confirmed
     in each console before being used in a customer answer or a DPA. -->

# Data classification

What this system holds, and the handling rule for each class. The purpose is to
make "can this leave, and to where?" answerable without re-deriving it, and to
make the isolation mechanism for each class explicit — because the mechanisms
differ, and a control that protects one class does nothing for another.

Four classifications are used.

- **Restricted** — a disclosure is an incident. Never leaves the system, never
  appears in a log, never enters a model prompt.
- **Confidential** — tenant-owned. Crosses a tenant boundary only through an
  explicit, audited feature.
- **Internal** — operationally sensitive but not tenant-identifying on its own.
- **Public-by-design** — deliberately served to unauthenticated visitors.

## Summary

| Class                           | Examples                                                                                                          | Level                                                           | Primary isolation mechanism                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Auth material                   | password hashes, MFA factors and recovery codes, session/refresh tokens, API-key hashes, platform passphrase hash | Restricted                                                      | Supabase `auth` schema, not reachable from the app's `public` schema; hashed at rest; policies scoped to `auth.uid()` |
| Member PII                      | member name, email, avatar, device and session records, login history                                             | Confidential                                                    | RLS on org-scoped tables; `auth.uid()`-scoped policies for per-user rows                                              |
| Customer-portal external users  | `customer_users` rows, portal contacts, delivery addresses                                                        | Confidential                                                    | Separate external principal — **never** an `org_members` row; accepted-mapping-wins resolution                        |
| Tenant inventory and operations | items, stock levels, movements, locations, receipts, cycle counts, orders, returns, maintenance                   | Confidential                                                    | RLS keyed on `organization_id`, plus warehouse scoping where a member's access is partial                             |
| Financial figures               | unit cost, cost basis, PO totals and charges, price lists, approval thresholds, billing events                    | Confidential (cost basis: treat as most sensitive of the class) | Same RLS, plus permission gates on the surfaces that expose it                                                        |
| Uploaded media                  | item photos, attachments, procedure videos, signatures, maintenance and cycle-count photos                        | Confidential                                                    | Private buckets + storage policies + path-shape validation                                                            |
| Public-by-design                | org logo, curated public-catalog item fields, public order-link and share-link content                            | Public-by-design                                                | An explicit curation predicate, not an absence of a check                                                             |
| Audit and activity              | `audit_logs`, `activity_logs`, movement ledger attribution                                                        | Confidential, and **integrity-critical**                        | RLS; never rewritten; movement rows are never written for archive or delete                                           |
| Operational telemetry           | Vercel request logs, Supabase logs, error reports                                                                 | Internal                                                        | Provider access control; bodies are not logged                                                                        |

## Handling rules by class

### Auth material — Restricted

**What**: password hashes and identities in Supabase's `auth` schema; MFA factors;
`mfa_recovery_codes`; session and refresh tokens; `api_keys` (stored as a hash);
the platform org-deletion passphrase (stored as a scrypt hash with a random salt).

**Rules**

- Never returned to a client, never logged, never included in an export, never
  placed in a model prompt.
- Never compared in application code. Verification happens in the provider or in
  the dedicated hashing utility.
- `mfa_recovery_codes` is **trigger-write-only**: its `INSERT`, `UPDATE` and
  `DELETE` policies are literal denies, so even the owning user cannot forge or
  erase their own codes through PostgREST. Reads are scoped to
  `user_id = auth.uid()`.
- API keys are stored hashed; the plaintext is shown once at creation and is not
  recoverable.
- **A password write in SQL does not invalidate live sessions.** Session
  revocation is a separate action — see [`incident-response.md`](incident-response.md).
- Rotation and disclosure handling: [`secrets-policy.md`](secrets-policy.md).

**Tested at**: `supabase/tests/0027_mfa_recovery_codes.test.sql`,
`apps/web/src/lib/auth/api-key.test.ts`,
`apps/web/src/lib/auth/platform-passphrase.test.ts`,
`apps/web/src/server/actions/mfa-recovery.test.ts`.

### Member PII — Confidential

**What**: name, email, avatar path, role and permission overrides; device
registrations and active sessions; login history.

**Rules**

- Visible to members of the same organization, subject to RLS and to permission
  gates on the surfaces that render it.
- A **disable reason is not readable by the disabled member** — it is
  administrative commentary about a person, and migration 0311 restricts its
  visibility deliberately.
- Avatar reads are scoped to the owning user's folder, proven end-to-end against
  `storage.objects` rather than as policy text
  (`supabase/tests/0322_quantity_guards_avatar_scope_override_clears.test.sql`).
- Outbound email carries the recipient's own address and name plus order content.
  It must not carry other members' emails — `SECURITY.md`'s Resend entry states
  this as the boundary, and it is the rule to preserve when adding a template.
- **Error responses must not disclose account existence.** Auth error
  classification is deliberately non-committal, and migration 0318 closed
  `auth_user_exists_by_email` to anon precisely because it was an
  account-existence oracle — the primitive that makes credential stuffing
  efficient.
- Never in a model prompt. `SECURITY.md` records that member identities are not
  sent to the AI provider; keep that true when adding a tool.

**Tested at**: `apps/web/src/server/actions/auth-error-classify.test.ts`,
`supabase/tests/0311_restrict_disable_reason_visibility.test.sql`,
`apps/web/src/server/services/platform/sessions.test.ts`,
`apps/web/src/server/services/team.remove-member-sessions.test.ts`.

### Customer-portal external users — Confidential

**What**: `customer_users` and the B2B portal principal — an external contact of
a tenant's customer, plus delivery locations and portal-submitted orders.

**Rules**

- This is a **distinct principal type**. A customer user is **never** an
  `org_members` row, and the two must not be conflated in a policy or a
  permission check: an external contact granted a member's visibility would see
  the tenant's whole catalog and cost basis.
- The portal catalog is decided by an **allowlist**, not by a filter over
  everything. In no-charge mode the allowlist alone decides what is visible.
- A customer user sees their own account's orders and the catalog allowed to
  them, and nothing about the tenant's other customers.
- Magic-link authentication for the portal is a separate flow from member
  sign-in; do not reuse a member session path for it.

**Tested at**: `supabase/tests/0250_b2b_customers.test.sql`,
`supabase/tests/0251_portal_order_source.test.sql`.

### Tenant inventory and operations — Confidential

**What**: the bulk of the product — items, stock levels and placements, the
movement ledger, locations, receipts, purchase orders, cycle counts, orders,
returns, rentals, maintenance requests.

**Rules**

- Isolation is **RLS keyed on `organization_id`**, on every table that has one
  (INV-A1). Table-level grants are not the control: `authenticated` holds
  `SELECT`/`INSERT`/`UPDATE`/`DELETE` on nearly all of these by Supabase default.
- Where a member's access is partial, **warehouse scoping** applies on top of org
  scoping — the movement ledger and the PO list are both warehouse-scoped
  (migrations 0321, 0322).
- Cross-tenant confirmation oracles count as disclosure. The `*_in_org` helpers
  were closed to anon in 0318 for exactly this reason: "does item X belong to org
  Y?" is a leak even when it returns only a boolean.
- Never in a model prompt beyond what a tool result legitimately returns, and
  every tool result is filtered server-side through the service context and RLS
  first. AI tool reads are asserted org-scoped
  (`apps/web/src/lib/ai/tools.security.test.ts`,
  `supabase/tests/0320_semantic_search_org_scope.test.sql`).
- Model-supplied text is treated as untrusted and is fenced before it can reach a
  write tool (`apps/web/src/lib/ai/untrusted.test.ts`,
  `apps/web/src/lib/ai/chat.write-guard.test.ts`).

### Financial figures — Confidential, cost basis most sensitive

**What**: unit cost and cost basis, PO totals and charges, price lists and
customer-specific pricing, spend-control approval thresholds, `billing_events`.

**Rules**

- Same RLS as the rest of tenant data, plus permission gates on the surfaces that
  expose cost. Cost basis is the figure a tenant would least like to see leave,
  and `SECURITY.md` already records it as explicitly **not** sent to Resend.
- Approval thresholds are an authorization input, not a display value: a PO
  approve path must honour the threshold server-side
  (`apps/web/src/server/services/po-imports.approval-threshold.test.ts`).
- Billing columns on the organization row are locked against tenant edit
  (`supabase/tests/0218_lock_org_billing_columns.test.sql`) — a tenant must not be
  able to grant itself a plan.
- Exports containing cost are subject to the export throttle and to
  formula-injection sanitisation on the filename and cell content
  (`apps/web/src/lib/exports/filename.test.ts`).

### Uploaded media — Confidential

**What**: item photos and thumbnails, item and PO and order attachments,
procedure videos, order signatures, maintenance photos, cycle-count and
size-count scan images.

**Rules**

- Buckets are **private** except the two allowlisted public ones
  (`org-logos`, `user-avatars`) — INV-D3. Access is by **signed URL**, minted
  server-side.
- A client-supplied storage path is validated against a **strict positive shape**
  before any sign, download or delete — INV-D1. The prefix check this replaced was
  the HI-8 traversal vulnerability: it let a caller escape the org folder _and_
  the bucket and receive a service-role-signed URL that RLS never evaluated.
- The database refuses the traversal alphabet independently of the writer —
  INV-D2, migration 0323 — because PostgREST inserts bypass the service layer.
- Uploads are verified by **magic bytes**, not by the declared content type
  (`apps/web/src/lib/image-signature.test.ts`), and every bucket carries a
  size cap and, where applicable, a MIME allowlist.
- Signatures are stored as a data URL on the order row and are rendered on white;
  treat a signature as PII, not decoration.
- **A storage delete is not transactional with the database.** Delete the object
  after the row change commits (see [`destructive-actions.md`](destructive-actions.md)).

### Public-by-design

**What**: the org logo; the curated subset of item fields exposed through a public
catalog link; public order-request links; maintenance share links.

**Rules**

- Visibility is decided by **one predicate**, and the same predicate governs
  render, submit and thumbnail generation. Curation is a positive allowlist, not
  "everything minus some filters" — one predicate means there is one place to be
  wrong, and it is asserted rather than assumed.
- A share-link token grants access to **its own** content only; the photo proxy
  for a maintenance share link serves photos belonging to that token and no others
  (`apps/web/src/app/m/[token]/photo/[n]/route.test.ts`).
- `share_links` has **no** authenticated write policy — every write goes through
  the guarded seam (`apps/web/src/server/services/maintenance-share-links.test.ts`).
- Public submission paths are rate-limited and scope-restricted. Anonymous reads
  of a curated catalog are expected; anonymous **writes** are not, and are refused
  by policy.

### Audit and activity — Confidential and integrity-critical

**What**: `audit_logs`, `activity_logs`, and the `stock_movements` ledger with its
actor attribution.

**Rules**

- **Append-only in practice.** Rows are not rewritten to make history tidier. The
  movement ledger is the reconstruction of what happened to stock, and its value
  is entirely in not having been edited.
- **No movement row is written for an archive or a delete.** Those are lifecycle
  events, not stock events, and writing them corrupts the ledger's meaning.
- Attribution is pinned server-side, not taken from the client (migration 0321).
- A movement note can be edited through a single guarded RPC that records the
  edit; nothing else may modify a movement row
  (`supabase/tests/0307_edit_movement_note_sentinel_guard.test.sql`).
- The integrity property matters most **during** an incident: this is the evidence
  used to establish scope. Anything that rewrites it destroys the ability to
  answer "what did the attacker touch?".

### Operational telemetry — Internal

**What**: Vercel request logs (method, path, status, IP, user agent — bodies are
**not** logged), Supabase logs, error reports routed through `reportError()`.

**Rules**

- Application errors go through `reportError()` rather than raw `console.error`,
  so sensitive detail does not land in function stdout, which **is** captured.
- Client-facing error messages are sanitised at the service boundary: an internal
  error does not carry database or stack detail outward
  (`apps/web/src/server/services/service-error.test.ts`).
- Log retention is the provider's: Supabase built-in retention is 7 days on the
  Pro tier, and external log drains are deliberately deferred as a Team-plan
  feature ([`docs/runbooks/security-monitoring.md`](../runbooks/security-monitoring.md)).
  **That 7-day window is the forensic horizon** — it bounds how far back an
  incident can be reconstructed from logs, and it is the reason
  [`incident-response.md`](incident-response.md) puts evidence capture before
  containment.

## What leaves the system, and to where

`SECURITY.md` holds the authoritative vendor data-flow section. The
classification-relevant summary:

| Destination | Classes sent                                                                                                                                                                                          | Retention at destination                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase    | everything (it is the system of record)                                                                                                                                                               | managed backups; logs 7 days on Pro                                                                                                    |
| Resend      | recipient email and name, request id, line summary (item names, quantities), org name and logo URL. **Not** cost basis, supplier names, internal notes, warehouse locations, or other members' emails | delivery-log retention, 7 days by default                                                                                              |
| AI provider | the user's message plus matching tool-call results; a single uploaded image per vision call. **Not** org name or member identities                                                                    | provider-dependent; the free tier retains for abuse review, so production traffic belongs on a paid project to opt out of training use |
| Stripe      | org id as customer metadata, plan id, owner email. **No** inventory data                                                                                                                              | standard customer and subscription objects                                                                                             |
| Expo Push   | device push token, notification title and body, a deep-link payload                                                                                                                                   | 30 days for delivery receipts                                                                                                          |
| Vercel      | request metadata; bodies not logged                                                                                                                                                                   | provider-dependent                                                                                                                     |

Adding a destination, or widening what an existing one receives, is a change to
this table and needs the same scrutiny as a schema change.

## Known limitations

- **No field-level encryption** beyond hashing of auth material. Confidential data
  is protected by RLS and transport encryption, not by encryption at rest under a
  key the application holds.
- **No data-retention automation** for most classes. Two purge paths exist (read
  notifications, AI chat history older than 30 days) and both are service-role
  cron routes closed to anon by migration 0318. Everything else is retained
  indefinitely.
- **No formal DPA set or data-processing register**; this table is the closest
  thing and is internal documentation, not a legal artifact.
- **No classification labels in the schema.** The classification lives here, in
  prose, which means it can drift from the tables it describes. When adding a
  table that holds a new kind of data, update this document in the same change.
