<!-- Provenance: compiled 2026-08-10. Mapped against OWASP ASVS 4.0.3 chapter
     structure (V1-V14) at CATEGORY granularity, not requirement-by-requirement.
     ASVS 5.0 reorganized and renumbered the chapters; a category-level mapping
     survives that renumbering, which is part of why this granularity was chosen.
     Every "Evidence" reference is a path in this repository. No ASVS
     verification level is claimed, and no requirement is marked met on the
     strength of a plausible-sounding control alone — see section 3. -->

# OWASP ASVS mapping

A category-level map from ASVS chapters to the controls actually implemented here,
so that a security questionnaire can be answered from evidence rather than from
memory.

## How to read this, and what it is not

**This is a self-assessment at category granularity.** It is deliberately not a
requirement-by-requirement checklist, for two reasons: a per-requirement claim
implies a per-requirement verification that has not been performed, and this
application is not the kind of system ASVS's more prescriptive requirements were
written for (there is no public registration, no password-based federation, no
payment-card handling).

**No ASVS level is claimed.** Claiming L1, L2 or L3 asserts completeness across a
whole chapter, and that assertion has not been tested. What is asserted is
narrower and checkable: the specific controls named below exist at the paths
named, and the ones marked as tested have assertions behind them.

Three statuses are used.

- **Met** — the category's substantive requirements for this system are
  implemented **and** covered by a test or a mechanical guard.
- **Partial** — a real control exists but has a stated gap. The gap is named. A
  "Partial" here is an honest ceiling, not a rounding-down.
- **Not applicable** — the category addresses a capability this system does not
  have. The reason is given; "not applicable" is never used to avoid a gap.

## 1. The map

### V1 — Architecture, Design and Threat Modeling — **Partial**

Documented threat model with named actors in priority order (`SECURITY.md`), a
written vendor data-flow, a data classification
([`data-classification.md`](data-classification.md)), and a falsifiable invariant
set ([`SECURITY-INVARIANTS.md`](SECURITY-INVARIANTS.md)) with the machine-checkable
subset executable.

_Gap_: no formal per-feature threat-modeling step in the development process — the
threat model is a document that is revisited, not a gate a change passes through.
No third-party architecture review.

### V2 — Authentication — **Partial**

Supabase Auth for identity. TOTP MFA with **server-side AAL2 enforcement**: every
`assertPermission()` gate refuses to fire when the organization's `mfa_policy`
requires MFA and the session is at AAL1, so the enforcement is not merely a UI
prompt. Per-org policy (`optional` | `admins_required` | `all_required`). MFA
recovery codes are trigger-write-only — the `INSERT`/`UPDATE`/`DELETE` policies
are literal denies, so a user cannot forge or erase their own codes through
PostgREST. Invite-only membership; no public sign-up. Account-existence disclosure
is closed on both the error-classification path and at the database (migration
0318 closed `auth_user_exists_by_email` to anon). Auth email is sent through a
`generateLink` + Resend path because the built-in mailer caps at roughly two per
hour and fails silently.

_Evidence_: `supabase/tests/0027_mfa_recovery_codes.test.sql`,
`apps/web/src/lib/auth/api-context.aal.test.ts`,
`apps/web/src/server/actions/auth-error-classify.test.ts`,
`apps/web/src/server/actions/mfa-recovery.test.ts`.

_Gap_: password policy and credential-stuffing protection are Supabase's built-in
defaults, not independently verified here. Email confirmation on sign-up is a
dashboard setting that `SECURITY.md` flags as needing owner verification rather
than something asserted in code.

### V3 — Session Management — **Partial**

Provider-managed tokens. Global revocation through
`signOut({ scope: 'global' })`, which invalidates every refresh token for the
user. A device and active-session list with force-logout, delivered as a realtime
**broadcast** (migration 0213) with the client responding
`signOut({ scope: 'local' })`. Per-user session-revocation RPCs
(`revoke_my_session`, `revoke_my_other_sessions`) scoped to `auth.uid()`. Removing
a member revokes their sessions. Account disable enforces at the **RLS layer**
(migrations 0308-0311), so a disabled account is refused at the database even
holding a valid token.

_Evidence_: `supabase/tests/0213_user_sessions_management.test.sql`,
`supabase/tests/0310_rls_blocks_disabled_accounts.test.sql`,
`apps/web/src/server/services/team.remove-member-sessions.test.ts`.

