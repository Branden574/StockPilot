<!-- Provenance: compiled 2026-08-10. Detection sources, cron cadences and alert
     routing are quoted from docs/runbooks/security-monitoring.md. Restore
     mechanics are in docs/runbooks/disaster-recovery.md and are not duplicated
     here. Provider console paths (Supabase, Vercel, Expo) were not re-walked
     while writing this; the sequences they encode are what matter and do not
     change with the UI. The JWT-TTL figure is the Supabase default recorded in
     SECURITY.md and must be re-read from the project settings during an actual
     incident, because it determines a containment deadline. -->

# Incident response

A runbook for a suspected or confirmed security incident in this stack. Written
for one operator working alone, because that is the real staffing.

Read section 0 first. It contains the three stack-specific facts that most often
turn a contained incident into a prolonged one.

**Reporting inbound**: `branden574@gmail.com`, subject `[security] StockPilot`,
acknowledged within 48 hours. Vulnerabilities are not filed as public GitHub
issues (`SECURITY.md`).

---

## 0. Three things to know before you start

### A password change does not end a session

Writing a new password — in SQL, in the Supabase dashboard, or through an admin
API — **does not invalidate anything already issued.** The attacker's session
keeps working. This is the single most common containment mistake, because
changing the password _feels_ like eviction.

Two separate actions are required, in this order:

1. **Revoke refresh tokens**: `signOut({ scope: 'global' })` for the user, which
   invalidates every refresh token across every device. Nothing else does this.
2. **Wait out the access-token TTL.** Already-issued access tokens stay valid
   until they expire. The Supabase default is **3600 seconds**, so after a global
   sign-out an attacker can still hold a working token for up to an hour.
   `SECURITY.md` recommends dropping this to 600 seconds
   (Supabase → Authentication → Sessions → JWT expiry) for exactly this reason —
   it turns a one-hour eviction window into ten minutes.

**Read the actual JWT expiry from the project settings during the incident and
write it down.** It is your containment deadline: until it passes, the account is
not evicted.

If the eviction has to be immediate and cannot wait out the TTL, escalate to
account disable (section 3), which fails closed at the RLS layer rather than
relying on token expiry.

### A native mobile security fix is not deliverable over the air

This is a response-time constraint, not an inconvenience, and it must be part of
triage rather than discovered during containment.

- **JS-only fixes to our own code**: OTA-deliverable. Minutes to hours. Ship with
  `pnpm release:ota` from `apps/mobile` — **never** a raw `eas update`.
- **A framework-level or native security fix**: **not OTA-deliverable.** It needs
  an SDK bump, an EAS native build, and a **store review**. Lead time is days to
  weeks and it is outside your control.
- `runtimeVersion` is pinned to `appVersion`, so a native change means a store
  release by construction.
- Mobile currently runs Expo SDK 53, which is **past Expo's support window**
  (`framework-patch-verification.md`). If the incident is in the RN/Expo layer
  there may be no upstream patch to take without a migration first.

The practical consequence: if a mobile-native issue is exploitable, plan a
**server-side mitigation** as the real containment — revoke the capability at the
API, disable the affected module for the org, or block the pattern at the edge —
and treat the client fix as remediation that arrives later.

### Your forensic window is about seven days

Supabase built-in log retention is **7 days on the Pro tier**, and external log
drains are deliberately deferred (a Team-plan feature —
[`docs/runbooks/security-monitoring.md`](../runbooks/security-monitoring.md)).
Vercel log retention is likewise provider-managed and finite.

So **evidence capture comes before containment cleanup**, and an in-place database
restore is an evidence-destroying operation. If the incident may need
reconstruction, restore to a **new** project and leave the original intact.

---

## 1. Detect

Live detection sources, all routing to Slack:

| Source                 | Watches                                                                                                                                                                         | Cadence         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `cron/audit-anomalies` | `audit_logs`: failed-login bursts per email and per IP, password-reset bursts, privilege escalations to admin/owner, mass deletes or archives per actor, export abuse per actor | hourly          |
| `cron/auth-anomalies`  | `user_login_devices`: a user registering 4 or more new devices in 24h                                                                                                           | every 6h        |
| `security.*` events    | new-device login, MFA unenroll or policy change, API-key create or revoke, role change, export-rate-limit trip                                                                  | real time       |
| `cron/ssl-check`       | TLS certificate expiry on the primary domain                                                                                                                                    | daily           |
| UptimeRobot            | `/api/health`                                                                                                                                                                   | every 5 min     |
| CI                     | Semgrep ERROR findings, TruffleHog verified secrets, `pnpm security:test`                                                                                                       | per push and PR |
| Dependabot             | dependency advisories                                                                                                                                                           | continuous      |

**Detection gaps to hold in mind**: the anomaly crons are hourly, so a fast attack
can complete inside one window; there is no centralized SIEM correlation; and
there is no alert on RLS denial volume, which would be a strong tenant-probing
signal. Absence of an alert is not evidence of absence.

Also treat as detection: an inbound report to the security address, a partner
noticing data that is not theirs, and an unexplained shift in a figure a tenant
would notice — stock counts, order totals, member lists.

