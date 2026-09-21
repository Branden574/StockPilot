# Perf Lab dataset

Tooling that builds, checks and removes ONE benchmark organization, slug
`stockpilot-perf-lab`, for the performance program.

## What it is for

The performance harness (`apps/web/tests/perf`) measures navigation and photo
loading from outside the app. It needs a dataset that is realistic, frozen, and
not a customer's. Demo Co has 33 small photos; the customer whose experience is
being reproduced has 443, heavier and messier. Measuring inside a customer
organization is not acceptable, so the owner approved a separate organization
holding SYNTHETIC data shaped like that customer's measured distribution
(two read-only censuses, 2026-09-18 and 2026-09-20), plus one account per role
for the role matrix.

- Same seed, same dataset: the plan (which item gets which format, size, cache
  group, thumbnail, LQIP) is identical everywhere and always. The BYTES are
  identical on the same `sharp` build with the same installed fonts, which is a
  condition and not a guarantee; `--fingerprint` is how it is checked. See "Same
  dataset, same bytes" below.
- Teardown is "delete that one organization and everything under it".

| File           | Purpose                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `lib.mjs`      | Safety rails, argument parsing, org-scoped database access, bounded concurrency, seeded PRNG, image-header parsing.          |
| `dataset.mjs`  | The plan: targets, tolerances, exact quotas, modules on/off, catalog, orders, accounts. Pure and deterministic.              |
| `images.mjs`   | Draws each product photo with `sharp` (SVG + seeded grain) and derives the thumbnail and LQIP the way that row's writer did. |
| `seed.mjs`     | Idempotent, resumable seed.                                                                                                  |
| `verify.mjs`   | Read-only census of what is actually stored, against the targets. Exits non-zero on a miss.                                  |
| `teardown.mjs` | Removes the organization, its objects and its accounts.                                                                      |

## What gets created

| Thing                  | Count | Notes                                                                                                       |
| ---------------------- | ----- | ----------------------------------------------------------------------------------------------------------- |
| Organization           | 1     | plan `free`, `all_modules_comp = false`, `mfa_policy = optional`                                            |
| Accounts               | 6     | `perf-lab+owner`, `+admin`, `+manager`, `+staff`, `+viewer`, `+staff-restricted` `@stockpilotusa.com`       |
| Warehouses             | 2     | `PLN` Perf Lab North DC (356 items), `PLS` Perf Lab South DC (87 items)                                     |
| Locations              | 11    | 1 site + racks per warehouse; a trigger adds Staging + Unplaced per warehouse (4 more)                      |
| Categories / suppliers | 9 / 5 | 8 product categories + Books                                                                                |
| Items                  | 443   | SKU `PERF-0001` to `PERF-0443`; 40 are `item_type = 'book'`; 8% out of stock, 17% at or below reorder point |
| Photos                 | 443   | one per item, written as three writers did                                                                  |
| Order requests         | 60    | 211 lines, 11 statuses, all `pickup`                                                                        |

`staff-restricted` holds exactly one warehouse assignment (`PLN`) and
`all_warehouses = false`. `staff` and `viewer` are warehouse-scoped roles too and
are assigned both warehouses; manager and above see every warehouse by role.

### The photo distribution being reproduced

Two production censuses, read-only and counts only. v1 (2026-09-18) measured
sizes and served headers. v2 (2026-09-20) read each file's MAGIC BYTES, and
explained what v1 could not: a thumbnail tail (p95 75 KB) that no 200 px WebP can
reach.

**The cause.** WebKit (Safari) cannot encode WebP. Asked for `image/webp` by
`canvas.toBlob` or `OffscreenCanvas.convertToBlob`, it returns `image/png`, on
both of the uploader's code paths. The uploader stores what it got under the name
and type it asked for. So a Safari upload leaves a PNG thumbnail named
`-thumb.webp` and served as `image/webp`, a `data:image/png` placeholder, and,
because that PNG "master" is never smaller than a JPEG source, the ORIGINAL file
as the master, uncapped. Every production thumbnail of 30 KB or more is one of
those. Dataset v1 reproduced that tail by bytes without knowing why; v2 builds
each row the way its writer did.

| Writer         | Rows | Thumbnail                                | Placeholder       | Master                                                              |
| -------------- | ---- | ---------------------------------------- | ----------------- | ------------------------------------------------------------------- |
| `backfill`     | 301  | WebP, 200x200 cover crop, `max-age=3600` | none              | uploaded without a thumbnail; `backfill-item-thumbs.mjs` added one  |
| `webp-browser` | 69   | WebP, long side 200, `no-cache`          | `data:image/webp` | 65 WebP / 4 JPEG; p50 39 KB, p95 691 KB, max 967 KB                 |
| `webkit`       | 67   | **PNG**, long side 200, `no-cache`       | `data:image/png`  | the original: 64 JPEG / 3 PNG; p50 276 KB, p95 4981 KB, max 5797 KB |
| `no-thumb`     | 6    | none (`thumb_path` null)                 | none              | JPEG                                                                |

|                            | Census                                                           | Built and verified                               |
| -------------------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| Masters, by served type    | 358 jpeg / 83 webp / 1 png / 1 unreadable                        | 358 / 84 / 1                                     |
| Masters, by magic bytes    | webkit class alone holds 3 PNG                                   | 358 JPEG / 82 WebP / 3 PNG                       |
| Master bytes               | p50 310 KB, p95 612 KB, max 5797 KB                              | 312 / 609 / 5670 KB                              |
| Masters over 2048 px       | 7, of which 4 in the webkit class                                | 7, of which 4                                    |
| Thumbnails                 | 437, all <= 200 px, every one named `-thumb.webp`                | 437                                              |
| Thumbnails, by magic bytes | 370 WebP (p50 8, max 17 KB) / 67 PNG (p50 71, p95 84, max 99 KB) | 370 (p50 8 KB) / 67 (p50 73, p95 80, max 101 KB) |
| Thumbnail bytes, all       | p50 8 KB, p95 75 KB                                              | 8 / 76 KB                                        |
| Placeholders               | 69 `image/webp` + 67 `image/png`; 307 rows have none             | 69 + 67                                          |
| Master Cache-Control       | 286 `max-age=3600` / 103 `no-cache` / 53 `max-age=604800`        | 287 / 103 / 53                                   |
| Thumbnail Cache-Control    | 301 `max-age=3600` / 136 `no-cache`                              | 301 / 136                                        |

