# Mobile Native Release (EAS Build → TestFlight) Runbook

How to ship a new **native** iOS build to TestFlight. For JS-only changes, use an
OTA instead — see [mobile-ota.md](./mobile-ota.md) (and its native-safety rule
for deciding which one you need).

## TL;DR — fire-and-forget release

```bash
cd apps/mobile
pnpm release:ios
```

That's it. The script runs:

```
eas build --platform ios --profile production --auto-submit --no-wait --non-interactive
```

and exits in **~1–2 minutes**, as soon as the project is uploaded and the build
**and the TestFlight submission are both scheduled on EAS's servers**. You can
close the laptop; EAS builds (~3.5 h queue+build at current concurrency), then
submits to App Store Connect automatically, and Apple emails when processing
finishes (~5–10 min after submit).

Track progress: <https://expo.dev/accounts/branden615/projects/stockpilot/builds>

## Why `--no-wait` (lesson from build 29, 2026-06-10)

`--auto-submit` schedules the submission server-side **during the first minute**
(right after upload — the log prints "✔ Scheduled iOS submission" before the
build even starts). Without `--no-wait`, the CLI then blocks for the full
multi-hour build "waiting" — and if that local process dies (sleep, kill,
crash), nothing breaks *except* your visibility… **unless it dies during the
initial upload window**, in which case nothing was scheduled at all. Build 29's
submit was lost exactly this way: the wrapper process was killed early, the
build itself completed on EAS, but no submission existed — it sat unsubmitted
for hours until we ran `eas submit --id <build-id>` manually.

`--no-wait` shrinks the local-process dependency to the ~1-minute upload. After
the command returns, **everything is server-side**.

## If a build finished but never reached TestFlight

Submit the existing artifact — do NOT rebuild:

```bash
cd apps/mobile
npx eas-cli@latest build:list --platform ios --limit 3   # grab the Build ID
npx eas-cli@latest submit --platform ios --profile production --id <BUILD_ID> --non-interactive
```

Submission credentials (ASC API key) live at `secrets/AuthKey_9SA2GBH9YV.p8`
(repo root, gitignored) and are referenced from `eas.json`'s `submit.production`.

## The Xcode image pin (do not float!)

`eas.json` pins both iOS profiles to:

```json
"image": "macos-sequoia-15.5-xcode-16.4"
```

**History:** the profiles used to say `"image": "latest"`. On 2026-06-10 EAS
advanced `latest` from Xcode 16.4 to Xcode 26.4, whose stricter Clang rejects
`fmt 11.0.2`'s consteval format strings (`fmt` is pinned by RN 0.79.6 via
RCT-Folly) — build 28 failed with
`call to consteval function 'fmt::basic_format_string<…>' is not a constant expression`
with **zero code changes** on our side. Pinning to the SDK 53 default
(Xcode 16.4) fixed it (build 29 green).

**Rule:** keep the image pinned to the Expo-SDK-default Xcode. Only move the pin
deliberately when upgrading the Expo SDK, and expect to revalidate the native
build when you do.

## Versioning

`autoIncrement: true` + `cli.appVersionSource: 'remote'` — EAS owns the build
number and bumps it per production build. Never hand-edit `ios.buildNumber` in
`app.config.ts` (see the note in mobile-ota.md).

## Android

`pnpm release:android` does the same fire-and-forget flow to the Play Store
internal track (service account key at `secrets/play-store-service-account.json`).
iOS is the primary, regularly-exercised path; treat the first Android release as
needing a babysit.
