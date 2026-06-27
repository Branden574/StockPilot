/**
 * Client-safe environment access. Holds ONLY `NEXT_PUBLIC_*` values, which Next
 * inlines into the browser bundle at build time.
 *
 * This is deliberately SEPARATE from `lib/env.ts`: that module is `server-only`
 * (it parses real secrets like SUPABASE_SERVICE_ROLE_KEY / STRIPE_SECRET_KEY),
 * so a stray client import of it fails the build. Client components import the
 * NEXT_PUBLIC_* values from HERE instead.
 *
 * DO NOT add a server secret to this file — anything here ships in every
 * visitor's JavaScript bundle.
 *
 * Each `process.env.NEXT_PUBLIC_*` access is a LITERAL so Next's static
 * replacement inlines it (a dynamic `process.env[name]` would not be inlined).
 */

const isDev = process.env.NODE_ENV !== 'production';

// Dev fallbacks matching `supabase start` (mirrors lib/env.ts's DEV_DEFAULTS).
const DEV_SUPABASE_URL = 'http://127.0.0.1:54321';
const DEV_SUPABASE_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

function required(value: string | undefined, devFallback: string, name: string): string {
  const v = (value ?? '').trim();
  if (v) return v;
  if (isDev) return devFallback;
  // In prod a missing NEXT_PUBLIC_* is a deploy/config error. Surface it without
  // hard-crashing the bundle (matches lib/env.ts's non-fatal client posture).
  console.error(`[env.client] Missing ${name}`);
  return '';
}

export const env = {
  NEXT_PUBLIC_APP_URL: (process.env.NEXT_PUBLIC_APP_URL ?? '').trim(),
  NEXT_PUBLIC_SITE_NAME: (process.env.NEXT_PUBLIC_SITE_NAME ?? 'StockPilot').trim() || 'StockPilot',
  NEXT_PUBLIC_SUPABASE_URL: required(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    DEV_SUPABASE_URL,
    'NEXT_PUBLIC_SUPABASE_URL',
  ),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: required(
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    DEV_SUPABASE_ANON,
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  ),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: (process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '').trim(),
  NEXT_PUBLIC_POSTHOG_KEY: (process.env.NEXT_PUBLIC_POSTHOG_KEY ?? '').trim(),
  NEXT_PUBLIC_POSTHOG_HOST:
    (process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com').trim() ||
    'https://us.i.posthog.com',
} as const;