**Where the two censuses, or the brief, cannot all hold, v2 wins, and it is said
here rather than hidden:**

- "1 PNG master" (v1, by Content-Type) and "3 PNG masters in the webkit class"
  (v2, by magic bytes) are both true only if two PNG files are served under another
  type. The uploader produces exactly that: a PNG SOURCE whose WebKit re-encode
  comes out smaller is stored as PNG bytes in a `.webp` file typed `image/webp`. So
  the dataset holds exactly 2 masters whose type disagrees with their bytes. That
  reading is INFERRED from two counts that must both hold; no census observed those
  two files.
- "2-3 multi-MB outliers" (the brief) becomes 4: the webkit class p95 is 4981 KB of
  67, so its top four masters are each about 5 MB.
- "Every master between 1200 and 2048 px" (the brief) cannot hold for the
  `webp-browser` class: a 39 KB median WebP is a small IMAGE, not a well-compressed
  large one (v1 found 117 masters of 800 px or less). That class takes the long
  side its bytes imply (400 to 1600 px); the others keep the brief's rule, except
  the one 401-800 px master v2 counted in the webkit class. 61 masters are under
  1200 px, none of them in the backfill or no-thumb class, and `verify.mjs` checks
  both numbers.
- NOT in either census, so assigned and labelled as such: how master Cache-Control
  splits across writers. Only a browser PUT stores `no-cache`, so all 103 sit in
  the two browser classes (51 + 52, in proportion).

The backfill and no-thumb classes have no census of their own. Their size
distribution is the one free choice, fixed by a grid search so that the UNION of
all classes lands on the overall p50 310 KB / p95 612 KB. `buildPlan()` checks the
plan against every census number before anything is generated and throws if an
edit breaks one.

Each master is a studio-backdrop product shot: a large shaded shape, a floor
shadow, a printed label with the item name and SKU in small type, three lines
of ~11 px small print, a barcode of 1-4 px vertical bars, and 1 px hairlines.
Text, bars and hairlines are what show blur at DPR 2-3.

There are two size knobs, both documented where they live in `images.mjs`:

- **Grain sets the master's bytes.** Photographic grain is added per pixel from a
  seeded noise pool. Each file has a byte target, and the generator bisects the
  grain amplitude until the encoded file is within 2.5% of it, leaving the encoder
  settings at what a real upload would use (JPEG quality 80-92, 4:2:0; WebP
  quality 0.85). To make the dataset heavier or lighter, change the targets in
  `dataset.mjs` and bump `DATASET_VERSION`.
- **Surface texture sets the WebP thumbnail's bytes.** Grain averages away at
  200 px, and the drawing itself is worth only about 0.6 KB there, against a census
  p50 of 8 KB. One octave of seeded value noise stands in for the detail a real
  photo keeps at thumbnail scale. Its two numbers were measured, not chosen by eye:
  cell size dominates (12 px cells cost twice the bytes of 31 px cells, and mixing
  octaves dilutes), so the cell is fixed at about 1.5 thumbnail pixels, as a
  fraction of the image; amplitude 28 then puts the WebP thumbnail at 7-8 KB.

Full-strength texture costs about 1 bit per pixel by itself, so where a master's
byte budget is smaller than that (the small web images, the smoothest photos) the
TEXTURE amplitude is bisected down instead, with grain held at a small minimum.
The lossless PNG masters are exempt from the minimum grain (one level of noise
costs a PNG about 500 KB).

**PNG thumbnails.** The same texture is nearly incompressible to PNG, and that
turned out to be the census shape without help: measured with no extra grain, a
200 px PNG of one of these masters weighs 54-73 KB at 4:3 (median 68), about 60 KB
at 3:2 and 82-94 KB when square, against a production p50 of 71. So each PNG
thumbnail is a real PNG, sized the way the uploader sizes it; grain is added at
thumbnail scale only ABOVE its natural weight, to follow the census curve (rank to
KB, in `dataset.mjs`), and the class holds exactly three square thumbnails so the
three heaviest targets (89, 94, 99 KB) fall on files that can weigh that.
(Measured in WebKit itself on these masters the PNG thumbnail is about 52 KB:
WebKit's canvas downsamples more softly than libvips. The dataset follows the
production bytes, because transfer and decode cost are what the benchmark times.)
A 16 px PNG placeholder is 800 to 1100 characters as a data URL, well inside the
2000-character cap, which is how production can hold 67 of them.

The variant settings come from the app: `src/lib/image-variants.config.ts`,
`IMAGE_VARIANTS` (master 2048 px / 0.85, thumb 200 px / 0.8, lqip 16 px / 0.5 /
2000 chars). That 200 px thumbnail, upscaled into a retina cell, is the condition
being reproduced.

**`no-cache` objects** are uploaded the way the web uploader uploads: a signed
upload URL and a raw `PUT` with a content-type and no cache-control header. The
storage API records and serves the literal `no-cache` header for those (confirmed
on the local stack; both production censuses found the same literal header).

## Commands

Run from the repository root. All three scripts take the same rails.

**Every command block below can be pasted into interactive zsh on macOS as it
stands.** No block carries a `#` comment: zsh without `INTERACTIVE_COMMENTS` runs
`#` as a command, and on a line that also holds an assignment the assignment is
lost. No command contains a `<placeholder>`: to a shell, `<` and `>` are
redirections. Values you supply go into shell variables first. And each step is its
own block, so a step whose result must be read before the next is a real stop.

### Local

A local stack must be running (`supabase start`). Put the LOCAL service key in the
environment without printing it:

```bash
eval "$(supabase status -o env 2>/dev/null | sed -n 's/^SERVICE_ROLE_KEY=/export SUPABASE_SERVICE_ROLE_KEY=/p')"
```

Then:

```bash
node apps/web/scripts/perf-lab/seed.mjs --target=local --dry-run
node apps/web/scripts/perf-lab/seed.mjs --target=local
node apps/web/scripts/perf-lab/verify.mjs --target=local
node apps/web/scripts/perf-lab/teardown.mjs --target=local --dry-run
node apps/web/scripts/perf-lab/teardown.mjs --target=local
```

