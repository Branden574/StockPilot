/**
 * Centralized env access. Strict in production, forgiving in development —
 * dev never throws on missing values; instead it logs a warning and falls
 * back to placeholders so the marketing pages render without a Supabase
 * project running.
 *
 * SERVER-ONLY: this module parses real secrets (SUPABASE_SERVICE_ROLE_KEY,
 * STRIPE_SECRET_KEY, GEMINI_API_KEY, …), so the `server-only` guard makes any
 * client-bundle import a BUILD ERROR. Client components read NEXT_PUBLIC_*
 * values from `lib/env.client.ts` instead.
 */
import 'server-only';

import { z } from 'zod';

const optionalSecret = z.string().optional().default('');

/**
 * Trim + drop trailing slash. Vercel's env-var dashboard sometimes
 * preserves trailing newlines/whitespace when you paste, and a trailing
 * \n in NEXT_PUBLIC_APP_URL turns invite URLs into broken multi-line
 * strings ("https://...vercel.app\n/i/<token>"). Belt-and-suspenders:
 * this normalizer runs at zod-validation time so every consumer of
 * env.NEXT_PUBLIC_APP_URL gets a clean value.
 */
const cleanUrl = (s: string) => s.trim().replace(/\/$/, '');

const urlField = z
  .string()
  .transform(cleanUrl)
  .pipe(z.string().url())
  .default('http://localhost:3000');

const supabaseUrlField = z.string().transform(cleanUrl).pipe(z.string().url());

const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NEXT_PUBLIC_APP_URL: urlField,
  NEXT_PUBLIC_SITE_NAME: z.string().transform((s) => s.trim()).default('StockPilot'),

  NEXT_PUBLIC_SUPABASE_URL: supabaseUrlField,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().transform((s) => s.trim()).pipe(z.string().min(1)),
  SUPABASE_SERVICE_ROLE_KEY: optionalSecret.transform((s) => s.trim()),

  STRIPE_SECRET_KEY: optionalSecret.transform((s) => s.trim()),
  STRIPE_WEBHOOK_SECRET: optionalSecret.transform((s) => s.trim()),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: optionalSecret.transform((s) => s.trim()),

  // PostHog product analytics (client-side). Both are optional and ship
  // INERT: when NEXT_PUBLIC_POSTHOG_KEY is empty the provider never calls
  // posthog.init() and every analytics helper early-returns — no network,
  // no errors. Set the key (and optionally an EU/self-hosted host) to light
  // it up without a code change. Host defaults to PostHog US cloud.
  NEXT_PUBLIC_POSTHOG_KEY: optionalSecret.transform((s) => s.trim()),
  NEXT_PUBLIC_POSTHOG_HOST: z
    .string()
    .optional()
    .default('https://us.i.posthog.com')
    .transform((s) => s.trim()),

  RESEND_API_KEY: optionalSecret.transform((s) => s.trim()),
  RESEND_FROM_EMAIL: z.string().transform((s) => s.trim()).default('StockPilot <hello@stockpilotusa.com>'),

  // Random shared secret. Vercel Cron sends `Authorization: Bearer <secret>`
  // to scheduled routes; we compare against this. Set the same value in
  // Vercel project env. Only required if Vercel Cron is enabled — local
  // dev and test runs ignore it.
  CRON_SECRET: optionalSecret.transform((s) => s.trim()),
  // Operator-invocable admin maintenance secret (Encrypted, Production).
  // Exists because SUPABASE_SERVICE_ROLE_KEY / CRON_SECRET are marked
  // Sensitive in Vercel (unpullable), so one-off backfills run as
  // secret-gated server routes instead of local scripts. Gates
  // /api/admin/backfill-item-thumbs and is accepted as an alternate
  // bearer on /api/cron/prewarm-orders-catalog.
  BACKFILL_ADMIN_SECRET: optionalSecret.transform((s) => s.trim()),
  // HMAC key for the PUBLIC unsubscribe links in order-request emails
  // (`/unsubscribe?e=<email>&t=<hmac>` — anonymous requesters can't
  // reach the login-gated notification prefs). Any long random string.
  // Optional but FAIL-CLOSED when unset: minting is skipped (emails
  // fall back to the in-app settings link) and token verification
  // always rejects, so nobody can unsubscribe arbitrary addresses
  // against an unkeyed HMAC. See lib/email/unsubscribe.ts.
  UNSUBSCRIBE_SECRET: optionalSecret.transform((s) => s.trim()),

  GEMINI_API_KEY: optionalSecret.transform((s) => s.trim()),
  // Model override. Different Google AI Studio keys get different free-
  // tier eligibility per model (we've seen 0 quota on gemini-2.0-flash
  // for keys that work fine on 1.5-flash). Override per environment
  // without a code deploy. Default lands on the most reliably-free model.
  GEMINI_MODEL: z
    .string()
    .optional()
    // gemini-1.5-flash was retired (404 on v1beta). gemini-2.0-flash
    // shows limit:0 free quota for some accounts. gemini-2.5-flash is
    // the current production model with its own free quota allotment.
    .default('gemini-2.5-flash')
    .transform((s) => s.trim()),

  // QuickBooks Online connector (integrations module). OAuth2 app
  // credentials from the Intuit developer portal. Only required when the
  // integrations module is enabled and an org connects QuickBooks; unset
  // in environments without the integration. QBO_ENV selects the Intuit
  // API host (sandbox vs production).
  QBO_CLIENT_ID: optionalSecret.transform((s) => s.trim()),
  QBO_CLIENT_SECRET: optionalSecret.transform((s) => s.trim()),
  QBO_ENV: z.enum(['sandbox', 'production']).default('sandbox'),

  // Sage Intacct connector (integrations module). OAuth2 app credentials
  // from the Sage Intacct developer portal — these only exist once the Web
  // Services developer license (sender ID, sold via a Sage account manager)
  // is purchased and an app is registered. Until then both stay unset and
  // the Integrations panel shows the connector as awaiting-credentials.
  // No env/host split: an Intacct sandbox is a separate COMPANY on the same
  // API host, not a separate base URL.
  SAGE_INTACCT_CLIENT_ID: optionalSecret.transform((s) => s.trim()),
  SAGE_INTACCT_CLIENT_SECRET: optionalSecret.transform((s) => s.trim()),

  // Comma-separated allowlist of email addresses that may access the
  // platform-admin surfaces (e.g. /dashboard/admin/orgs/new — provision
  // a new tenant org for a customer). Server-only check; not in the JWT,
  // not in any client bundle. Matched case-insensitively against the
  // signed-in user's email. Leave unset in environments where no user
  // should have platform-admin access.
  STOCKPILOT_PLATFORM_ADMIN_EMAILS: optionalSecret.transform((s) =>
    s
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean)
      .join(','),
  ),

  // Google Books API key (optional — keyless works at low volume; set to raise quota).
  GOOGLE_BOOKS_API_KEY: optionalSecret.transform((s) => s.trim()),
});

