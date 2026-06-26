# Mobile Sentry crash reporting — owner setup

Sentry is **wired but dormant** on branch `feat/sentry-crash-reporting` (commit
`bb2f3b81`). It does nothing until you create a Sentry project and set the
secrets below, then ship build **1.0.1**. It is a NATIVE change — it cannot be
delivered by an OTA `eas update`; it must go out in a new binary build.

## What's already done (in code)
- `@sentry/react-native@6.14.0` + the Expo config plugin (`app.config.ts`).
- `metro.config.js` → `getSentryExpoConfig` (symbolicated stack traces).
- `src/lib/sentry.ts` → `initSentry()` — **no-op until `EXPO_PUBLIC_SENTRY_DSN` is set**, and disabled in dev.
- `app/_layout.tsx` → `initSentry()` at launch + `Sentry.wrap(RootLayout)`.
- `src/components/error-boundary.tsx` → `Sentry.captureException` (React swallows render throws).
- Version bumped `1.0.0 → 1.0.1` so OTAs target runtime 1.0.1 and can never crash today's 1.0.0 build.

## Your steps
1. **Create a Sentry project** at https://sentry.io → New Project → platform **React Native**. Note the **DSN** (Project Settings → Client Keys).
2. **Create an auth token** for source-map upload: Sentry → Settings → Auth Tokens → new token with `project:releases` + `project:read` scope. Note the **org slug** and **project slug** (in the URL / settings).
3. **Set the EAS secrets** (run from `apps/mobile`, authenticated as branden615):
   ```bash
   eas secret:create --scope project --name EXPO_PUBLIC_SENTRY_DSN --value "https://<key>@o<org>.ingest.sentry.io/<project-id>"
   eas secret:create --scope project --name SENTRY_ORG          --value "<org-slug>"
   eas secret:create --scope project --name SENTRY_PROJECT      --value "<project-slug>"
   eas secret:create --scope project --name SENTRY_AUTH_TOKEN   --value "<auth-token>"
   ```
   - `EXPO_PUBLIC_SENTRY_DSN` is inlined into the JS bundle at build time (enables reporting at runtime).
   - The other three are build-time only (source-map upload). If you skip them, crashes still report — stack traces are just minified.
4. **Build + ship 1.0.1**: merge `feat/sentry-crash-reporting` to `main`, then `pnpm release:ios` (builds 1.0.1, auto-submits). Do the same for Android when ready.
5. After 1.0.1 is live and a device updates, force a test crash (or trigger any error) and confirm it appears in the Sentry dashboard.

## Important: OTAs after this lands
Once `main` is on version 1.0.1, `eas update --channel production` publishes to
runtime **1.0.1** only — it will NOT reach 1.0.0 users. Until everyone upgrades
to 1.0.1, a fix that must reach 1.0.0 users has to be published against runtime
1.0.0 separately (`eas update --branch <1.0.0-branch>` from 1.0.0 code). Normal
multi-version OTA management; just be aware during the transition.
