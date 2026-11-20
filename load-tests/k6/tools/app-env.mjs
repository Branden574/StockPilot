// What the app under test must NOT pick up from anywhere else.
//
// Next.js fills every variable that is not already in the environment from
// the checkout's apps/web/.env* files (@next/env processEnv: a file value is
// used only when the variable is undefined). An EMPTY value counts as set, so
// writing each of these as `NAME=` in the app's env file keeps a key from such
// a file out of the build and the server: no email through Resend, no AI or
// book lookups, no payments, analytics, maps, accounting, error webhooks or
// platform hooks from a load test.
//
// Empty keys alone do NOT stop services that need no key (Expo push, Google
// Books without a key, UPCitemdb, the PostHog ingest proxy, integrations whose
// credentials are stored in the database). run-scale.mjs starts the app under
// tools/outbound-guard.cjs, which refuses every connection to anything but
// this machine; that is what stops those.
//
// apps/web/src/test/load-tests-safety.guard.test.ts reads every environment
// variable the app's sources name and fails when one that looks like an
// outside-service key or address is missing here.

/** Outside-service keys, secrets and addresses: written empty. */
export const OUTSIDE_SERVICE_ENV = Object.freeze([
  // Email
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  // AI and lookups
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_BOOKS_API_KEY',
  // Payments
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  'STRIPE_PRICE_TO_PLAN',
  'NEXT_PUBLIC_STRIPE_PRICE_PRO_MONTHLY',
  'NEXT_PUBLIC_STRIPE_PRICE_PRO_YEARLY',
  'NEXT_PUBLIC_STRIPE_PRICE_BUSINESS_MONTHLY',
  'NEXT_PUBLIC_STRIPE_PRICE_BUSINESS_YEARLY',
  // Analytics, maps, error reporting
  'NEXT_PUBLIC_POSTHOG_KEY',
  'NEXT_PUBLIC_MAPTILER_KEY',
  'ERROR_WEBHOOK_URL',
  'SENTRY_DSN',
  'NEXT_PUBLIC_SENTRY_DSN',
  'SENTRY_AUTH_TOKEN',
  // Accounting
  'QBO_CLIENT_ID',
  'QBO_CLIENT_SECRET',
  'SAGE_INTACCT_CLIENT_ID',
  'SAGE_INTACCT_CLIENT_SECRET',
  // Push, rate-limit store, hosting
  'EXPO_ACCESS_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'VERCEL',
  'VERCEL_ENV',
  'VERCEL_URL',
  'VERCEL_OIDC_TOKEN',
  'VERCEL_DEPLOYMENT_ID',
  'VERCEL_GIT_COMMIT_SHA',
  // The app's own secrets and platform settings
  'CRON_SECRET',
  'BACKFILL_ADMIN_SECRET',
  'UNSUBSCRIBE_SECRET',
  'STOCKPILOT_PLATFORM_ADMIN_EMAILS',
]);

/**
 * Behaviour switches a checkout's env file could set and that change what a
 * run measures: written empty so every build runs the defaults.
 */
export const PINNED_DEFAULT_ENV = Object.freeze([
  'REQUEST_CONTEXT_RPC',
  'DEBUG_CONTEXT_TIMING',
  'ORDERS_PHONE_STOREFRONT',
  'ORDER_ITEMS_MANAGE_ORGS',
  'ES_LATENT_ORDER_EMAILS',
  'RETURNS_EXCHANGE_CREATE',
]);

/**
 * NEXT_PUBLIC_LIQUID_GLASS changes the pages being measured (it is inlined at
 * build time), so every load-test build pins it: local-env.mjs writes it
 * (default opt-in, the value the web app was released with on 2026-11-11;
 * --liquid-glass changes it) and the report states it.
 */
export const LIQUID_GLASS_VALUES = Object.freeze(['off', 'opt-in', 'default']);
export const DEFAULT_LIQUID_GLASS = 'opt-in';

/**
 * Names that look like outside-service settings but are not keys or
 * addresses, and must stay unset (an empty value would fail the app's env
 * schema or replace a default): the reason is the value.
 */
export const LEFT_UNSET_ENV = Object.freeze({
  AI_PROVIDER: "enum: '' fails the schema; with no AI key nothing is called",
  QBO_ENV: "enum with default 'sandbox': '' fails the schema",
  RESEND_FROM_EMAIL: 'a sender name; nothing is sent without RESEND_API_KEY',
  NEXT_PUBLIC_POSTHOG_HOST: 'an address used only with NEXT_PUBLIC_POSTHOG_KEY, which is empty',
  ANTHROPIC_MODEL: 'a model name; nothing is called without ANTHROPIC_API_KEY',
  ANTHROPIC_PO_SCAN_MODEL: 'a model name; nothing is called without ANTHROPIC_API_KEY',
  ANTHROPIC_SIZE_SCAN_MODEL: 'a model name; nothing is called without ANTHROPIC_API_KEY',
  GEMINI_MODEL: 'a model name; nothing is called without GEMINI_API_KEY',
});

/** Env files the app would read from a checkout: none may exist where it is built or served. */
export function isAppEnvFile(name) {
  return name.startsWith('.env') && !name.endsWith('.example');
}
