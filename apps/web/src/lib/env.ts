/**
 * Centralized env access. Strict in production, forgiving in development —
 * dev never throws on missing values; instead it logs a warning and falls
 * back to placeholders so the marketing pages render without a Supabase
 * project running.
 */
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

  RESEND_API_KEY: optionalSecret.transform((s) => s.trim()),
  RESEND_FROM_EMAIL: z.string().transform((s) => s.trim()).default('StockPilot <hello@stockpilotusa.com>'),

  // Random shared secret. Vercel Cron sends `Authorization: Bearer <secret>`
  // to scheduled routes; we compare against this. Set the same value in
  // Vercel project env. Only required if Vercel Cron is enabled — local
  // dev and test runs ignore it.
  CRON_SECRET: optionalSecret.transform((s) => s.trim()),

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
});

const clientSchema = z.object({
  NEXT_PUBLIC_APP_URL: urlField,
  NEXT_PUBLIC_SITE_NAME: z.string().transform((s) => s.trim()).default('StockPilot'),
  NEXT_PUBLIC_SUPABASE_URL: supabaseUrlField,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().transform((s) => s.trim()).pipe(z.string().min(1)),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().optional().default('').transform((s) => s.trim()),
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