Last step, every time, local key included:

```bash
unset SUPABASE_SERVICE_ROLE_KEY
```

`--target=local` talks to `http://127.0.0.1:54321` unless `SUPABASE_URL` names
another loopback URL. Anything that is not 127.0.0.1 or localhost is refused.

### Same dataset, same bytes

The PLAN is identical everywhere and always. The generated BYTES are identical on
the same `sharp`/libvips build with the same installed fonts (librsvg draws the
label text with system fonts). A `sharp` bump in the lockfile or an OS update that
touches Helvetica, Menlo or Georgia changes the label's pixels, and with them
every hash, while every size target is still met and `verify.mjs` still passes.
So compare, do not assume. This needs no key and no database and takes about 50 s:

```bash
PERF_LAB_FINGERPRINT=5859d31c247b448da820a7f567b2e1144e9538d5bec7dffd1846a261fd50e5a0
node apps/web/scripts/perf-lab/seed.mjs --target=local --fingerprint --expect-fingerprint="$PERF_LAB_FINGERPRINT"
```

It prints the encoder versions and one hash for all 443 masters, thumbnails and
placeholders, and exits 1 on a mismatch. The value above is dataset
`perf-lab-dataset-v2` on the machine these scripts were proven on (sharp 0.35.4,
libvips 8.18.6, macOS); two runs printed it. If your machine prints another value,
that is not an error in itself: record YOURS next to `PERF_DATASET`, and use it
from then on. A "before" and an "after" benchmark are like for like only if they
loaded the same stored objects (true for as long as the organization is not
re-seeded) or if the re-seed printed the same fingerprint. This is deliberately a
comparison and not a gate inside the seed: a pinned hash would be tied to one
machine and would block a legitimate seed after an ordinary OS update. The seed
does warn when any master lands more than 2.5% from its byte target, which is
what a drifted renderer looks like from the inside.

### Production operating procedure

Only the owner runs this, from a quiet machine. There are two sittings, days or
weeks apart. EACH ONE starts by entering the key and ends by unsetting it, so the
production service key is never left exported in a terminal between them.

**Sitting 1: seed and verify**

Step 1. BEFORE the key is anywhere near this shell: what does this machine
generate? It must end with "matches the expected fingerprint". If it does not,
stop and read "Same dataset, same bytes".

```bash
PERF_LAB_FINGERPRINT=5859d31c247b448da820a7f567b2e1144e9538d5bec7dffd1846a261fd50e5a0
node apps/web/scripts/perf-lab/seed.mjs --target=local --fingerprint --expect-fingerprint="$PERF_LAB_FINGERPRINT"
```

Step 2. The key goes into the environment of THIS shell only. `read -s` does not
echo and nothing is typed on a command line, so nothing lands in shell history:
paste the key, press Enter. Production is pinned inside the scripts, so
`SUPABASE_URL` must be unset; `NODE_OPTIONS` could preload code into the process
that is about to hold the key, so it must be unset too (the scripts refuse
otherwise).

```bash
unset SUPABASE_URL
unset NODE_OPTIONS
read -rs SUPABASE_SERVICE_ROLE_KEY
export SUPABASE_SERVICE_ROLE_KEY
export PERF_LAB_CONFIRM=stockpilot-perf-lab
```

Step 3. Dry run. Reads only. It must say the organization "does not exist yet".
If it says anything else, stop: see "If an organization already exists".

```bash
node apps/web/scripts/perf-lab/seed.mjs --target=production --i-am-authorized-by-the-owner --dry-run
```

Step 4. Seed. Prints what it will do, waits 10 seconds (Ctrl-C aborts), re-checks
ownership, then writes.

```bash
node apps/web/scripts/perf-lab/seed.mjs --target=production --i-am-authorized-by-the-owner
```

Step 5. The organization id is printed the moment the organization is created,
and again at the end. Every later production run must carry it. Type the
assignment with the id after the `=` sign:

```bash
PERF_LAB_ORG_ID=
```

Step 6. Verify. Reads only. Must end with "All 115 checks passed." (The seed's
closing `next:` line prints this same command with the id filled in.)

```bash
node apps/web/scripts/perf-lab/verify.mjs --target=production --i-am-authorized-by-the-owner --org-id="$PERF_LAB_ORG_ID"
```

Step 7. Last step of this sitting, always, even if a step above failed:

```bash
unset SUPABASE_SERVICE_ROLE_KEY PERF_LAB_CONFIRM
```

**Sitting 2: teardown, when the program is over**

Step 1. Exactly as step 2 of sitting 1, then the id recorded in sitting 1:

```bash
unset SUPABASE_URL
unset NODE_OPTIONS
read -rs SUPABASE_SERVICE_ROLE_KEY
export SUPABASE_SERVICE_ROLE_KEY
export PERF_LAB_CONFIRM=stockpilot-perf-lab
```

```bash
PERF_LAB_ORG_ID=
```

Step 2. Dry run. Read what it says it would delete.

```bash
node apps/web/scripts/perf-lab/teardown.mjs --target=production --i-am-authorized-by-the-owner --org-id="$PERF_LAB_ORG_ID" --dry-run
```

Step 3. The real thing. If it is interrupted at ANY point, run the identical
command again. That includes after "organization: deleted": it then checks that no
organization row holds that id, removes the leftover accounts, and looks under
that id in the buckets. Always keep `--org-id`: once the organization row is gone,
that id is the only handle left on stored objects.

```bash
node apps/web/scripts/perf-lab/teardown.mjs --target=production --i-am-authorized-by-the-owner --org-id="$PERF_LAB_ORG_ID"
```

Step 4. Last step of this sitting, always:

```bash
unset SUPABASE_SERVICE_ROLE_KEY PERF_LAB_CONFIRM PERF_LAB_ORG_ID
```

An empty `--org-id=""` is refused, and so is anything that is not a uuid, so a
forgotten step 5 cannot turn into an unpinned run.