_Gap, and it is the material one_: **JWT TTL is the Supabase default of 3600
seconds.** After a global sign-out, an already-issued access token stays valid for
up to an hour. `SECURITY.md` recommends 600 seconds and that change has not been
confirmed applied. This is a containment-window gap, documented as such in
[`incident-response.md`](incident-response.md) section 0.

### V4 — Access Control — **Met**

The strongest category here, and the one this program spent most of its effort on.

Row-level security on **every** table in `public` — 89 of 89 org-scoped tables,
asserted with no allowlist (INV-5). Configurable permissions driving application
gates, RLS predicates and navigation, with the owner role immutable and override
grants unable to escalate beyond what the granting admin holds. Warehouse scoping
layered on org scoping where a member's access is partial (migrations 0321, 0322).
Views are `security_invoker = true` so none reads through RLS as its owner
(INV-8), and materialized views — which cannot carry RLS at all — are refused
outright (INV-9). Function-privilege posture is closed and asserted: no ungated
`SECURITY DEFINER` function in `public` is anon-executable (INV-1), with the
allowlist required to justify itself (INV-2). Anon/PUBLIC-reachable write policies
must consult identity or deny outright (INV-22). Policy-predicate hygiene sweeps
for literal-true predicates (INV-11) and self-comparison tautologies (INV-12).

_Evidence_: `supabase/tests/security_invariants.test.sql` (23 assertions),
`0318_secdef_grants.test.sql`, `0215_permission_override_no_escalation.test.sql`,
`0217_crownjewel_critical_rls_fixes.test.sql`,
`0220_org_members_insert_owner_guard.test.sql`,
`0236_picking_rpcs_warehouse_scoped.test.sql`,
`0321_movement_read_scope_and_attribution.test.sql`,
`0322_quantity_guards_avatar_scope_override_clears.test.sql`.

_Why "Met" rather than "Partial"_: the controls exist, they are asserted
class-wide rather than instance-by-instance, and the assertions have been
mutation-checked. The two accepted risks in section 7 of the invariants document
are scoped read-breadth issues with documented prerequisites, not access-control
absences — and both are pinned so they cannot lapse quietly.

### V5 — Validation, Sanitization and Encoding — **Partial**

Zod schemas at trust boundaries on server actions and API routes. **Storage-path
validation against a strict positive shape** rather than a prefix check — the HI-8
fix, with a redundant character/segment denylist in front of the shape match
(`apps/web/src/lib/storage-path.ts`), and a database-level refusal of the
traversal alphabet underneath it that applies to PostgREST writers the service
layer never sees (migration 0323). **Upload content verified by magic bytes**, not
by declared content type. CSV/export formula-injection guard and filename
sanitisation. Scheme allowlists on rendered links. Open-redirect guard on return
paths. SSRF guard on every server-side fetch of a user-supplied URL, including
re-resolution on **each redirect hop**. AI-specific input handling: model-supplied
text is fenced as untrusted and de-fenced on the way in, so it cannot reach a
write tool unmediated.

_Evidence_: `apps/web/src/lib/storage-path.test.ts`,
`apps/web/src/server/services/storage-path-traversal.test.ts`,
`apps/web/src/lib/image-signature.test.ts`, `apps/web/src/lib/ssrf-guard.test.ts`,
`apps/web/src/lib/safe-return-path.test.ts`,
`apps/web/src/lib/exports/filename.test.ts`,
`apps/web/src/lib/ai/untrusted.test.ts`,
`apps/web/src/lib/ai/chat.write-guard.test.ts`,
`supabase/tests/0323_storage_path_shape_constraints.test.sql`.

_Gap_: validation coverage is per-boundary and verified per-boundary; there is no
sweep asserting that every route validates its input. Output encoding relies on
React's default escaping, with hand-audited exceptions in the email templates
(attribute-context URL escaping is a known landmine there).

### V6 — Stored Cryptography — **Partial**

Password hashing is the provider's. API keys are stored hashed, with the plaintext
shown once and unrecoverable. The platform org-deletion passphrase is scrypt with
a random salt. Integration credentials are held in Supabase Vault. Transport is
TLS with HSTS preload; a daily cron watches certificate expiry.

_Evidence_: `apps/web/src/lib/auth/api-key.test.ts`,
`apps/web/src/lib/auth/platform-passphrase.test.ts`.

_Gap_: **no application-level field encryption.** Confidential data is protected
by RLS and at-rest disk encryption at the provider, not by a key the application
holds. Recorded in [`data-classification.md`](data-classification.md) rather than
implied to be present.