---

## 2. Triage

Timebox this. The purpose is a containment decision, not a complete
understanding.

**Answer four questions, in writing.**

1. **Is it real?** Reproduce once if you can do so without widening exposure. A
   monitoring alert is a hypothesis.
2. **What class of data is reachable?** Use
   [`data-classification.md`](data-classification.md). Auth material or
   cross-tenant reach escalates immediately.
3. **Does it cross a tenant boundary?** Single-tenant scope is materially
   different from cross-tenant, both for severity and for who has to be told.
4. **Which layer, and therefore which delivery path?** Database policy, web
   application, mobile client, third-party provider, or credential. This decides
   whether a fix takes minutes (Vercel redeploy), hours (OTA), or weeks (store
   review — see section 0).

### Severity, and what each triggers

| Severity     | Definition                                                                                                                                         | Immediate action                                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Critical** | Cross-tenant data access, auth bypass, service-role key exposure, or unauthenticated write to tenant data                                          | Contain now, before root-cause analysis is complete. Rotate credentials. Consider taking the affected surface offline.                                                      |
| **High**     | Authenticated privilege escalation within one tenant, unauthorized read of a Restricted or Confidential class, unauthenticated read of tenant data | Contain the same day.                                                                                                                                                       |
| **Medium**   | Information disclosure without direct data access — an existence oracle, a verbose error, a cross-tenant confirmation primitive                    | Fix in the next deploy. Note that 0318's account-existence oracle was exactly this class and was still worth a P0-adjacent response, because it enables a different attack. |
| **Low**      | Hardening gap with no demonstrated path                                                                                                            | Backlog with a written rationale.                                                                                                                                           |

**Write the timeline as you go.** Timestamps, what you observed, what you ran,
what changed. Reconstructing it afterwards from a 7-day log window and memory does
not work, and the review in section 6 depends on it.

---

## 3. Contain

Order matters: **capture evidence, then stop the bleeding, then narrow access.**

### 3.1 Capture first (minutes)

- Export the relevant `audit_logs` and `activity_logs` rows for the window to a
  location outside the database.
- Pull Vercel logs for the affected paths before they age out.
- Note the current deployment SHA and the current Supabase migration head.
- **Do not** start an in-place restore yet. It overwrites the evidence.

### 3.2 Credential compromise — Supabase keys

If a service-role or secret key may be exposed:

1. Mint a new key: Supabase → Project Settings → API keys.
2. Set it in **Vercel** (production and preview).
3. **REDEPLOY.** Vercel reads environment variables at build/boot; changing the
   dashboard value does nothing to the running deployment.
4. **Verify with the canary**: exercise a path that _requires_ the service-role
   client — a cron route with its `CRON_SECRET`, or an invite send. On
   2026-07-21 a stale service-role key made **every** `createAdminClient()` path
   return 401 while ordinary reads kept working. The site looked completely
   healthy. "The dashboard loads" is not verification.
5. Only then revoke the old key at the provider.

Full detail and the per-credential table: [`secrets-policy.md`](secrets-policy.md).

For the anon/publishable key, remember it is embedded in the web bundle **and the
mobile binary** — rotating it requires a redeploy _and_ a mobile release, so plan
an overlap window rather than a hard cutover.

### 3.3 Account compromise — evict the session

1. `signOut({ scope: 'global' })` for the account. Refresh tokens die.
2. Note the JWT expiry and treat it as the deadline before the account is truly
   evicted (section 0).
3. Reset the password — **after** the revocation, not instead of it.
4. Re-enroll MFA if MFA material may be compromised; regenerate recovery codes.
5. Review the device and session list, and force-logout other devices. The
   force-logout path is a **realtime broadcast** (migration 0213), and the client
   listener responds with `signOut({ scope: 'local' })`.
6. If eviction must be immediate and cannot wait out the token TTL, use **account
   disable** (migrations 0308-0311): the guard is enforced in RLS itself, so a
   disabled account is refused at the database regardless of a valid token in
   hand. Note the deploy rule that comes with it — **migrations always first**,
   because the guard fails closed and code-before-migration is a total outage.

### 3.4 Application-layer vulnerability

- **Web**: fix forward and push to `main`. The GitHub integration auto-deploys —
  do **not** also trigger a deployment through the API, which produces a double
  deploy.
- **Web, when a fix is not ready**: roll back to the last known-good deployment in
  the Vercel dashboard. Rolling back is usually faster and lower-risk than a rushed
  patch. Check whether the current migration head is compatible with the older
  code before you do — a rollback past a migration boundary can be worse than the
  bug.
- **Edge**: the Vercel firewall can block a pattern or an IP through its REST API.
  This project already manages bypass rules there for the mobile client, so the
  mechanism is familiar. Useful when an attack is in progress and the fix is not
  ready.
- **Mobile**: see section 0. JS-only fix, OTA with `pnpm release:ota`. Anything
  native needs a store release, so mitigate server-side.

### 3.5 Database policy or function vulnerability

