# Maintenance Resolved — engineering report

Program: resolved status, resolution notes, proof photos, and the resolution email.
Branch `feat/maintenance-resolved`, 18 commits, `0922d53a..a6d80250`.
Spec: `docs/superpowers/specs/2026-08-06-maintenance-resolved-design.md`.
Plan: `docs/superpowers/plans/2026-08-06-maintenance-resolved.md`.
Verification log: `docs/superpowers/reports/2026-08-06-maintenance-resolved-verification.md`.

**Status: READY TO SHIP**, with one pre-PR decision (co-author trailers on two commits) and one
outstanding test debt (mobile hand-test).

---

## What the owner gets

Before this program a maintenance request could only be saved, have its email draft opened,
archived, or cancelled. There was no way to record that the problem was actually *fixed*, and no
way to tell the person who reported it.

Now:

- A coordinator opens a request and clicks **Resolve**. They write a resolution note (required,
  up to 2000 characters, multi-line) and can attach up to 8 **proof photos**.
- The request flips to **Resolved**. The detail page grows a Resolution card: the note verbatim,
  who marked it resolved, and when.
- **The person who reported it is told**, on two channels: an in-app notification, and one email
  containing the note verbatim, the resolver's name, and up to 4 embedded proof photos.
- The public share link (`/m/<token>`) that already existed for photos now also shows the
  Resolution block and a labelled **Resolution proof** section — so a contractor or site contact
  with the link can see the close-out without a StockPilot account.
- All of it works on mobile too: resolved filter chip, resolved badge, resolution card, and a
  native resolve sheet with proof-photo upload.
- Resolved requests can still be **archived**, and archiving does not disturb the resolution record.

Everything above is a StockPilot-local record. The product says so, out loud, in the email and in
the resolve dialog: *"This resolution was recorded by your team in StockPilot. It does not close or
update the Zendesk ticket — replies and ticket status stay in the Outlook/Zendesk email
conversation."* StockPilot cannot see the ticket and never claims to.

---

## What shipped, by owner decision

| | Decision | Shipped as |
|---|---|---|
| **D1** | Resolved requests must still be archivable | Archive widened to accept `cancelled` and `resolved`. This **knowingly reverses** the M1 refusal shipped in the previous program — deliberate, owner-decided, with the pgTAP and service tests flipped to match rather than the history quietly contradicted. Walk-proven: archiving a resolved request leaves all five resolution columns byte-identical. |
| **D2** | Proof photos, reusing the existing photo pipeline | New `kind` column on `maintenance_request_attachments` (`requester` \| `resolution`), not a forked pipeline. Both the detail page and the share page render proof in its own labelled section, with combined photo indices preserved so `/m/<token>/photo/<n>` stays stable. |
| **D3** | Tell the requester | Two channels: an in-app notification (muteable per-user, per the 0265 posture) and one at-most-once email. |
| **D4** | Never claim anything about Zendesk | The honesty line, literal-pinned byte-for-byte (179 chars, U+2014), plus six **new** forbidden phrases added to the vocabulary sweeps at every rendering layer. |
| **D5** | Mobile parity | Pure-JS, OTA-safe: status filter, badge, resolution card, resolve sheet with proof upload, archive, assign owner, notes. Zero native dependencies added — the `apps/mobile/package.json` and `pnpm-lock.yaml` diffs against `main` are **empty**. |
| — | Reopen a resolved request | **Deferred to v2, by decision.** Not built. |

Migration **0317** carries it: the widened status CHECK (5 values), `resolved_at`, `resolved_by`,
`resolved_by_name_snapshot`, `resolution_note`, `resolution_email_sent_at`, the attachment `kind`
column, a notification-preference column, and the RLS changes.

---

## The 11-task review catch-list

Every task was implemented and then independently reviewed. Five reviews came back NEEDS FIXES.
The three catches worth the owner's attention:

### 1. The honesty bug, web (T7) — a false claim shown to the person who reported the issue

The "Resolution proof" card's caption **"Added by the team when this request was marked
resolved."** rendered **unconditionally**. But proof photos upload *before* the status flips. So a
coordinator who staged two photos and then hit **Cancel** left the requester looking at photos
labelled as evidence of a resolution — on a request that was **still open**.

This is precisely the class of dishonesty the whole program's vocabulary discipline exists to
prevent, and it had shipped through implementation with the tests green.

Fixed by making the caption state-conditional rather than by hiding the photos (hiding staged
photos is worse — they exist, the manage-holder can remove them, and silently concealing them is
its own lie):

- resolved → "Added by the team when this request was marked resolved."
- not resolved → "Staged by the team while preparing to mark this request resolved."

The same review found the dialog's `loadResolutionPhotos` GET was both wasteful and **100%
untested** (every test stubbed `fetch` as `{ok:false}`, so dropping the `kind` filter survived
mutation). Replaced with prop-threading.

**Now walk-proven in a real browser** — the first end-to-end proof, since all T7 coverage was
JSDOM. See verification steps 2 and 3: after staging two photos and cancelling, both the manager
and the plain requester see the *staged* caption, and the false one is absent.