### V7 — Error Handling and Logging — **Partial**

Errors are redacted at the service boundary: an internal error does not carry
database or stack detail to the client. Errors route through `reportError()`
rather than raw `console.error`, because function stdout **is** captured by the
platform. `audit_logs` and `activity_logs` are append-only in practice and are
never rewritten; the movement ledger's actor attribution is pinned server-side
rather than taken from the client. Hourly and six-hourly anomaly detectors cover
failed-login bursts, password-reset bursts, privilege escalation, mass
delete/archive and export abuse, with real-time `security.*` events for
new-device login, MFA changes, API-key lifecycle and role changes. All alerts land
in Slack.

_Evidence_: `apps/web/src/server/services/service-error.test.ts`,
`apps/web/src/server/security/monitors.test.ts`,
`supabase/tests/0321_movement_read_scope_and_attribution.test.sql`,
[`docs/runbooks/security-monitoring.md`](../runbooks/security-monitoring.md).

_Gap, and it bounds incident response_: **log retention is 7 days** on the current
Supabase tier and external log drains are deliberately deferred as a Team-plan
cost decision. There is no SIEM correlation and no alert on RLS-denial volume,
which would be the natural tenant-probing signal.

### V8 — Data Protection — **Partial**

Documented classification with per-class handling rules
([`data-classification.md`](data-classification.md)). Private storage buckets with
signed-URL access; public buckets are an allowlist of two, asserted (INV-19).
Bodies are not logged. Outbound email content is bounded by an explicit
"data NOT sent" list. Two retention purges exist (read notifications, AI chat
history older than 30 days), both service-role cron paths closed to anon by
migration 0318.

_Gap_: no retention automation for the remaining classes — most data is retained
indefinitely. No data-subject export or erasure workflow. No formal
data-processing register.

### V9 — Communication — **Met**

TLS throughout, HSTS with preload, CSP using `strict-dynamic`, hardened response
headers. Certificate expiry monitored daily. Every server-side fetch of a
user-supplied URL passes the SSRF guard, which classifies IP literals and
re-resolves on each redirect hop so a redirect to a private or metadata address is
refused.

_Evidence_: `apps/web/src/lib/ssrf-guard.test.ts`, `SECURITY.md`.

### V10 — Malicious Code — **Partial**

Semgrep SAST on a pinned version (OWASP Top Ten, JS/TS, React, Next.js and secrets
rulesets) failing the build on ERROR findings; TruffleHog with `--only-verified`
so a hit is a confirmed-live credential and failing on it is safe. TruffleHog is
installed from an **immutable version with an inline sha256 pin**, so neither an
upstream branch compromise nor a swapped release asset can execute code in CI.
Dependabot with a documented remediation record
([`dependency-hardening-2026-08.md`](dependency-hardening-2026-08.md)) and
version-scoped `pnpm.overrides`. `--frozen-lockfile` in CI.

_Gap, and it is the top open supply-chain item_: **pnpm 9.12.3 executes package
lifecycle scripts by default.** Migrating to pnpm 10.x with an
`onlyBuiltDependencies` allowlist removes that execution path, and
`minimumReleaseAge` would prevent a freshly-published malicious version from
resolving at all. CI is covered by the frozen lockfile; the developer workstation
is not. Also: CodeQL is deliberately omitted because SARIF upload on a private repo
needs GitHub Advanced Security.

### V11 — Business Logic — **Met**

This is where a warehouse system's real risk lives, and it is well covered.
Server-side enforcement of PO spend-control approval thresholds. Picking
claim-and-lock with self-release and manager override, so two pickers cannot claim
the same order. Cycle-count assignee locking — which closed a confirmed
takeover exploit — with explicit release and force-reassign paths. Backorder and
partial-fulfillment accounting separating shipped from staged quantities.
Over-receipt is an explicit allowed decision rather than an accident. Archive
refuses an item still holding stock unless the caller acknowledges it. Reopening a
completed pick reverses the stock draw and restores reservations rather than
merely flipping a status.

_Evidence_: `supabase/tests/0237_picking_claim_lock.test.sql`,
`0282_cycle_count_assignment_lock.test.sql`,
`0244_backorder_fulfillment_accounting.test.sql`,
`apps/web/src/server/services/po-imports.approval-threshold.test.ts`.

### V12 — Files and Resources — **Partial**

