# Mobile OTA (EAS Update) Runbook

How to ship a JavaScript-only update to the StockPilot iOS app without a new
TestFlight/App Store build.

## TL;DR

```bash
cd apps/mobile
EXPO_PUBLIC_API_URL=https://stockpilotusa.com \
  npx eas-cli@latest update --branch production --platform ios --message "what changed"
```

> **⚠️ ALWAYS set `EXPO_PUBLIC_API_URL` when publishing an OTA.** Unlike `eas
> build` (which reads `env` from the `eas.json` build profile), `eas update`
> bundles with YOUR shell's env. If it's unset, `app.config.ts` defaults
> `extra.apiUrl` to `http://localhost:3000` and the bundle bakes localhost as the
> API base — breaking EVERY API call (and the scan→`/orders/sign` URL) on prod
> devices (`ERR_CONNECTION_FAILED` to `localhost:3000`). This bit us 2026-06-04.
> `apps/mobile/src/lib/api.ts` now has a release-time guard (localhost → prod
> fallback) as a safety net, but still set the env explicitly.

The app auto-reloads on next launch (the OTA is fetched at startup). No store
review, no native rebuild — but ONLY for JS/asset changes (see the native-safety
rule below).

`eas-cli` is now a devDependency (`apps/mobile/package.json`), so `pnpm exec
eas-cli ...` works too. We still document `npx eas-cli@latest` because the OTA
protocol occasionally requires the newest CLI; pin the devDep for reproducible
local installs but don't be afraid to run `@latest` for the actual publish.

## Channels

`eas.json` defines two channels: `preview` (internal distribution) and
`production` (the channel TestFlight/App Store builds subscribe to). OTAs for the
live beta go to `--branch production`.

## The native-safety rule (build #23 baseline)

An OTA can ONLY safely ship changes that are pure JS + bundled assets. The
runtime version is pinned by `app.config.ts` (`runtimeVersion.policy:
'appVersion'`), so an OTA is only delivered to installed builds whose runtime
matches. That keeps a JS bundle from loading against a native binary it wasn't
built for — but it does NOT stop YOU from shipping an OTA that *calls* a native
API the installed build doesn't have.

If a change touches ANY of the following, it needs a NEW native build (`eas build
--profile production`), not an OTA:

- a new/removed/upgraded native module or Expo config plugin (`app.config.ts`
  `plugins`, or any dependency with native code)
- `app.config.ts` native fields: `ios.infoPlist`, entitlements, permissions,
  `runtimeVersion`, bundle identifier
- anything that changes the native runtime contract

When in doubt, build. A bad OTA reaches every device on the channel instantly.

### ⚠️ Bump the app version when a native build CHANGES the module set

The rule above covers "don't OTA a native API the build lacks." The **inverse**
bit us 2026-06-18 and is just as fatal: a NEW native build that *removes* (or
adds/upgrades) a module while keeping the same `version` inherits the OLD
runtime's OTA history. Because `runtimeVersion.policy: 'appVersion'`, builds #31/#32
(`expo-location`/`expo-task-manager` removed, still `version: '1.0.0'`) shared
runtime `1.0.0` with every prior `1.0.0` OTA — including bundles published BEFORE
the removal that `import` `expo-location`. expo-updates served the latest `1.0.0`
OTA (which touched the now-missing native module) to the new binary → **crash on
launch, every time** (the embedded bundle is fine; the stale OTA overrides it on
the second+ launch).

**Rule:** when a production build ADDS, REMOVES, or upgrades a native module /
config plugin / permission, **bump `version` in `app.config.ts` in the same
change** (e.g. `1.0.0 → 1.0.1`). The new binary then gets a fresh
`runtimeVersion` with no prior (incompatible) OTA history — it loads its own
embedded bundle and only ever receives OTAs published from matching code.

**Recovery if you already shipped the native build WITHOUT bumping** (as on
2026-06-18): publish a fresh OTA from the post-change code so the latest update
for that runtime is compatible again — `eas update --branch production` from the
new code supersedes the stale one. Already-installed copies that cached the bad
bundle must **delete + reinstall** (a fast crash can kill the process before the
corrected OTA finishes downloading in the background).

Build #23 is the known-good native baseline (see MEMORY:
`reference_mobile_items_perf_solved`). Do NOT reintroduce FlashList 1.7 or
Supabase server-side image transforms via OTA — both crashed builds previously.

## Gotchas we have actually hit

1. **`query-string@7.1.3` must stay a direct dependency of `apps/mobile`.**
   `expo-router` resolves `query-string` at runtime, and under pnpm's strict
   (non-hoisted) `node_modules` layout it is NOT visible transitively — it must
   be a direct entry in `apps/mobile/package.json` (it currently is, pinned to
   `7.1.3`). Removing it breaks routing on device. Do not "clean it up".

2. **`--platform all` fails — use `--platform ios`.** `all` makes EAS bundle for
   web too, and the app has no `react-native-web`, so the web bundle errors out
   and aborts the whole update. We ship iOS only; always pass `--platform ios`.

## Verify after publishing

```bash
cd apps/mobile
npx eas-cli@latest update:list --branch production
```

Confirm the new update is at the head of the `production` branch, then cold-start
the app on a device to confirm it picks up the bundle (expo-updates fetches on
launch). If something is wrong, publish a corrected OTA — it supersedes the bad
one on the next launch. There is no "rollback" beyond shipping a newer update
(or `eas update:republish` of a known-good prior update).

## Build number / versioning note

Do NOT hand-edit `ios.buildNumber` in `app.config.ts`. `eas.json`'s `production`
profile sets `autoIncrement: true` with `cli.appVersionSource: 'remote'`, so EAS
manages the real build number remotely and bumps it on each production build. The
`buildNumber: '1'` literal is only a local/dev fallback; editing it has no effect
on store builds and only creates drift.