### 2. The same honesty bug, other platform (T9)

Mobile mirrored web's `resolvedAt`-independent visibility gate but shipped **no caption at all**.
The implementer justified this as "the staged state needs T10" — the reviewer traced it and proved
that **false**: web's resolve dialog was already creating staged `kind='resolution'` rows *that
day*, so a mobile viewer would see unexplained proof photos on an unresolved request immediately.
Fixed with web's two strings verbatim, with the selection extracted to a pure helper
(`resolutionProofCaption()`) so it is behaviourally testable rather than a screen pin.

### 3. HTML injection in the resolution email (T5) — reviewer mutation R1 succeeded

`proofPhotos[].src` was interpolated **raw into an HTML attribute context**, while the `alt`
attribute two tokens away *was* escaped. A crafted photo URL could break out and land an `onerror`
handler in the email body. Proven live by the reviewer, with **zero existing coverage**.

Fixed: `escapeHtml` on `src` and on both `requestUrl` hrefs, with regression tests carrying the
literal exploit string, and a mutation confirming both tests fail if the escaping is removed.

### The rest

| Task | Verdict | Notable |
|---|---|---|
| T1 migration 0317 + pgTAP | APPROVED after fix wave | Reviewer mutation T1-M5 **survived**: the DELETE-freeze clause on the attachments policy had zero coverage across 1693 tests. Now covered (row-survives assertion, not `throws_ok` — RLS DELETE filters silently). |
| T2 status vocabulary + schema | APPROVED | Stringly-typed inventory fully classified; `STATUS_FILTERS`/`STATUS_VALUES` proven safe **by derivation**, not by tests — which is why T7 owed an independent five-label page pin. |
| T3 attachment kinds | APPROVED, 8 mutations zero survivors | `validateKind` at the identical point in **both** mint and finalize; the reviewer proved finalize's own call independently load-bearing. |
| T4 `resolve()` | NEEDS FIXES → fixed | **The gap:** both D1 archive-acceptance tests fixtured only `{archived_at: null}`, never a truthy `cancelled`/`resolved` — so a *complete* reversion of D1 passed 18/18. Reviewer proved it live. Fixed with truthy fixtures + a select-string pin. |
| T6 at-most-once sender | APPROVED after fix wave | **New operational fact:** Gmail/Outlook image proxies fetch embedded images at **delivery** time, not human-open — one email immediately burns up to 4 of the share link's 120/hr budget. Documented in code. |
| T8 API routes | APPROVED, 0/0 | Needed **no production change** to `[id]/route.ts` — the fields were already flowing from T3/T4. Honestly disclosed rather than papered over. |
| T10 mobile close-out | APPROVED, 0/0 | Mobile's `assignOwner` gate is *stricter* than the server's; adjudicated as a UX narrowing, not a security control. |

