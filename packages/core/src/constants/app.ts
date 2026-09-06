/**
 * App identity constants shared through `@stockpilot/core` (re-exported by
 * `constants/index.ts` via `export * from './app'`, so everything here is
 * public API of the package).
 *
 * DELIBERATELY SMALL — SP-121 (2026-09-06). This file used to also export
 * APP_TAGLINE, APP_DOMAIN ('stockpilot.app'), SUPPORT_EMAIL
 * ('support@stockpilot.app') and FROM_EMAIL_DEFAULT
 * ('StockPilot <hello@stockpilot.app>'). Not one of them had a single
 * importer anywhere (apps/web, apps/mobile, packages, scripts, docs,
 * supabase), and all three addresses were on a domain the product does not
 * send from: the live values are
 *   - apps/web/src/lib/env.ts   RESEND_FROM_EMAIL default
 *                               'StockPilot <hello@stockpilotusa.com>'
 *   - apps/web/src/lib/site.ts  SUPPORT_EMAIL / PRIVACY_EMAIL / SITE_URL,
 *                               all on stockpilotusa.com
 *
 * The danger was not the dead code, it was the autocomplete: someone wiring a
 * new sender would import FROM_EMAIL_DEFAULT from core and ship mail From: a
 * domain with no DKIM/SPF record. That fails silently — the send succeeds and
 * the mail is spam-foldered — so no test, typecheck or build would catch it.
 * They were deleted rather than corrected to stockpilotusa.com because a
 * second copy of the sending identity is exactly how the drift started.
 *
 * If a sending/support address is ever genuinely needed in core, move the
 * definition here and delete the web copy — do not add a duplicate.
 * `app.test.ts` fails on any address re-added on the dead domain.
 */

/** Consumed by apps/web/src/app/layout.tsx for the site title/metadata. */
export const APP_NAME = 'StockPilot' as const;
/** Consumed by apps/web/src/app/layout.tsx for the meta/OG/Twitter description. */
export const APP_DESCRIPTION = "Know exactly what you have, where it is, who moved it, and when you need more." as const;