**If an organization already exists.** On production, a run that finds the Perf
Lab organization already there refuses unless it is pinned with `--org-id`. That
is the normal state for every run after the first, and the refusal prints the id,
its creation time and its member count so a first run that crashed after creating
the organization can be resumed. If you did NOT expect one to exist, do not pin
it: find out where it came from first. The scripts only get this far for a row
that carries the exact name and the provenance marker and whose members are all
Perf Lab accounts; anything else is refused outright, pinned or not (rails 7-9).

Pointing the harness at it (no password exists; sign-in is an admin-minted magic
link, see `tests/perf/auth.setup.ts`, on `main` since #209). `PERF_DATASET` should
name the dataset version and the first 12 characters of the fingerprint, for
example `Perf Lab perf-lab-dataset-v2, 443 items, 443 photos, fingerprint 5859d31c247b`,
with `PERF_USER_EMAIL=perf-lab+owner@stockpilotusa.com` and `PERF_ROLE=owner`.

If the seed stops part-way (network drop, Ctrl-C, a refused upload), run the same
command again (on production: with `--org-id`). It finds what exists and creates
only what is missing. The `item_images` row is written AFTER both objects are up,
and object names are derived from the seed, so a photo interrupted mid-upload is
re-uploaded to the same path, with the same bytes on the same sharp build and
fonts.

**Rollback** is teardown. There is nothing else to undo: the seed changes no
existing row outside the Perf Lab organization, adds no migration, and touches no
configuration. A seed that was interrupted can be either finished (run it again)
or removed (teardown works on a partial organization).

## Safety rails

WHEN each rail acts matters, so it is stated per rail rather than once, and the
exit code is a promise:

- **Exit 2, "nothing was read or written"**: refused before any network call.
  Rails 1-5 and 12, the flag half of rail 6 (`--slug`; an `--org-id` that is not a
  uuid or is one of the two forbidden ids), and the production environment checks
  of rail 4. A refused production run of this kind never reaches production.
- **Exit 2, "only reads were run"**: refused after read-only queries and before the
  first write or delete. Rail 6's row checks, rails 7-9, 11 and 14. They are
  questions about the database, so they cannot be answered without reading it; the
  reads go to the pinned host with the key meant for it.
- **Not refusals at all**: rail 10 is how every statement is built, and rail 13
  acts while a teardown is running. And rails 7-9 and 11 are RE-ASSERTED mid-run
  (rail 14). When one of them fails after writing has begun, the run stops with
  **exit 1**, says what it had already done and how to recover, and never prints
  "REFUSED": exit 2 must not be readable as "nothing happened" when something did.
  The two trailers are appended by `refuseEarly()` and `refuse()` in `lib.mjs`, not
  typed into each message, so a message cannot claim the wrong one.

Exit codes: **0** success. **1** a runtime error, a rail failing mid-run, or a
missed verify target: look, then run the same command again. **2** a rail refused
and at most reads were run. **3** (teardown only) the work finished but something
was deliberately KEPT or could only be REPORTED; re-running will not change that, a
person has to look.

Rails 1-10, 12 and 14 live in `lib.mjs`; rail 11 in `seed.mjs`
(`preflightAccounts`); rail 13 in `teardown.mjs` (`reasonToKeep`,
`deleteAccounts`), on `lib.mjs` helpers.

1. `--target=local|production` is mandatory. There is no default.
2. `local` accepts only a Supabase URL on 127.0.0.1 or localhost, and uses its
   origin only (a path, query or userinfo in `SUPABASE_URL` does not ride along).
3. `production` is pinned to the one production host inside the script and is
   never taken from the environment. If `SUPABASE_URL` is set to a different host
   the run is refused (the shell and the flag disagree).
4. `production` also needs `--i-am-authorized-by-the-owner` AND
   `PERF_LAB_CONFIRM=stockpilot-perf-lab`, then prints a plain-language summary
   and waits 10 seconds before the first write. It refuses a shell that could
   change what "send the key to production" means: `NODE_TLS_REJECT_UNAUTHORIZED=0`
   (certificate checking off), a non-empty `NODE_OPTIONS`, or node started with
   `--import`, `--require` or `--loader` (code preloaded into the process that
   holds the key).
5. The key is read from the environment variable `SUPABASE_SERVICE_ROLE_KEY`
   only. Never from a file, never printed, never included in an error message.
   EVERY request refuses to follow a redirect, the supabase-js client's included:
   on a cross-origin redirect undici drops `Authorization` but not `apikey`, and
   for `sb_secret_` keys the apikey header is the secret.
6. The run aborts unless the key bypasses RLS (the `seed-demo-org.mjs` probe: an
   anon key reads `organizations` as empty, and "find or create" would create).
   The organization is then found by the constant slug, and the row that comes
   back is refused if its id is not a uuid, is the customer organization
   (`63c13e64-92a6-4ea4-9936-6a2c26a85b4a`) or Demo Co
   (`71b27a4a-7948-4638-bc3f-535974713bd2`), or if its slug is not EXACTLY
   `stockpilot-perf-lab` (`slug` is citext, so the lookup alone would accept a
   different case). `--slug` and `--org-id` are assertions, not selectors: a
   wrong slug, a forbidden id, or an id that does not match the slug's row is
   refused.
7. **The slug is not proof of ownership.** The product lets a person create an
   organization whose name slugifies to `stockpilot-perf-lab`
   (`createOrganizationAction` slugifies the name and only suffixes a slug that is
   already taken), and that row is in no forbidden list. So a row found by slug
   is trusted only if its name is exactly `StockPilot Perf Lab` AND it carries the
   provenance marker `perf-lab-synthetic` in `billing_notes`. The seed writes that
   marker in the same statement that creates the row. No tenant can write that
   column (the 0218 trigger blocks the `authenticated` and `anon` roles from every
   billing column), so a product-created organization can have the slug and the
   name and still cannot have the marker. The note also tells anyone who opens the
   organization in the platform console what it is. All three scripts apply this
   in `assertIsPerfLabOrg()`, and `orgScope()` re-applies it, so no code path holds
   an org-scoped handle on a row that did not pass.
8. **No real people.** Before the first write or delete, and in a dry run, seed
   and teardown refuse unless every MEMBER is one of the six EXACT Perf Lab
   addresses, there is no PENDING INVITATION (`organization_invites` with
   `accepted_at` null), and there is no CUSTOMER-PORTAL LOGIN (`customer_users`
   through `customers.organization_id`; portal users are never in
   `organization_members`). The Perf Lab creates neither of the last two, so a
   person did. Zero members is allowed: it is what a seed interrupted between
   creating the organization and the first membership leaves, and rail 7 has
   already settled whose row it is. `verify.mjs` reports all three as failed checks
   instead of refusing, because the census is still worth reading. Counts and roles
   only, never an address.
9. **Pinned on production.** On `--target=production`, an organization that
   already exists must be named with `--org-id`, in all three scripts. The first
   run finds nothing, creates it and prints the id at once; every later run says
   which organization it means. The refusal prints the id so a crashed first run
   can be resumed. It is reached only by a row that passed rails 7 and 8.
10. Every org-scoped statement goes through `orgScope()`: selects, updates and
    deletes get `organization_id = <Perf Lab>` appended; inserts are checked row
    by row; an update may not contain `organization_id`. The organization row is
    deleted by `id` AND `slug`. A storage path is removed only if it sits strictly
    under the organization's uuid with no empty, `.` or `..` segment (the listing
    BUILDS paths from that prefix, so a bare `startsWith` would prove nothing; what
    is tested is what a listing could smuggle in, a hostile entry name).
    `--dry-run` prints counts and writes nothing, and that is enforced twice: the
    write scope is built from the `--dry-run` flag itself, so its write methods
    THROW in a dry run, and every write that does not go through the scope
    (storage, the Auth admin API, the organization row, order lines) calls
    `assertLive()`, which throws too. A forgotten branch is a loud bug, never a
    quiet write.
