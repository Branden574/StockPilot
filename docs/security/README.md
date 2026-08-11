<!-- Provenance: compiled 2026-08-10 at the close of the security program's waves
     A-E. Migration and commit references are verifiable with `git log` and by
     opening the cited files. Catalog figures are reproducible with the queries in
     SECURITY-INVARIANTS.md. Confidence statements in section 5 are written to be
     checkable; if one cannot be checked, that is a defect in this document. -->

# Security documentation

The security documentation set for StockPilot: three documents written during the
program's assessment phase, seven written to govern what happens after it, and this
index.

`SECURITY.md` at the repository root remains the outward-facing statement — threat
model, vulnerability reporting, vendor data flow, recommended provider settings.
This directory is the operator-facing detail behind it.

## 1. Start here

| If you are…                                                            | Read                                                                                                                                   |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| About to write a migration, a policy, or a `SECURITY DEFINER` function | [SECURITY-INVARIANTS.md](SECURITY-INVARIANTS.md) — sections 1-3                                                                        |
| About to run something irreversible                                    | [destructive-actions.md](destructive-actions.md)                                                                                       |
| Handling a suspected incident                                          | [incident-response.md](incident-response.md) — section 0 first                                                                         |
| Rotating a credential                                                  | [secrets-policy.md](secrets-policy.md) — section 5                                                                                     |
| Answering "what data do you hold and where does it go?"                | [data-classification.md](data-classification.md)                                                                                       |
| Answering a security questionnaire                                     | [asvs-mapping.md](asvs-mapping.md)                                                                                                     |
| Optimizing a hot path that has a check on it                           | [perf-baseline.md](perf-baseline.md) — section 4                                                                                       |
| Deciding whether to take a dependency upgrade                          | [dependency-hardening-2026-08.md](dependency-hardening-2026-08.md), [framework-patch-verification.md](framework-patch-verification.md) |

## 2. The documents

### Governance and invariants

**[SECURITY-INVARIANTS.md](SECURITY-INVARIANTS.md)** — the properties that must
always hold, each stated so a counterexample would break it, each naming its
enforcement mechanism and its test. Covers tenant isolation, the anon/PUBLIC
execute posture, the RLS-versus-privilege interaction, storage path shapes and
bucket exposure, the service-role boundary, the four recurring bug patterns, and
the two accepted risks. Section 8 lists what is deliberately **not** covered by an
executable test and why — read that section before assuming coverage.

The machine-checkable subset is
[`supabase/tests/security_invariants.test.sql`](../../supabase/tests/security_invariants.test.sql):
23 allowlist-based assertions over whole classes of database object, so a **new**
violation fails rather than passing silently.

**[secrets-policy.md](secrets-policy.md)** — where secrets live (outside the
repository, symlinked in), the rule against ever expanding one in a shell, the
never-commit guards, reporting by `FILE:LINE` only, and the rotation runbook whose
third step — redeploy — is the one a real outage was caused by skipping.

**[destructive-actions.md](destructive-actions.md)** — which actions need explicit
owner authorization and the pre-flight each one needs, with a worked example
showing that `delete from inventory_items` either fails loudly or silently destroys
the item's entire movement ledger depending on data you have not looked at.

**[data-classification.md](data-classification.md)** — the data classes this
system holds, the isolation mechanism for each (they differ), the handling rules,
and the table of what leaves the system and to whom.

**[incident-response.md](incident-response.md)** — detect, triage, contain,
eradicate, recover, review, specific to this stack. Section 0 carries the three
facts most likely to prolong an incident: a password change does not end a session,
a native mobile fix is not deliverable over the air, and the forensic window is
about seven days.

**[asvs-mapping.md](asvs-mapping.md)** — OWASP ASVS chapters mapped to implemented
controls at category granularity, marked Met / Partial with a one-line
justification and a named gap for every Partial. No ASVS level is claimed.

**[perf-baseline.md](perf-baseline.md)** — how performance is measured, which
recorded figures act as regression tripwires, and section 4 on where security
controls sit on hot paths. Section 0 states plainly which measurements do not
exist.

### Assessment phase (pre-existing)

**[current-threat-intelligence.md](current-threat-intelligence.md)** — the threat
picture the program was scoped against.

**[framework-patch-verification.md](framework-patch-verification.md)** — exact
installed versions against latest, with a verdict per component. The structural
finding stands: mobile is on Expo SDK 53, past Expo's support window, and a
framework-level native fix there would need an SDK migration, an EAS build and a
store review.

