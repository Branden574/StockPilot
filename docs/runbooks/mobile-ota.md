# Phone app OTA (EAS Update) runbook

How to ship a JavaScript-only update to the StockPilot phone app without a new
store build, check what phones are served, and roll it back. For a native build
see [mobile-release.md](./mobile-release.md), and the native-safety rule below
for which one a change needs.

Every command here runs eas-cli 20.3.0 through `pnpm dlx eas-cli@20.3.0`, the
version the release scripts in `apps/mobile/package.json` pin. eas-cli is not a
dependency of the repository, so `pnpm exec eas-cli` does not work. Do not use
`npx eas-cli@latest` or a global `eas`: another version can bundle, upload or
resolve the environment differently from the one these steps were checked
against.

## Publish: `pnpm release:ota`

From the main checkout, on `main`, up to date and clean (see "Before you
publish"):

```bash
git switch main && git pull --ff-only
git status --short                 # must print nothing
pnpm install --frozen-lockfile     # whenever a merged PR changed pnpm-lock.yaml or patches/
cd apps/mobile
pnpm release:ota -m "What changed, in one sentence"
```

`pnpm release:ota` with no arguments uses the last commit's message instead.

What it does (`apps/mobile/scripts/release-ota.sh`):

1. Stops unless `apps/mobile/.env.local` exists (a link to the real settings,
   kept outside the repository) and sets `EXPO_PUBLIC_SENTRY_DSN` and
   `SENTRY_AUTH_TOKEN`, then loads it into the shell, so its `EXPO_PUBLIC_*`
   values are bundled.
2. Publishes:
   `pnpm dlx eas-cli@20.3.0 update --channel production --environment production --non-interactive`
   with your `-m "..."`, or with `--auto` (the last commit's message) when you
   gave no arguments.
   - `--channel production` publishes on the branch the `production` channel
     points to (the `production` branch), the channel every store build
     listens to (`eas.json`).
   - `--environment production` is required; see the next section.
   - No `--platform` flag: with this Expo SDK, eas-cli 20.3.0 exports iOS and
     Android (never web), so one update group carries both.
3. Uploads that update's source maps from `dist/_expo/static/js` to Sentry
   (`@sentry/cli sourcemaps upload`). It needs `SENTRY_ORG` and
   `SENTRY_PROJECT` as well, and checks them only here, after the publish. The
   maps exist only in this checkout's `dist/`, right after the publish;
   without them every crash from the update is unreadable.

It ends with `OTA published + source maps uploaded.` If it stops after the
publish but before the upload, the update is already live: run only the
script's last command (the Sentry upload) with the same settings, before
anything changes `dist/`. Do not publish again to get the maps.

Never publish with a hand-typed `eas update` or the older
`eas update --branch production`: they skip the checks above and the source
map upload, and without `--environment production` the publish either stops or
bundles without the production environment.

### `--environment production` is required

- eas-cli 20.3.0 requires `--environment` for projects on Expo SDK 55 or newer
  (this app is on SDK 57). Without it a non-interactive `eas update` stops with
  "The `--environment` flag must be set when running in `--non-interactive`
  mode." (first hit 2026-08-14, fixed in the script by PR #133). With `--auto`
  it does not stop: it skips that check and bundles without the production
  environment, which is why the script passes the flag on both paths.
- It names the EAS environment whose server-side variables are added to the
  bundling environment: `production`, the one the store builds use
  (`eas.json`, `build.production.environment`), so an update gets the same
  server-side variables as the binary it lands on. Those variables win over
  the same names in your shell, and eas-cli then turns off Expo's own `.env`
  file loading for the export, which is why the script loads `.env.local` into
  the shell first. (`eas update` never reads a build profile's inline `env`
  in `eas.json`; `.env.local` supplies those values.)
- An update published under another environment, or none, is how a value such
  as the API base can change under a shipped app.

## Before you publish

1. The change is JavaScript and assets only (the native-safety rule below).
2. The main checkout, on `main`, after `git pull --ff-only`, with
   `git status --short` printing nothing. `eas update` does not require a
   commit here (`eas.json` sets no `requireCommit`): it bundles the working
   tree as it is, uncommitted edits and untracked files included. A worktree,
   an old branch or a dirty tree would publish whatever it holds to every
   phone on the channel.
3. `pnpm install --frozen-lockfile` in that checkout whenever a merged PR
   changed `pnpm-lock.yaml` or `patches/`. Metro bundles whatever
   `node_modules` holds: on 2026-09-25 the first export after a lockfile
   change still bundled the old, unpatched packages.
4. A fresh terminal, with no lab, local or other project settings loaded. An
   `EXPO_PUBLIC_*` variable that `.env.local` does not set is bundled as the
   shell holds it.
5. Record the rollback anchor, the group phones run now (the first group
   listed):

   ```bash
   cd apps/mobile
   pnpm dlx eas-cli@20.3.0 update:list --branch production --runtime-version 1.4.0 --json --non-interactive
   ```

   Note its group id, message and creation time, and its iOS launch hash (as
   in "Verify after publishing", step 2). `1.4.0` stands for `version` in
   `apps/mobile/app.config.ts`, the runtime version this publish is for.

## Verify after publishing

1. `update:list` as above: the new group is first, for the expected runtime
   version, with iOS and Android.
2. What phones are served. Read the manifest the `production` channel serves
   for this runtime (read only, no credentials):

   ```bash
   curl -s https://u.expo.dev/68235e4f-fd32-4c8c-a2b5-9f9df663e6cc \
     -H 'expo-platform: ios' -H 'expo-runtime-version: 1.4.0' \
     -H 'expo-channel-name: production' -H 'expo-protocol-version: 1' \
     -H 'accept: multipart/mixed'
   ```

   The first part of the answer is JSON: `id` is the iOS update's id and
   `launchAsset.hash` the bundle's SHA-256, base64url without padding. It must
   equal the local export's, from `apps/mobile`:

   ```bash
   openssl dgst -sha256 -binary dist/_expo/static/js/ios/entry-*.hbc | openssl base64 -A | tr '+/' '-_' | tr -d '='
   ```

3. The bundle names no lab or local host:

   ```bash
   grep -a -c -E '127\.0\.0\.1:[0-9]|localhost:(3000|5[0-9]{4})([^0-9]|$)' dist/_expo/static/js/ios/entry-*.hbc
   ```

   must print `0`. (A release bundle does contain library defaults such as
   `localhost:8081` and `localhost:30000`; this pattern leaves those out. It
   printed `0` on three published production bundles from October 2026 and
   caught `localhost:3000` in a bundle exported for a local walk.)

4. On a phone: a real phone signed in to Demo Co. A simulator build has no
   channel and never receives production updates (to prove update behaviour
   on a simulator, use the test channel below). Quit the app completely and
   open it: it opens once, on the version it has, and expo-updates downloads
   the update in the background. A few seconds later it says "Update ready"
   (`apps/mobile/src/lib/ota-update-prompt.ts`). Restart now shows one dark
   restart screen and one launch animation, and Settings then shows the new
   `#id`. After Later, the next open from closed applies the update with one
   launch screen. The message waits while the person scans, counts, types,
   or has a sheet or a draft open. A phone still on a bundle from before this
   message existed (October 2026) restarts by itself once, the old way, when
   it loads the update.
5. `pnpm dlx eas-cli@20.3.0 update:insights <group id> --non-interactive`
   shows launches and crashes as phones pick it up.

## Roll back

A rollback republishes an update group that is already on EAS. Nothing is
bundled again, so phones get exactly the bundle and assets that group carried,
and no `--environment` is involved. Run it from `apps/mobile` in the main
checkout (eas-cli reads the project from `app.config.ts`). Never roll back by
running `eas update` or `pnpm release:ota` from an older checkout: that
bundles again, with whatever code, packages and environment that checkout and
shell hold.

**The bad group is still the latest on its branch for its runtime version:**

```bash
pnpm dlx eas-cli@20.3.0 update:rollback <bad group id> \
  --message "Roll back <bad group id>: <why>" --non-interactive
```

It republishes the group published before it; when there is none, it
publishes a roll back to the embedded update (the bundle built into the store
binary). The group id is required in non-interactive mode; without
`--message` the message is `Roll back to "<previous message>" (group: <id>)`.

**Any known-good group** (the anchor you recorded, or once a later group has
been published):

```bash
pnpm dlx eas-cli@20.3.0 update:republish --group <good group id> \
  --message "Republish <good group id>: <why>" --non-interactive
```

It republishes that group's iOS and Android updates as a new group at the head
of the same branch, for the same runtime version. `--message` is required in
non-interactive mode.

Then verify as after a publish: `update:list` shows the republished group
first, and the manifest's `launchAsset.hash` equals the anchor's recorded
hash. Phones download the republished group at their next open from closed,
or at a return to the app at least 30 minutes after the last check. They then
offer it with "Update ready", and it applies at Restart now or at the next
open from closed. Before going back across a change to how the app stores unsent
work (the offline queue and outbox code in `apps/mobile/src/lib`), check that
the older bundle reads what the newer one wrote.

## Channels, branches and runtime versions

- `eas.json`: the `production` build profile sets `channel: production` and
  `environment: production`; `preview` builds listen on `preview`. Simulator
  and development builds have no channel. The one exception is the
  `simulator-ota-test` profile: a simulator build that listens on the
  `ota-test` channel, only for the simulator proof below. Never add a channel
  to the plain `simulator` profile, or branch simulator builds would receive
  updates.
- The `production` channel points at the `production` branch;
  `pnpm release:ota` publishes there through `--channel production`.
- `runtimeVersion.policy` is `appVersion` (`app.config.ts`): an update reaches
  only installed builds whose app version equals `version` when it was
  published (1.4.0 now). Phones on an older app version keep receiving their
  own version's latest update, so a fix for them must be published from a
  checkout whose `version` matches theirs.

## Prove phone-update behaviour on a simulator (test channel)

How the app downloads, offers and applies an update (the "Update ready"
message) can be proved on a simulator without touching production. Never
production:

- Build with the `simulator-ota-test` profile: the `simulator` profile on the
  `ota-test` channel (and its `ota-test` branch). No store or TestFlight build.
- Publish every test update with `scripts/release-ota-test.sh`, from
  `apps/mobile` in the worktree under test:

  ```bash
  bash scripts/release-ota-test.sh ota-test --message 'Proof U1'
  ```

  It refuses an empty channel, `production` and `preview`, loads
  `.env.local` into the shell without printing it (with
  `--environment production`, eas-cli turns off Expo's own `.env` loading),
  publishes iOS only, runs the host check from "Verify after publishing"
  (step 3) on the bundle, and uploads no source maps. If the host check
  fails, only the test channel received the update: publish a good one there.

- Simulators never send Sentry events. Sign in to Demo Co only and change no
  data.

Steps:

1. Create the channel once:
   `pnpm dlx eas-cli@20.3.0 channel:create ota-test --non-interactive`
   (`channel:view ota-test --non-interactive` shows it when it exists).
2. Build: `pnpm dlx eas-cli@20.3.0 build --platform ios --profile simulator-ota-test --non-interactive --no-wait --json`,
   wait for `build:view <id> --json` to say `FINISHED`, download the
   artifact and unpack the `.app`.
3. Check the binary: `plutil -p <app>/Expo.plist` shows
   `EXUpdatesRequestHeaders` with `expo-channel-name` `ota-test`,
   `EXUpdatesRuntimeVersion` `1.4.0`, `EXUpdatesCheckOnLaunch` `ALWAYS` and
   `EXUpdatesLaunchWaitMs` `0`, and `strings <app>/main.jsbundle` contains
   the message "An update for StockPilot is ready. The app will restart to
   finish installing it."
4. Install it on a new simulator (dark appearance, so a white frame stands
   out). Read the expo-updates log in the app's data container
   (`Library/Application Support/dev.expo.modules.core.logging.expo-updates.txt`)
   and its database (`Library/Application Support/.expo-internal/expo-v11.db`,
   read only). Every check must find the lines it expects: a count of 0
   passes only when the same check also found its positive lines.
5. The phases, each with a screen recording:
   - Nothing published yet: the launch logs `startStartup`, `check`,
     `checkCompleteUnavailable`, `endStartup`; no download, no message.
   - Publish U1, then quit and open: one launch sequence and no white frame,
     then "Update ready"; the log shows the download with
     `isUpdatePending: true` and no `restart`.
   - Restart now: exactly one `restart`, one dark restart screen, one launch
     animation, the footer shows U1, and no message after it.
   - Publish U2, then go to the home screen and back: the return checks and
     downloads U2, and the message shows; Later; moving between tabs for a
     minute brings no message; the next return shows it again with no new
     check (the 30-minute gap).
   - The message waits for a scan, the new-count screen, a sheet, an alert
     (never confirm it), the software keyboard, a tour, a photo picker
     (cancel it) and a focused field with no keyboard, and shows within a few
     seconds once each is done.
   - At the largest Dynamic Type size the message is complete and both
     buttons can be reached; VoiceOver reads the title, the message, Later and
     Restart now.
   - Later, then quit and open: one launch sequence, no `restart`, the
     footer shows U2, and no message.
   - On an iPad, in the first session: the message is centred, in both
     orientations, and tapping Restart now restarts once. With a hardware
     keyboard, Escape chooses Later. On iOS 27 Return does not choose Restart
     now, although Restart now is the alert's preferred action: that is how
     iOS's own alert behaves, not a failure.
6. Clean up: delete the test simulators. Keep the profile and the channel for
   the next proof.

A local release build is not a substitute: it has no channel header, bundles
with local settings, and Xcode 27's iOS SDK crashes an SDK 57 app at launch.

## The native-safety rule (build #23 baseline)

An OTA can ONLY safely ship changes that are pure JS + bundled assets. The
runtime version is pinned by `app.config.ts` (`runtimeVersion.policy:
'appVersion'`), so an OTA is only delivered to installed builds whose runtime
matches. That keeps a JS bundle from loading against a native binary it wasn't
built for — but it does NOT stop YOU from shipping an OTA that _calls_ a native
API the installed build doesn't have.

If a change touches ANY of the following, it needs a NEW native build
(`pnpm release:ios`, see mobile-release.md), not an OTA:

- a new/removed/upgraded native module or Expo config plugin (`app.config.ts`
  `plugins`, or any dependency with native code)
- `app.config.ts` native fields: `ios.infoPlist`, entitlements, permissions,
  `runtimeVersion`, bundle identifier
- anything that changes the native runtime contract

When in doubt, build. A bad OTA reaches every device on the channel instantly.

### Bump the app version when a native build CHANGES the module set

The rule above covers "don't OTA a native API the build lacks." The **inverse**
bit us 2026-06-18 and is just as fatal: a NEW native build that _removes_ (or
adds/upgrades) a module while keeping the same `version` inherits the OLD
runtime's OTA history. Because `runtimeVersion.policy: 'appVersion'`, builds
#31/#32 (`expo-location`/`expo-task-manager` removed, still `version: '1.0.0'`)
shared runtime `1.0.0` with every prior `1.0.0` OTA — including bundles
published BEFORE the removal that `import` `expo-location`. expo-updates served
the latest `1.0.0` OTA (which touched the now-missing native module) to the new
binary → **crash on launch, every time** (the embedded bundle is fine; the
stale OTA overrides it on the second+ launch).

**Rule:** when a production build ADDS, REMOVES, or upgrades a native module /
config plugin / permission, **bump `version` in `app.config.ts` in the same
change** (e.g. `1.0.0 → 1.0.1`). The new binary then gets a fresh
`runtimeVersion` with no prior (incompatible) OTA history — it loads its own
embedded bundle and only ever receives OTAs published from matching code.

**Recovery if you already shipped the native build WITHOUT bumping** (as on
2026-06-18): publish a fresh OTA from the post-change code (`pnpm release:ota`
from an up-to-date, clean `main`) so the latest update for that runtime is
compatible again; it supersedes the stale one. Already-installed copies that
cached the bad bundle must **delete + reinstall** (a fast crash can kill the
process before the corrected OTA finishes downloading in the background).

Build #23 is the known-good native baseline (see MEMORY:
`reference_mobile_items_perf_solved`). Do NOT reintroduce FlashList 1.7 or
Supabase server-side image transforms via OTA — both crashed builds previously.

## Gotchas we have actually hit

1. **The API base URL.** `app.config.ts` takes `extra.apiUrl` from
   `EXPO_PUBLIC_API_URL` at bundle time and falls back to
   `http://localhost:3000` when it is unset. On 2026-06-04 an `eas update` run
   without it baked localhost into the bundle and broke every API call on
   phones. `apps/mobile/src/lib/api.ts` now replaces a missing or localhost
   value with `https://stockpilotusa.com` in a release bundle, and
   `pnpm release:ota` loads the value with the rest of `.env.local`; the
   host check in "Verify after publishing" catches a lab or local host.

2. **`query-string@7.1.3` must stay a direct dependency of `apps/mobile`.**
   `expo-router` resolves `query-string` at runtime, and under pnpm's strict
   (non-hoisted) `node_modules` layout it is NOT visible transitively — it must
   be a direct entry in `apps/mobile/package.json` (it currently is, pinned to
   `7.1.3`). Removing it breaks routing on device. Do not "clean it up".

3. **Platforms.** Older eas-cli versions bundled web for `--platform all` and
   failed (the app has no `react-native-web`), hence the old advice to always
   pass `--platform ios`. eas-cli 20.3.0 exports iOS and Android only for
   `all` with this SDK, and the script publishes both.

4. **Stale `node_modules`** in the main checkout after a lockfile change
   (2026-09-25): see "Before you publish", step 3.

## Build number / versioning note

Do NOT hand-edit `ios.buildNumber` in `app.config.ts`. `eas.json`'s `production`
profile sets `autoIncrement: true` with `cli.appVersionSource: 'remote'`, so EAS
manages the real build number remotely and bumps it on each production build. The
`buildNumber: '1'` literal is only a local/dev fallback; editing it has no effect
on store builds and only creates drift.
