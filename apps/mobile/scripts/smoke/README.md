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

| flow | surface | the regression it guards |
| --- | --- | --- |
| `login-shell` | app reaches the signed-in shell; tabs render | blank/stuck shell on boot |
| `sheet-scroll` | orders -> first order -> Add items sheet: a row must MOVE under a swipe, and a scrim tap must close the sheet | d8e9669f: sheets could not be scrolled until something else took the touch |
| `delivery-section` | deep link to SO-000021 (fulfillment=delivery): delivery-request section renders with its action button and the recipients line naming dc4@learn4life.org | #132: the native compose surface |
| `maintenance` | maintenance list -> first request detail -> email action area (Open in Outlook / Copy Email Details) renders | #127/#136: compose-link fit, copy, double-tap guard |

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
- The CI-grade home for this suite is a macOS CI runner that builds a
  simulator app via EAS (`eas build --platform ios` with a simulator
  profile), boots a sim, and runs this driver against the built binary —
  no Metro, no laptop. That is the follow-up; this launchd job is the
  interim.