**[dependency-hardening-2026-08.md](dependency-hardening-2026-08.md)** — the
remediation record for the 18 open Dependabot alerts: 16 closed, 2 left open
deliberately because no patched release exists upstream.

## 3. The executable gate

```bash
pnpm security:test
```

Runs [`scripts/security-test.sh`](../../scripts/security-test.sh): a manifest of 94
security-relevant test files across four sections.

| Section                   | Files | Assertions |
| ------------------------- | ----- | ---------- |
| pgTAP database invariants | 38    | 667        |
| Web application (vitest)  | 45    | 655        |
| Mobile client (vitest)    | 7     | 175        |
| Shared core (vitest)      | 4     | 73         |

Three properties of the script are deliberate and should not be removed.

1. **It overlaps `pnpm test`.** The value is the label: a red "Security
   invariants" step means a security property broke, which is a different merge
   decision from a red test suite.
2. **The manifest is explicit paths, not a glob.** This repo has at least six
   partial conventions for marking a security test, so any glob either misses
   coverage or drags in unrelated files.
3. **The manifest polices itself.** Every entry is checked to exist before
   anything runs, and a missing entry is a hard failure — because a vitest path
   filter that matches nothing is _not_ an error, so a renamed file would
   otherwise shrink the gate while it kept reporting success.

The pgTAP section needs the local Supabase stack running. `SECURITY_TEST_SKIP_DB=1`
skips it with a loud warning; CI never sets it.

In CI it runs as the **Security invariants** step of the `DB pgTAP tests` job in
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), where the stack the
database half needs is already up. The separate
[`security-scan.yml`](../../.github/workflows/security-scan.yml) workflow runs
Semgrep and TruffleHog.

## 4. What the program shipped

Waves A-E, 2026-08. Migrations **0318-0323**; pull requests **#76, #78-#88**.