11. Anything that can refuse a run is checked BEFORE the first write, and a dry
    run refuses too rather than printing "would create". A Perf Lab address that
    already exists is ADOPTED by the seed only if it belongs to the Perf Lab and to
    nothing else (no other membership, no customer-portal login) AND carries the
    stamp the seed writes into the account's auth `app_metadata`
    (`perf_lab: perf-lab-synthetic`). A signed-in user cannot write
    `app_metadata`, so an account somebody registered by hand at
    `perf-lab+owner@...` does not have it and is refused. (The tie check first
    lived inside the account loop, where it fired only after the organization had
    been created. A local test caught that; it is now a preflight. The in-loop
    check remains as a backstop, and because it runs mid-run it exits 1, not 2.)
12. Unknown flags are refused, so a misspelt `--dry-run` cannot become a live run.
    So is a flag given twice (a recalled line with a second `--target` appended
    would otherwise silently use the last one), and the lookup uses own properties
    only (`constructor=x` used to be accepted).
13. **Which accounts teardown deletes.** Asked when the plan is made and asked
    AGAIN, from scratch, immediately before each `auth.admin.deleteUser`, because a
    countdown, ~880 object removals and ~25 table deletes sit between the two
    (`platform-admin.ts` re-verifies at the same point): the auth user's CURRENT
    email, read from Auth at that moment and not from the plan, is one of the six
    exact addresses (not a pattern: a teammate's own `perf-lab+name` login is a
    stranger under rail 8); it carries the stamp of rail 11; it was a member of
    this organization or belongs to no organization at all; and nothing else ties
    it (no other membership, no portal login). An account that fails any of these
    is KEPT and reported, with the reason, and teardown exits 3. A count that
    cannot be read stops the run; and a count is usable only if it is a
    non-negative integer (`NaN` is a number too, and `NaN > 0` is false, which is
    how "has ties?" would have answered "no").
14. **Ownership is re-asserted, not assumed to hold.** Rails 6-9 and 11 run again
    right after the production countdown (ten seconds in which a person can join
    or be invited), and in teardown once more immediately before the membership
    rows and again before the organization row are deleted, minutes after the
    first check. After the countdown a failure is still a refusal (only reads so
    far); later it is exit 1 with what was already removed.

Reads never treat "no answer" as "none": a select that comes back without a rows
array, a page that repeats, a count that is not a non-negative integer, and a
paged read that exceeds 1000 pages all stop the run (`must`, `fetchAll`,
`exactCount` in `lib.mjs`). postgrest-js answers `{ data: null, error: null }` to
a 2xx with an empty body, which is how "none found" gets reported without anything
having been found out.

Reads that cannot be org-scoped by nature, and how they are narrowed instead:
the RLS probe (`organizations`, `id` only, limit 1); the organization lookup (by
slug); accounts (by the six exact emails, through `user_profiles`, not by paging
every user through the Auth admin API); the memberships, preferences and push
tokens of those account ids, and each one's auth record by id; one lookup of
`organizations` and one of `user_profiles` BY THE PINNED ID, only when no
organization holds the slug (teardown, rail below); `order_request_lines` (no
`organization_id`; reached only through an order found or created under the Perf
Lab id).

## Side effects: what could email, notify, call out or charge, and why it does not

Audited against the migrations and the app at this commit. "Plain insert" means a
PostgREST insert with the service-role key, which skips every app-layer side
effect (audit log, Resend email, `dispatchEvent` webhooks, embeddings).