Buckets pinned with `allowed_mime_types` and `file_size_limit`; every bucket has a
size cap, asserted (INV-20). Magic-byte verification of upload content. Strict
positive-shape path validation before any sign, download or delete, with a
database-level traversal refusal underneath (INV-D1, INV-D2). Signed URLs rather
than public objects for everything except the two allowlisted public buckets.

_Gap_: **five path-bearing columns do not yet carry the database traversal floor**
(`item_attachments.storage_path`, `cycle_count_ai_scans.photo_storage_path`,
`import_jobs.storage_path`, `size_count_training_samples.image_storage_path`,
`support_tickets.attachment_path`). They are recorded in the invariant test's
known-gap allowlist so they appear in every CI run. Two buckets have no
database-level MIME allowlist and rely on application enforcement. No malware
scanning of uploads.

### V13 — API and Web Service — **Partial**

Bearer-token `/api/v1` twin for the mobile client sharing the same authorization
gates as the web paths. API keys are hashed and scope-checked. Cron and webhook
routes validate a shared secret and **fail closed when it is unset**. Rate limiting
is Postgres-backed with an atomic counter. Per-route gate tests assert auth, org
context and module entitlement. Edge bot protection with explicit bypass rules for
the mobile client.

_Evidence_: `apps/web/src/lib/auth/api-key.test.ts`, and the `route.gates.test.ts`
family (for example `apps/web/src/app/api/v1/items/upc-lookup/route.gates.test.ts`).
The rate limiter itself is the Postgres atomic counter added in migration 0048,
whose `increment_rate_limit` function was closed to anon by 0318 — see
`supabase/tests/0318_secdef_grants.test.sql`.

_Gap_: no generic sweep asserting that **every** route is gated — coverage is
per-route. A sweep over the cron routes specifically is feasible and is listed as a
follow-up in the [`README`](README.md). No formal API schema or contract test.

### V14 — Configuration — **Partial**

Secrets live outside the repository with three independent guards against
committing one ([`secrets-policy.md`](secrets-policy.md)). Hardened response
headers and CSP. CI gates on typecheck, tests, build, pgTAP and now
`pnpm security:test`. Dependency floors are version-scoped overrides with a
documented rationale.

_Gap_: several security-relevant settings live in provider dashboards rather than
in the repository and are therefore unverifiable from code — JWT expiry, email
confirmation, the Vercel Node.js major version (which must not be an
end-of-life 20.x), and the Supabase backup tier. `SECURITY.md` and
[`framework-patch-verification.md`](framework-patch-verification.md) both flag
these as owner-verify items, and they remain owner-verify.

## 2. Summary

| Chapter                                     | Status  |
| ------------------------------------------- | ------- |
| V1 Architecture, Design and Threat Modeling | Partial |
| V2 Authentication                           | Partial |
| V3 Session Management                       | Partial |
| V4 Access Control                           | **Met** |
| V5 Validation, Sanitization and Encoding    | Partial |
| V6 Stored Cryptography                      | Partial |
| V7 Error Handling and Logging               | Partial |
| V8 Data Protection                          | Partial |
| V9 Communication                            | **Met** |
| V10 Malicious Code                          | Partial |
| V11 Business Logic                          | **Met** |
| V12 Files and Resources                     | Partial |
| V13 API and Web Service                     | Partial |
| V14 Configuration                           | Partial |

Nothing is marked "Not applicable". Every chapter has something real in it for this
system, which is itself worth noting — the temptation with a category map is to
retire a chapter as irrelevant, and none of these qualified.

## 3. What this mapping does not establish

- **No independent verification.** This is a self-assessment. No third-party
  penetration test has been performed, and `SECURITY.md` already states that a
  tester with Burp would probably find more.
- **No ASVS level is claimed**, for the reason given at the top.
- **Category granularity hides variance.** A "Partial" can mean one narrow gap or
  several; read the gap sentence, not the label.
- **"Met" means the named controls exist and are tested**, not that the chapter is
  exhausted. The correct reading of this document is "these controls, at these
  paths, with these tests" — anything broader is overclaiming.
- **Provider-managed controls are inherited, not verified.** Password hashing, the
  auth rate limits and at-rest encryption are Supabase's implementation and were
  not independently assessed.

The defensible summary: **no known critical or high-severity vulnerability remains
open, a high-assurance baseline is implemented in the access-control, business-logic
and communication categories, and the remaining gaps are named above with the
control that would close each one.**