| Wave    | Subject                                                                              | Migration | Commit                       |
| ------- | ------------------------------------------------------------------------------------ | --------- | ---------------------------- |
| Phase 0 | Dependency hardening and the three assessment documents                              | —         | `da9a873f`, `2ed4fa68` (#76) |
| A       | The P0 — anon EXECUTE on ungated `SECURITY DEFINER` functions                        | 0318      | `45cf6a99` (#78)             |
| A       | Authorization gates on order-signature read and PO spend-control paths               | —         | `e677c8d1` (#79)             |
| B       | AI boundaries — org-scoped tool reads, prompt-injection containment                  | 0320      | `6c3ee68e` (#81)             |
| C       | Multi-tenant RLS — warehouse-scoped movement reads, pinned attribution               | 0321      | `9be0558d` (#83)             |
| C2      | Quantity constraints, avatar read scoping, override-clear gating                     | 0322      | `efa88926` (#84)             |
| D       | Strict storage-path shapes, PO-import MIME allowlist, magic-byte upload verification | 0323      | `0743f3fe` (#85)             |
| E       | This documentation set, the invariant tests, and `pnpm security:test`                | —         | this change                  |

### The finding worth carrying forward

The P0 was not a bug in this codebase's logic. It was a **wrong belief about a
Postgres default**: `EXECUTE TO PUBLIC` is granted on every new function, and
`anon` inherits `PUBLIC`, so **omitting a `GRANT` does not close a function — it
opens it.** Migration 0093 documented a function as closed while it was
`PUBLIC`-executable for its entire life. 95 `SECURITY DEFINER` functions, 58
anon-executable, 15 genuinely exploitable, fixed with grants only.

The generalizable lesson is about the shape of the mistake, not the mechanism: a
security control that depends on a **default** being safe is not a control. That
same shape appears twice more in this system — a view without
`security_invoker = true` reads through RLS as its owner, and a materialized view
cannot have RLS at all. Both are now asserted (INV-8, INV-9).

## 5. Confidence posture

Written so each line can be checked.

**What is established**

- **No known critical or high-severity vulnerability remains open** from waves
  A-E. The P0 is closed for all 15 exploitable functions, and the class — not just
  those 15 — is covered by an allowlist-based sweep that fails on the sixteenth.
- **A high-assurance baseline is implemented and covered by executable
  invariants**: 23 class-wide database assertions plus 94 security-relevant test
  files, 1,570 assertions total, gated as `pnpm security:test` and wired into CI.
- **Access control, business logic and communication are the strongest
  categories** — see [asvs-mapping.md](asvs-mapping.md), where they are the three
  marked Met.
- **The invariant tests have been mutation-checked.** A deliberate violation of six
  distinct invariants turned 10 of the 23 assertions red; the database was restored
  afterwards and the suite returned to 23/23. The recipes for repeating it are in
  the test's header. This matters because the program found **two pre-existing tests
  that were defending vulnerabilities** — each asserted the observed vulnerable
  behaviour instead of the required property, so a real hole had a passing test on
  top of it.
- **Tenant isolation is asserted class-wide, not sampled**: 89 of 89 org-scoped
  tables have RLS with no allowlist permitted; 6 of 6 views are `security_invoker`;
  zero materialized views; zero literal-true predicates on org-scoped tables; zero
  self-comparison tautologies.

**What is accepted and tracked, not closed**

- **Two refused fixes**, each with evidence and a pgTAP pin
  ([SECURITY-INVARIANTS.md](SECURITY-INVARIANTS.md) section 7): constraining
  `item_stock_levels.quantity` would convert an existing bug into a mid-transaction
  failure; warehouse-scoping `item_stock_levels` would make `post_cycle_count` sum
  short under the caller's RLS and write a **wrong number with no error**.
- **One recorded gap**: five storage-path columns lack the database traversal floor.
  They are in the invariant test's known-gap allowlist, so they appear in every CI
  run rather than being forgotten.
- **The session-eviction window**: JWT TTL is the Supabase default of 3600s, so a
  global sign-out leaves an already-issued access token valid for up to an hour.
  `SECURITY.md` recommends 600s; the change is owner-blocked.
- **pnpm 9.12.3 executes lifecycle scripts by default** — the top open
  supply-chain item. CI is covered by `--frozen-lockfile`; the developer workstation
  is not.
- **Expo SDK 53 is past its support window**, so a framework-level native security
  fix has a multi-week delivery path through a store review.
- **Log retention is 7 days**, which bounds incident reconstruction. Log drains are
  deferred on cost.

**What is not established**

- **No independent verification.** No third-party penetration test, no SOC 2 or
  ISO 27001 process, no bug bounty (`SECURITY.md`, "Things we haven't done").
- **No ASVS level is claimed**, and the mapping is category-granular
  self-assessment.
- **Several security-relevant settings live in provider dashboards** and cannot be
  verified from this repository: JWT expiry, email confirmation, the Vercel Node.js
  major version, the Supabase backup tier.
- **No performance baseline in the measured sense** — see
  [perf-baseline.md](perf-baseline.md) section 0. The recorded figures are dated
  point-in-time measurements serving as regression tripwires.
- **Four invariants have no generic executable assertion** and are covered by
  targeted tests plus review: per-call-site path validation, admin-client
  justification, and recurring patterns #23 and #2 (both TypeScript client-library
  behaviours invisible to the database catalog).

**The one-sentence version**: no known critical vulnerabilities remain, a
high-assurance baseline is implemented and covered by executable invariants that
have been shown capable of failing, and the residual risk is enumerated above
rather than absent.

## 6. Keeping this set honest

- A new security fix updates [SECURITY-INVARIANTS.md](SECURITY-INVARIANTS.md) **in
  the same change**, with its invariant, enforcement and test.
- A new test file goes in [`scripts/security-test.sh`](../../scripts/security-test.sh)'s
  manifest. The script fails on a stale entry, so this is enforced rather than
  requested.
- A new allowlist entry carries its reason in the `why` column and should expect to
  be challenged in review. An entry with no reason is a finding.
- After changing any assertion, **run the mutation check** before believing it.
- A closed gap means deleting its row from the relevant allowlist in the same change
  as the fix. `INV-3` and `INV-16` fail if that is forgotten.

### Known follow-ups

Recorded here so they are tracked rather than remembered.

1. Promote the nine `NOT VALID` storage-path constraints with `validate constraint`
   after re-running 0323's row-count check. Safe (`SHARE UPDATE EXCLUSIVE`), and a
   separate deliberate step.
2. Close the five storage-path column gaps (INV-D2), removing each allowlist row in
   the same change.
3. Add a sweep asserting every cron route validates its shared secret — feasible,
   and currently covered only per-route.
4. Owner-verify the provider settings listed under "not established".
5. Migrate to pnpm 10.x with an `onlyBuiltDependencies` allowlist and
   `minimumReleaseAge`.
6. Fill in `load-tests/README.md`'s capacity table from one real run
   ([perf-baseline.md](perf-baseline.md) section 5).