const clientSchema = z.object({
  NEXT_PUBLIC_APP_URL: urlField,
  NEXT_PUBLIC_SITE_NAME: z.string().transform((s) => s.trim()).default('StockPilot'),
  NEXT_PUBLIC_SUPABASE_URL: supabaseUrlField,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().transform((s) => s.trim()).pipe(z.string().min(1)),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().optional().default('').transform((s) => s.trim()),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional().default('').transform((s) => s.trim()),
  NEXT_PUBLIC_POSTHOG_HOST: z
    .string()
    .optional()
    .default('https://us.i.posthog.com')
    .transform((s) => s.trim()),
});

const isDev = process.env.NODE_ENV !== 'production';

// Default dev values matching `supabase start` output. The anon key here is the
// well-known demo JWT used by Supabase local dev — replace with the value from
// `supabase status` (or your hosted project's API settings).
const DEV_DEFAULTS = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
} as const;

function withDevFallbacks<T extends Record<string, unknown>>(input: T): T {
  if (!isDev) return input;
  const out: Record<string, unknown> = { ...input };
  for (const [k, v] of Object.entries(DEV_DEFAULTS)) {
    if (!out[k]) {
      out[k] = v;
      console.warn(`[env] Using dev fallback for ${k}. Add it to apps/web/.env.local for real Supabase.`);
    }
  }
  return out as T;
}

function parseServer() {
  const parsed = serverSchema.safeParse(withDevFallbacks(process.env));
  if (!parsed.success) {
    console.error('[env] Invalid environment variables:', parsed.error.flatten().fieldErrors);
    if (isDev) {
      // Don't take down the whole dev server — return the partial data with whatever Zod parsed.
      return serverSchema.parse({
        ...process.env,
        ...DEV_DEFAULTS,
      });
    }
    throw new Error('Invalid environment variables');
  }
  return parsed.data;
}

function parseClient() {
  const merged = withDevFallbacks({
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SITE_NAME: process.env.NEXT_PUBLIC_SITE_NAME,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
    NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  });
  const parsed = clientSchema.safeParse(merged);
  if (!parsed.success) {
    console.error('[env] Invalid client environment variables:', parsed.error.flatten().fieldErrors);
    if (isDev) {
      return clientSchema.parse({ ...merged, ...DEV_DEFAULTS });
    }
    throw new Error('Invalid client environment variables');
  }
  return parsed.data;
}

export const env =
  typeof window === 'undefined' ? parseServer() : (parseClient() as ReturnType<typeof parseServer>);