- The fix is a **new migration**. Never edit a shipped one; the highest existing
  number is the floor.
- A policy change is `drop policy` + `create policy` restating **every** conjunct.
  `alter policy ... with check` **replaces** the clause and silently drops
  conjuncts (INV-F1 in [`SECURITY-INVARIANTS.md`](SECURITY-INVARIANTS.md)).
- Before revoking `EXECUTE` on any function, check whether an RLS policy
  references it. RLS evaluates with the querying role's privileges, so revoking
  `authenticated` on a policy helper is a **write outage across the product**, not
  a tightening (INV-C1). During this program a mutation that did exactly that took
  12 test files down.
- Apply with `supabase db push --linked` after merge. A pending migration crashes
  pages, so do not leave the schema behind the code.
- Run `pnpm security:test` before and after.

### 3.6 Platform super-admin console

The `/platform` console is god-mode across every tenant. If a platform-admin
account may be compromised, that is **Critical by definition**.

- Enrollment is by email presence in `STOCKPILOT_PLATFORM_ADMIN_EMAILS` **plus
  AAL2**. Containment is therefore: remove the email from that variable in Vercel
  and **redeploy** — the same read-at-boot rule as any other environment change.
- Platform actions are step-up-protected and the destructive ones additionally
  require the org-deletion passphrase (stored as a scrypt hash). Confirm that
  passphrase was not also exposed.
- Review platform audit entries for the window before concluding scope.

---

## 4. Eradicate

Containment stops the bleeding. Eradication removes the cause.

1. **Root cause, in one written sentence.** If it cannot be written in one
   sentence, it is not understood yet.
2. **Fix the class, not the instance.** 0318 is the model: the finding was one
   `PUBLIC`-executable function, and the fix covered all 15 exploitable ones plus
   an allowlist-based invariant that fails on the sixteenth.
3. **Write the test before believing the fix.** Assert the security **property**,
   never the observed response. This program found two pre-existing tests that
   were _defending_ vulnerabilities because they asserted observed behaviour —
   the hole had a passing test on top of it.
4. **Mutation-check the new test.** Introduce the vulnerability again, confirm the
   test goes red, revert. An assertion never observed to fail has not been tested.
5. **Sweep for siblings.** The same mistake is rarely in one place. Grep for the
   pattern; check the mobile client, which frequently reaches PostgREST directly
   and therefore bypasses service-layer guards — that is precisely why migration
   0323 exists.
6. **Check it against the recurring-pattern list** (INV-F1 to INV-F4).

---

## 5. Recover

1. **Confirm the fix in production**, not just in CI. Exercise the actual path.
2. **Verify the privileged half.** If credentials were rotated, run the canary
   from 3.2 — this is where the 2026-07-21 asymmetry bites.
3. **Restore data if it was damaged**:
   [`docs/runbooks/disaster-recovery.md`](../runbooks/disaster-recovery.md). Note
   what a Postgres backup does **not** cover: storage bucket objects, Vault
   secrets, and provider environment variables. Prefer restore-to-new-project when
   forensics may be needed.
4. **Re-enable anything disabled** — crons, modules, edge rules — and confirm each
   one ticks.
5. **Run the full gate**: `pnpm security:test`, then the suites, typecheck and
   lint.
6. **Watch the detection sources** through at least one full cycle of the hourly
   anomaly cron before standing down.
7. **Tell the affected tenants** if their data was reached. Scope from the audit
   trail, which is why section 3.1 comes first and why the ledger is never
   rewritten.

---

## 6. Review

Within a week, while the detail is still available.

Answer these, in writing:

1. **What was the root cause?** The mechanism, not the symptom.
2. **How was it found?** If a human found it before monitoring did, that is a
   detection gap and it is the highest-value finding in the review.
3. **How long was it exploitable?** Date it from the introducing commit, not from
   discovery.
4. **Why did the existing controls not catch it?** Was there a test that should
   have failed? Was there a test that _passed while the hole was open_ — the
   pattern this program found twice?
5. **What invariant is now asserted that was not before?** A review that adds no
   executable assertion has not changed the system's behaviour under the next
   similar mistake.
6. **Does it belong on the recurring-pattern list?** A pattern that has shipped
   twice belongs there, and the entry needs a detector or an honest note that no
   generic detector exists.

Then update, in the same change as the fix where possible:

- [`SECURITY-INVARIANTS.md`](SECURITY-INVARIANTS.md) — the new invariant, its
  enforcement and its test.
- `supabase/tests/security_invariants.test.sql` — the assertion, if the class is
  machine-checkable.
- `scripts/security-test.sh` — the manifest, if a new test file was added. It
  fails on a stale entry, so this is not optional.
- [`current-threat-intelligence.md`](current-threat-intelligence.md) — if the
  incident changes the threat picture.
- `SECURITY.md` — if the threat model or the hardening list changed.

### The standard to hold

An incident is closed when the **class** of mistake is covered by an executable
assertion that has been observed to fail — not when the symptom is gone. "Fixed"
before end-to-end verification is how the same bug ships twice.