Recurring theme worth naming: **four separate times, a test suite was green while the thing it
claimed to protect was broken** (T1-M5, T4's D1 fixtures, T7's dialog fetch, T2's derivation).
Every one was caught by mutation testing, not by reading the tests. That is the practice that
carried this program.

---

## Verification summary

All gates green at `a6d80250`:

| Gate | Result |
|---|---|
| core test | 46 files / **885** passed |
| web test | 478 files / **5577** passed |
| mobile test | 55 files / **1175** passed |
| typecheck web + mobile + core | 0 errors |
| web lint | 0 errors, 34 pre-existing warnings |
| web build | exit 0, all 5 new API routes in the table |
| `supabase db reset && supabase test db` | **Files=115, Tests=1694, PASS** (0317 ok; 0207 still 119) |
| OTA purity (`apps/mobile/package.json`, `pnpm-lock.yaml` vs main) | **empty diff** |

Honesty sweeps: all 12 forbidden phrases appear **only** in sweep arrays and rule-documenting
comments; zero executable Zendesk surface in the new code (all 23 non-test hits are comments or
anti-claim disclosure copy); zero emoji in the diff; the honesty line byte-exact at 179 chars with
U+2014; and **zero log calls of any kind** in the new production source, so there is nothing to
leak a note, token, or signed URL.

Authed browser walk: **11 / 11 steps PASS, zero bugs found, zero source changes needed.** Plus
seven controller-added adversarial checks, all correct — including the **requester-planted-proof
attack proven closed live** (403 on `kind='resolution'`, 200 on `kind='requester'` from the same
account, so it is the kind gate biting and not a blanket refusal) and at-most-once holding against
a real second `resolve()` call (409, stamps unchanged).

`window.open` was patched shut before any document script in every context; **0 calls** across the
entire walk. No real email was sent, and no real address was ever a recipient.

---

## Limitations and owed items

1. **Mobile has never been hand-tested.** T9/T10 have 1175 green unit tests and clean reviews, but
   no screen has run on a device or simulator. The simulator was attempted once and failed in the
   Expo Go download step before any app code ran — the same pre-existing infra blocker as the prior
   program. Three ledgered minors (the `refreshKey` load-effect dep, `ensureMembersLoaded`, and the
   proof-photo cap arithmetic) are exactly the class of wiring bug only a hand-test catches.
   **This is the largest remaining gap.**
2. **Reopen is not built** — deferred by decision. Once resolved, the only forward move is archive.
3. **WEBP proof photos may not render in Outlook.** Mitigated by alt text and the CTA back into
   StockPilot; not solved. Proof rides the share proxy's **masters**, never WEBP thumbs, precisely
   because of this.
4. **Share-link rate budget.** Per-kind caps put the worst case at 17 requests per full share-page
   view against the unchanged 120/hr bucket — roughly 7 full views per hour per link. Compounded by
   the delivery-time image-proxy fetch above. Fine for DC4 + Andrew today; **any future batch-resend
   must re-check this first.**
5. **`cancel()` TOCTOU** (pre-existing, unchanged): `cancel()` does a fresh pre-read but has no
   write-time guard, so `resolve()` racing it could leave a row cancelled with resolution stamps
   populated. Not reachable in normal single-operator use. Recommended for the fast-follow PR —
   give `cancel()` the same guarded `.is()` write that `resolve()` uses.
6. **Two test-pin gaps**, both one assertion each, owed post-merge: the sender-level
   `PROOF_PHOTO_EMBED_MAX = 4` has no pin (the template's equal cap of 4 *is* pinned, so behaviour
   is covered), and `resolveMaintenanceShareToken`'s select-column string has no pin.
7. **Two owner housekeeping items on the local dev environment**, both discovered during the walk
   and neither a code defect: the local `.env.local` holds a **populated `RESEND_API_KEY`** (a live
   send key one `pnpm dev` away from any local resolve — recommend blanking it), and the local
   `SUPABASE_SERVICE_ROLE_KEY` is still stale against the running stack.
8. **0317's status CHECK widen** is a drop+add without `NOT VALID`, so it takes ACCESS EXCLUSIVE and
   validates the whole table. Negligible today (days-old table, one org). Revisit before any future
   widen at scale.

---

## Ship checklist (controller executes — order binding)

```text
0. PRE-PR DECISION — co-author trailers.
   Two commits carry `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`:
     eee31022  test(maintenance): cover the resolved-parent delete freeze …
     d13b47b2  test(maintenance): pin no-stamp guards and count filters …
   The other 16 branch commits are clean and main's last 50 carry zero.
   House convention is no trailer. Stripping them rewrites those two SHAs and
   every descendant including a6d80250, and invalidates the SHA ranges recorded
   in progress.md — so it was NOT done during verification. Decide: strip
   (e.g. `git filter-branch --msg-filter` over main..HEAD, then re-run gates and
   re-point the ledger) or accept and merge as-is.

1. supabase db push --linked          # 0317 FIRST (project xizpqmhhslgzbuqtjubv).
                                      # resolve() writes a status the old CHECK
                                      # rejects — code-before-migration is an outage.

2. Open PR feat/maintenance-resolved -> main; merge after review.
   Vercel deploys on push — do NOT also POST /v13/deployments.

3. Prod verify (Demo Co, module temporarily enabled exactly as the 0314 ship
   log did — record enable/disable SQL + timestamps): resolve a request whose
   requester IS the demo account; verify pill/detail/share page; verify
   resolution_email_sent_at stamped; the REAL email to demo@stockpilotusa.com
   is the ONE sanctioned live-send verification — inspect it for the honesty
   line, the verbatim note, the resolver name, and working proof-photo images.
   NEVER resolve a request belonging to a real L4L requester during verification.

   TRAP (carried from the 0314 ship log): the draft-reminder cron is the one
   emit point with no module-enabled gate. CANCEL the Demo test request BEFORE
   disabling the module — cancel() is itself module-gated, so cleanup after the
   disable would require re-enabling. (The fast-follow adds the cron's module
   filter; until it lands, this trap is live.)

   L4L NEEDS NO ENABLE SQL THIS TIME: org 63c13e64-92a6-4ea4-9936-6a2c26a85b4a
   ("L4L North Region") was already enabled during the 0314 ship and stays on.
   Andrew needs no new grants — admin defaults already cover read_all/manage,
   which is every new surface.

4. Mobile OTA: cd apps/mobile && pnpm release:ota   (never raw `eas update`;
   pure-JS verified by the empty package.json/lockfile diff).

5. Prod smoke: on a device that took the OTA, open a resolved request —
   resolved chip, badge, resolution card, proof section — and confirm the
   notification tap-through lands on /dashboard/maintenance/<id>.
   THIS IS ALSO THE OWED MOBILE HAND-TEST (see Limitations #1): T9/T10 have
   never run on a real device. Walk the resolve sheet, a proof upload, archive,
   assign owner, and notes while you are there.

6. Owner hand-test on L4L when ready.
```

Recommended immediately post-merge fast-follow (all small, none blocking):
`cancel()` write-time guard alignment; the two missing literal pins; and blanking the local
`RESEND_API_KEY` / refreshing the local `SUPABASE_SERVICE_ROLE_KEY` in `stockpilot-env`.