| Surface                               | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | How the seed prevents or bounds it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Auth emails**                       | `auth.admin.createUser` with `email_confirm: true` sends nothing. No auth hook is configured. The `auth.users` insert trigger (`tg_handle_new_auth_user`, 0001) only mirrors a `user_profiles` row: no personal organization, no welcome email.                                                                                                                                                                                                                                                                                                                              | Accounts are created that way and no other. No invite, no `generateLink`, no password reset.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Sign-in alert email**               | `noteLoginDevice` emails "new device" only from the PASSWORD sign-in action, and only for a second device. `/auth/confirm` (magic link) does not call it.                                                                                                                                                                                                                                                                                                                                                                                                                    | The accounts have a random 40-character password that is discarded, so nobody signs in by password.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Push**                              | Every `notifications` row fires `_dispatch_push_for_notification` (0313), which POSTs to Expo once per row in `push_tokens`. No tokens, no HTTP call.                                                                                                                                                                                                                                                                                                                                                                                                                        | New accounts have no push tokens; `verify.mjs` asserts zero.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **In-app notifications from inserts** | `inventory_items`: the low-stock trigger is `AFTER UPDATE` only, so inserting 443 items (35 out of stock, 76 at or below reorder point) writes none. `order_requests`: `trg_order_requests_notify` fires on INSERT in any status except `pending_confirmation`, for every owner/admin/manager whose `push_order_request_created` is not false.                                                                                                                                                                                                                               | All preferences are switched off BEFORE orders are inserted. The seed then proves, not assumes, that every notify-eligible member is a Perf Lab account with that preference false and no push token; otherwise it skips orders and says so. Afterwards it re-counts `notifications` and removes anything that appeared. The seed never UPDATEs an item or an order (the low-stock trigger ignores preferences).                                                                                                         |
| **Email preferences**                 | `notification_preferences` has 23 boolean columns, all default TRUE. `user_profiles.email_digest_optin` defaults FALSE.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Every boolean in the row is set false, discovered from the row itself so a column added by a later migration is covered. `email_digest_optin = false` and the `digest_section_*` flags are written explicitly.                                                                                                                                                                                                                                                                                                           |
| **Crons**                             | 18 Vercel crons. Those that could reach a new organization: `daily-briefing` (selects orgs whose `ai` module is enabled, which `seed_org_modules()` turns ON by default; calls the AI provider and notifies owners/admins); `schedule-reminders` (EMAILS on `schedule_events`); `rental-overdue` (emails on `rentals`); `auto-reorder` / `recurring-pos` (module `purchase_orders` + settings + paid plan); `weekly-digest` (opt-in only); `auto-archive-zero-stock` / `auto-delete-archived` (per-org setting, default off; and `zero_since` is only stamped by an UPDATE). | `ai`, `schedule`, `rentals`, `purchase_orders` and the rest are switched OFF as the first thing after the organization is created (one re-read and about a dozen updates: well under a second locally, a few seconds over a WAN), before any account exists to notify. A run killed inside that window is benign: `daily-briefing` skips an organization with no accepted owner or admin, and both a re-run and teardown repair it. No schedule events, rentals, connections or templates are seeded. Plan stays `free`. |
| **Crons that still touch it**         | `prewarm-orders-catalog` (every 30 min, organizations with an accepted member, most recent 50): read-only, warms the Items and Books default views and signs their image URLs. The nightly `refresh_org_daily_stats` pg_cron job aggregates every organization in SQL.                                                                                                                                                                                                                                                                                                       | Accepted. Neither writes to the organization, emails, or calls out. See the fidelity note below.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Webhooks / integrations**           | `dispatchEvent` is app code; deliveries need rows in the organization's integration endpoints. The accounting drainer needs an active `org_connections` row.                                                                                                                                                                                                                                                                                                                                                                                                                 | None exist, none are seeded, and plain inserts never call `dispatchEvent`.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Billing / Stripe**                  | Nothing creates a Stripe customer, starts a trial or sends a billing email on organization insert; Stripe is reached only from checkout and the inbound webhook. No trial-expiry cron exists.                                                                                                                                                                                                                                                                                                                                                                                | Plan `free`, no Stripe ids, no trial columns set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Realtime**                          | `inventory_items`, `order_requests` and `notifications` are in the `supabase_realtime` publication.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Harmless: changes are delivered only to subscribers RLS lets see the row, which is nobody outside the Perf Lab.                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Search embeddings**                 | No trigger, no queue, no cron. Embeddings are generated only by `InventoryService.create/update` and the manual backfill button.                                                                                                                                                                                                                                                                                                                                                                                                                                             | Plain inserts never reach that code: 443 items cause zero embedding calls. (`search_vector` is built in-process by a trigger; no I/O.)                                                                                                                                                                                                                                                                                                                                                                                   |
| **Platform alerts**                   | No database trigger or cron alerts anyone about a new organization or user. `audit-anomalies` posts to the error webhook on mass deletes recorded in `audit_logs`.                                                                                                                                                                                                                                                                                                                                                                                                           | Plain inserts and deletes write no `audit_logs`, so teardown does not trip it. Do NOT delete the 443 items through the app UI instead.                                                                                                                                                                                                                                                                                                                                                                                   |

**Fidelity note, prewarm.** The customer's organization and Demo Co are
`KNOWN_HOT_ORG_IDS` in `api/cron/prewarm-orders-catalog/org-sweep.ts`: besides the
broad sweep they get the storefront catalog and its thumbnail map warmed per
warehouse every 30 minutes. The Perf Lab gets only the broad sweep (Items and
Books default views). So a storefront measurement in the Perf Lab can meet a
colder server cache than the customer does. Either record that in
`PERF_SERVER_STATE`, or add the Perf Lab id to that constant for the duration of
the program; that is a code change and an owner decision, not something a seed
script should do.

### Modules

`seed_org_modules()` (latest body: migration 0314) switches 26 modules on for any
new organization. Owner rule: a seeded organization must not start automation,
so the seed pins every module row explicitly, and switches off any row it does
not recognise.

| State | Modules                                                                                                  | Why                                                                                                                                                                                                                                               |
| ----- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ON    | the 12 core modules                                                                                      | `/dashboard`, `/dashboard/inventory`, `/dashboard/inventory/[id]`. Core modules cannot be switched off.                                                                                                                                           |
| ON    | `books`                                                                                                  | `/dashboard/books`.                                                                                                                                                                                                                               |
| ON    | `orders`                                                                                                 | `/dashboard/orders`, `/dashboard/orders/[id]`, and the storefront `/dashboard/orders/new`, which has no module of its own: it checks `orders:request`, and reads `inventory_items`, `item_images`, `stock_reservations` and `warehouse_charters`. |
| OFF   | `ai`                                                                                                     | gate of the daily-briefing cron (AI call + notifications). On by default.                                                                                                                                                                         |
| OFF   | `purchase_orders`, `receiving`, `po_imports`                                                             | gate of the auto-reorder and recurring-PO crons; the other two depend on it.                                                                                                                                                                      |
| OFF   | `schedule`                                                                                               | the reminder cron is the one cron that emails members.                                                                                                                                                                                            |
| OFF   | `rentals`, `returns`, `public_requests`                                                                  | overdue emails, return-prompt emails, outward-facing links.                                                                                                                                                                                       |
| OFF   | `bundles`, `cycle_counts`, `procedures`, `suppliers`                                                     | no background job, but no measured page needs them. The suppliers table is still seeded.                                                                                                                                                          |
| OFF   | `planning`, `lot_serial`, `price_tracking`, `live_tracking`, `zendesk`, `sports`, `maintenance_requests` | off by default; pinned off.                                                                                                                                                                                                                       |

