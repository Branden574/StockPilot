# Simulator smoke suite

Drives the real StockPilot app on the iOS simulator via `idb` and asserts on
the rendered accessibility tree. It exists because the last three
floor-reported bugs — the sheet-scroll regression (d8e9669f / #135), the
delivery-request compose surface (#132), and the maintenance email actions
(#136) — were device-surface bugs in `.tsx` screens, gesture arbitration,
and deep-link rendering. Mobile vitest cannot reach `.tsx`, so it could not
see any of them. This suite can.

## Running it

```
cd apps/mobile
pnpm smoke:sim              # all four flows
pnpm smoke:sim --flow sheet-scroll   # one flow while iterating
python3 scripts/smoke/smoke.py --dump  # print the current screen's labels
```

Exit code is non-zero on any flow failure; each failed flow saves a
screenshot under `scripts/smoke/artifacts/` (gitignored) and prints its path.

## What it covers

| flow | kind | surface | the regression it guards |
| --- | --- | --- | --- |
| `login-shell` | render-only | app reaches the signed-in shell; tabs render | blank/stuck shell on boot |
| `sheet-scroll` | **behavioural** | orders -> first order -> Add items sheet: a row must MOVE under a swipe, and a scrim tap must close the sheet | d8e9669f: sheets could not be scrolled until something else took the touch |
| `delivery-section` | render-only | deep link to SO-000021 (fulfillment=delivery): delivery-request section renders with its action button and the recipients line naming dc4@learn4life.org | #132's SCREEN renders and does not crash. It does NOT verify the compose url or transport — those are unit-pinned; the url handed to the OS is only observable on a tap this read-only suite must not make |
| `maintenance` | render-only | maintenance list -> first request detail -> the email action area's controls (Open in Outlook / Copy Email Details) exist | the #127/#136 SCREEN renders. It does NOT exercise compose-link fit, one-tap copy, or the double-tap guard — those behaviours are unit-pinned in src/lib; this flow only proves the screen offering them still stands up |

Be precise about what "render-only" buys: those three flows catch a crash, a
blank screen, a module gate wrongly hiding a section, or a deep link that
stopped resolving. They would NOT catch a frozen, untappable UI — only
`sheet-scroll` and the gesture self-validation are behavioural. When adding a
flow, prefer asserting something MOVED or CHANGED over asserting a label
exists, and label the row honestly either way.

Before any flow runs, the driver self-validates the swipe gesture against
the orders list (known to scroll). If the gesture itself is broken the run
ABORTS and says the harness — not the app — failed. A smoke suite that can
blame the app for its own broken gestures is worse than none.

## What it deliberately does NOT do

- **No writes.** V1 is read-only against the demo org
  (71b27a4a-7948-4638-bc3f-535974713bd2): no order mutations, no tickets
  filed, no quantities changed. A nightly run must not accrete junk data.
  Mutating flows go behind the `MUTATING-FLOWS` extension point in
  `smoke.py` and need their own fixture + cleanup story plus an explicit
  `--allow-writes` gate before they exist.
- **No Outlook handoff.** The delivery and maintenance flows assert the
  compose actions RENDER; they never tap them. Tapping would leave the app
  into Outlook/Safari, and the ms-outlook:// handoff is a physical-device
  behaviour anyway.
- **No physical-device behaviours.** Push notifications, Face ID, camera,
  the real Outlook app, HEIC capture — none of these exist meaningfully on
  the simulator. Device hand-tests remain the bar for those (owner rule:
  simulator-test every mobile change, hand-test device flows).

## Prerequisites (the driver checks the first three and fails loudly)

1. **Metro on :8081** — the installed app is a DEBUG build that loads JS
   from Metro. `cd apps/mobile && pnpm start`.
2. **Web server on :3000** — the debug binary has `localhost:3000` baked
   into `extra.apiUrl`; maintenance reads and the enabled-modules snapshot
   go over that REST API. Run apps/web with the prod-Supabase env
   (`.env.local.prod`), e.g. from apps/web:
   `set -a; source .env.local.prod; set +a; pnpm exec next dev --port 3000`.
3. **The simulator** — iPad Pro 13-inch (M5),
   UDID `0620A9E7-237A-4E16-9953-C8CD4AC6D284`, iOS 26.5, with
   `app.stockpilot.mobile` installed. The driver boots it if shut down.
4. **Demo-org state** — the app is normally already signed in as
   demo@stockpilotusa.com; if not, the driver signs in with the password
   from the macOS keychain (`stockpilot/demo-org-qa-login`). The
   `maintenance_requests` module must be enabled for Demo Co (one-time
   setup, done 2026-08-16) and at least one maintenance request must exist
   (MR-2026-000001, a cancelled deploy-check row, satisfies this).

## Adding a flow

1. Write `def flow_<name>():` in `smoke.py` returning
   `(passed: bool, reason: str)` — one line, specific, names the element it
   could not find.
2. Navigate by deep link (`open_url("stockpilot://...")`) and wait with
   `wait_for(...)` on a landmark label. Never assert after a fixed sleep.
3. Tap only frame centers from `describe-all` (`tap_element`). Never derive
   coordinates from screenshots — frames are points, screenshots are ~2x
   pixels.
4. Every swipe goes through `swipe()`, which always passes `--duration`.
5. Register it in `FLOWS`. Keep it read-only, or gate it as described in
   the MUTATING-FLOWS note.
6. Comment which real-world regression class the flow guards — that is the
   admission ticket; this suite is not a UI tour.

Use `--dump` on any screen to see the labels/frames you can anchor on.

## Scheduling (nightly)

`com.stockpilot.smoke.plist` in this directory is an EXAMPLE launchd job:
nightly at 03:30, logging to `scripts/smoke/artifacts/`. It is written
here but NOT installed. Installing it is one command, run by the owner:

```
cp apps/mobile/scripts/smoke/com.stockpilot.smoke.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.stockpilot.smoke.plist
```

Honest caveats:

- A laptop with the lid closed (or asleep) will not run it. launchd fires
  missed jobs on wake at best; there is no guarantee a 03:30 job runs at
  all on a machine that sleeps nights.
- The job assumes Metro and the :3000 web server are already running; the
  driver fails fast with a clear message if they are not (that failure
  lands in the log, which is still useful signal).
- The CI-grade home is the GitHub Actions workflow below; this launchd job
  is the laptop-local interim.

## CI (.github/workflows/smoke-sim.yml)

The CI home for this suite: a macOS runner builds a RELEASE simulator app
via EAS (the `simulator` profile in eas.json — bundled JS, no dev client;
baked `extra.apiUrl` is the production API), creates and boots an iPad Pro
13-inch simulator (the driver's tap/swipe geometry is that device's),
installs the .app, and runs `python3 scripts/smoke/smoke.py --ci --udid
<created sim>`.

What `--ci` changes, and nothing else changes:

- The Metro and :3000 preflight checks are SKIPPED — a release build has
  no Metro and no localhost API; those prerequisites do not exist in CI.
- Flows that depend on the locally served REST API are SKIPPED and printed
  as SKIP in the summary, never counted as passes.
- Sign-in falls back to the `STOCKPILOT_SMOKE_PASSWORD` environment
  variable when the macOS keychain entry is absent (a CI runner has no
  user keychain).

Which flows run where:

| flow | local | CI | why |
| --- | --- | --- | --- |
| `login-shell` | yes | yes | auth is Supabase-direct; CI signs in via the secret |
| `sheet-scroll` | yes | yes | the Add-items sheet READS via Supabase-direct queries |
| `delivery-section` | yes | yes | order + routing reads are Supabase-direct |
| `maintenance` | yes | SKIPPED | its list/detail reads are served by the REST API layer (locally :3000); running it against whatever the release build's baked apiUrl reaches is a deliberate later decision, not a default |

Owner steps before the schedule can be enabled (repo Settings > Secrets):

1. `EXPO_TOKEN` — Expo access token with build rights (expo.dev > Account
   settings > Access tokens). The `eas build` step cannot authenticate
   without it.
2. `STOCKPILOT_SMOKE_PASSWORD` — the demo-org QA password (same value as
   the keychain entry `stockpilot/demo-org-qa-login`).
3. Uncomment the `schedule:` block in the workflow. It ships commented out
   on purpose: a scheduled job that fails nightly for want of a secret is
   noise, not coverage. `workflow_dispatch` works as soon as the secrets
   exist.

Honest status: the workflow is authored and statically validated (YAML
parse + structure checks; the driver's `--ci` path compiles and its CLI
parses). A macOS runner cannot be executed from the development
environment, so THE FIRST REAL RUN HAPPENS IN CI via workflow_dispatch and
may surface runner-environment issues (idb install, EAS queue times,
simulator runtime names) that static review cannot. The local `pnpm
smoke:sim` path is untouched — no `--ci` means byte-for-byte the workflow
this README documents above.
