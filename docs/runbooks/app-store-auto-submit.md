# App Store auto-submit-for-review

Native iOS builds (a new native module or a version bump) require an App Store
review. `pnpm release:ios` (in `apps/mobile`) already **uploads** the build to
App Store Connect via `--auto-submit`. The only manual step left is clicking
**"Submit for Review"** on the new version — `pnpm submit:review` does that via
the App Store Connect API.

## One-time setup

1. Get your **Issuer ID**: App Store Connect → Users and Access → Integrations →
   App Store Connect API → **Issuer ID** (a UUID).
2. The API key (`secrets/AuthKey_9SA2GBH9YV.p8`, Key ID `9SA2GBH9YV`) is the same
   one EAS uses — already present.

## Submitting a native build

After `pnpm release:ios` finishes uploading (≈10 min) and the version is created
+ metadata filled in App Store Connect (the version shows **"Prepare for
Submission"**, build attached):

```bash
cd apps/mobile
ASC_ISSUER_ID=<your-issuer-id> pnpm submit:review
```

It finds the latest submittable version and submits it for review. Optional env
overrides: `ASC_KEY_ID`, `ASC_KEY_PATH`, `ASC_APP_ID`, `ASC_PLATFORM`.

## Make it fully hands-off

In App Store Connect, set the version to **"Automatically release this
version"** — then once Apple approves, it goes live to users with no further
action.

## What can't be automated

Apple's **review itself** is always required for a public App Store release
(~24–48h) — no setting skips it. The way to avoid it entirely is to ship
JS-only changes as **OTA updates** (`eas update --channel production`), which
need no build and no review. Reserve native builds for actual native changes.