`all_modules_comp` stays false: since migration 0354 a comp wins over an explicit
`enabled = false` for access. Consequence worth knowing: the sidebar is shorter
than the customer's. If nav parity matters for a measurement, switch on modules
with no automation (`bundles`, `cycle_counts`, `procedures`, `suppliers`) in
Settings > Modules and note it in `PERF_DATASET`.

### Orders

Seeded, with plain inserts, because the measured "Dashboard -> Orders" and
"Orders -> Order" scenarios need rows. Verified against the schema:

- The app itself creates an order with a plain insert (no RPC); approval and the
  rest of the state machine are RPCs that refuse a null `auth.uid()`, so plain
  inserts are the only path open to a service key anyway.
- INSERT is not bound by the status-transition guard (`BEFORE UPDATE OF status`),
  so rows can be inserted directly in any of the 14 statuses.
- `order_number` is supplied (1-60): the numbering trigger passes an explicit
  number through, and it is the idempotency key.
- All orders are `pickup`. A delivery order needs a charter
  (`order_requests_delivery_target_chk`), and no charters are seeded because
  `inventory_items.charter_id` is ON DELETE RESTRICT. So `staged_for_delivery`
  and `in_transit` are absent; the other 11 visible statuses are present, with
  12 orders in `pending_approval`, the list's default tab.
- No stock reservation, stock movement, schedule event, outbox row, audit row or
  email results: all of those live in RPCs or app code. The one database side
  effect, the notification trigger, is handled as described above.
- `--skip-orders` leaves them out; `verify.mjs --allow-no-orders` accepts that.

## Teardown and cascades

90 foreign keys reference `organizations(id)` ON DELETE CASCADE (4 more are SET
NULL), so nearly everything follows the organization row. Some sibling tables
also hold ON DELETE RESTRICT keys onto `warehouses` and `inventory_items`
(`order_requests.warehouse_id`, `order_request_lines.item_id`, and the receipts /
shipments / rentals / bundles / bins / putaway / serial tables). Tested on the
local stack rather than reasoned (the first draft of this section reasoned, and
named the wrong constraint): on the fully seeded organization a bare organization
delete is REFUSED with 23503 on `order_request_lines_item_id_fkey`, because the
cascade reaches `inventory_items` while order lines still reference them; with a
single order and no lines it succeeds. Which key fires depends on the order
Postgres runs its referential triggers, so teardown does not rely on it.

What teardown does, in order:

1. Re-asserts ownership after the countdown (rail 14).
2. Removes storage objects under `<orgId>/` in EVERY bucket, listed by walking
   folders and paging until an empty page (storage is not reached by any cascade).
3. Deletes the RESTRICT-holding tables and the seed's own tables children-first,
   each filtered by the organization id, touching only tables that hold rows.
   Ownership is re-asserted before the membership rows go.
4. Re-asserts ownership once more and deletes the organization by `id` AND `slug`
   (its cascade sweeps whatever the app wrote while the org was in use).
5. Lists and removes under `<orgId>/` A SECOND TIME, while the validated id is
   still in memory. An upload that landed during steps 2-4 (the web app was open,
   the harness was running) would otherwise be left behind with nothing in the
   database pointing at it.
6. Deletes the accounts (rail 13).
7. Re-checks that the organization, its items, its objects and its accounts are
   gone. If anything is left that was not kept on purpose it fails, says WHICH
   category remains, and says to re-run WITH `--org-id`: once the organization row
   is gone that id is the only handle on stored objects, and a run without it
   cannot see them (it says so, rather than reporting "no leftover objects").

`order_request_lines`, `notification_preferences`, `user_onboarding` and
`user_release_state` go by cascade from their order or their auth user.

**When no organization holds the slug.** Either nothing was ever seeded, or a
teardown was interrupted after the organization delete, or somebody removed the
organization another way. Seed and verify refuse `--org-id` in that state (the
operator believes something exists that does not). Teardown treats it as expected,
and with `--org-id` it says nothing about that id until it has looked it up:

- an organization row with that id under ANOTHER slug means the pinned
  organization still exists and was renamed. Refused; that is somebody's
  organization now.
- the id of a USER is refused. `user-avatars` stores under `<user id>/`, so
  listing `<id>/` for a mistyped id could find, and offer to delete, a person's
  avatar.
- only when no organization row and no user holds the id are objects under
  `<id>/` orphans. In `item-images`, files with exactly the seed's own names
  (`<id>/items/<uuid>/<uuid>.<ext>` and `-thumb.webp`) are removed, after the
  countdown and after proving again that no row holds the id. Anything else, in any
  bucket, is REPORTED and left, and teardown exits 3: this tool did not write it
  and will not guess.

Leftover accounts are swept under rail 13. An account that is kept makes teardown
exit 3, in this branch and in the main one.

## Footprint and time

|                                         | Measured on the local stack (dataset v2)                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Stored objects                          | 443 masters + 437 thumbnails = 880                                                                                                 |
| Stored bytes                            | 157.0 MiB masters + 7.5 MiB thumbnails (164.5 MiB); four masters of about 5 MB are 21 MiB of that                                  |
| Rows                                    | 443 items, 443 item_images, 408 stock levels, 60 orders + 211 lines, 15 locations, 33 module rows                                  |
| Seed, first run                         | 64 s (image generation is about 50 s of it: each file is encoded up to a dozen times while grain is searched)                      |
| Seed, re-run on a finished organization | under 1 s, writes nothing (independent before/after snapshot: no row added, no `updated_at` moved)                                 |
| Verify                                  | 3 s on loopback (about 1250 ranged reads, 450 storage listings, 12 access-gate calls; against production the round trips dominate) |
| Teardown                                | 2 s                                                                                                                                |

Against production, add the upload of about 165 MiB over the operator's uplink at
4 uploads in flight. Generation is CPU-bound and does not change.

## What the local runs established (2026-09-20)

Durable facts from proving this on the local stack, each observed rather than
reasoned. The tooling went through two independent adversarial reviews; each line
in the later groups is the proof of one fix. Counts from before dataset v2 are
marked (v1).

First pass:

- Every no-network refusal (wrong slug, both forbidden ids including upper case,
  production without the flag, production without the variable, a non-loopback URL
  with `--target=local`, a shell URL that disagrees with `--target=production`, a
  misspelt `--dry-run`, no target, no key) exits 2; so does an anon key. A decoy
  row carrying Demo Co's id under the Perf Lab slug, planted in the LOCAL database,
  is refused by seed, verify and teardown alike; so is a slug differing only by case.
- The local mail catcher (Mailpit) held 0 messages before, during and after every
  run in every pass. The organization held 0 notification rows, 0 stock movements
  and 0 audit rows.
- A seed interrupted after uploads but before the `item_images` row, between a
  master and its thumbnail, and between an order and its lines, resumes to a
  passing verify with the object count still 880.

After the first review:

- **An organization a person made through the product** (slug + exact name + a real
  owner, no marker) is refused by seed (dry run too), verify and teardown, and is
  left exactly as it was. An organization holding the slug under a different name is
  refused on the name.
- **A real person in the genuine Perf Lab** makes seed and teardown refuse (dry runs
  too) and verify report misses; an independent snapshot shows nothing was written
  or deleted. **A seventh `perf-lab+` address** is refused the same way and the
  account still exists afterwards.
- **The production pin**, exercised by calling the same `lib.mjs` function the
  scripts call with `target: 'production'` against the local database (no
  production URL, flag or variable involved): not pinned refuses and prints the
  id; pinned passes; a wrong id refuses; `local` needs no pin. **Zero members stays
  allowed**: a seed killed before its first account resumes to a passing verify.
- **Ties are re-counted at the point of deletion**: an account that gained a
  membership after the plan, and one with a portal login, both survive teardown.
- **Interrupted teardown**: the real command with the network dropped on the third
  account delete dies after "organization: deleted"; the IDENTICAL command finishes.
- **No check passes because its read failed**: a 502 on the push-token read or the
  auth-user read makes verify exit 1 instead of printing 0. An order stripped of
  its lines makes verify miss (v1: "order lines 192 / 189"); the seed heals it.

After the second review (dataset v2):

- `verify.mjs` passes all 115 checks against the stored objects: the three writer
  classes 301 / 69 / 67 and 6 rows with no thumbnail, classified from magic bytes,
  placeholder MIME and served Cache-Control alone; thumbnails 370 really WebP and
  67 really PNG while all 437 are named `-thumb.webp` and served as `image/webp`;
  masters 358 / 84 / 1 by served type and 358 / 82 / 3 by magic bytes with exactly 2
  PNG files served as `image/webp`; every thumbnail of 30 KB or more is a PNG.
- **A local-only fault found by that run**: the local storage server (file backend)
  HANGS on a range that ends past the end of the object (`bytes=0-65535` on a 40 KB
  master: no answer until the gateway cuts it after 60 s; `bytes=0-1023` answers in
  2 ms). Dataset v1 had no master that small. The probe now reads 64 bytes, learns
  the size, and never asks past it; a timeout makes a hang a MISS, not a crash.
- **Orphan objects are seen**: an organization seeded earlier, into which 12 extra
  objects had been uploaded through the web app, fails "objects stored under
  <orgId>/: 880 / 892" while its 443 photo rows still look complete.
- **Accounts without the stamp**: that same organization's six accounts predated
  the stamp. Teardown removed the organization and KEPT all six ("not created by
  this tool"), exit 3; the seed then refused to adopt them.
- **NaN count**: with the "other memberships" count answered as `Content-Range:
0-0/*`, teardown stops with "no usable count" instead of reading "no ties".
- **Null answers**: a 200 with an empty body on the slug lookup, the account lookup
  and a paged read each stop the run; so does the same page coming back twice.
- **Unreadable notifications table**: the seed stops before inserting any order.
- **Pending invitation / portal login**: seed and teardown refuse (dry runs too);
  verify reports a miss; a snapshot shows nothing changed.
- **Ownership re-asserted**: a person who joins after the first check makes both
  seed and teardown REFUSE (exit 2, snapshot unchanged). One who joins while
  teardown is already removing objects makes it stop with exit 1 and "STOPPED
  PART-WAY"; with the person gone, the same command finishes.
- **Mid-run failure is not exit 2**: a tie that appears after the seed's preflight
  is caught by the in-loop backstop with exit 1; a re-run recovers.
- **Upload during teardown**: an object that lands after the storage pass is
  removed by the second pass ("1 more removed").
- **Identity at deletion**: an account given a real person's email after the plan
  is KEPT at the last check; teardown exits 3.
- **Organization absent, id pinned**: refused when that id still exists under
  another slug, and when it is a user's id. With objects left under a free id, the
  two with the seed's own names are removed and a third is reported and left
  (exit 3); without `--org-id` teardown says it did not look.
- **Dry-run backstops throw** when called directly; both write scopes are built
  from `args.dryRun`.
- New no-network refusals: `constructor=x`, a flag given twice, a non-uuid
  `--org-id`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, a set `NODE_OPTIONS`, `node --import`.
- Two full generations print the same v2 fingerprint, with no key in the
  environment.

## Not seeded, on purpose

- **First-run state.** New accounts see the Getting-started panel on
  `/dashboard` (`user_profiles.onboarding_dismissed_at` is null) and tour offers
  (`user_onboarding`, `user_release_state` empty). That is an honest first visit
  but not a steady-state user. Dismiss them once per account in the UI before a
  measured run, or decide to seed that state; it was left out because it is a
  measurement decision, not a dataset one.
- **Charters, purchase orders, receipts, movements, rentals, schedule events.**
  Not needed by a measured page; several would wake a cron or add RESTRICT keys.
- **Embeddings.** Semantic search over Perf Lab items returns nothing. The
  "Backfill embeddings" button would make 443 outbound calls; do not press it.
