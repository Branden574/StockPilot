import { readFileSync } from 'node:fs';

import { isLoopback } from './paths';

/**
 * The two rules for the Supabase service key in this harness: it is read
 * without ever being printed, and it is sent to Supabase over TLS (or to a
 * local stack) and nowhere else.
 */

export function serviceKey(): string | null {
  const fromEnv = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const file = process.env.PERF_ENV_FILE;
  let value = fromEnv ?? null;
  if (!value && file) {
    const match = readFileSync(file, 'utf8').match(/^\s*SUPABASE_SERVICE_ROLE_KEY\s*=\s*(.*)$/m);
    value = (match?.[1] ?? '').replace(/^["']|["']$/g, '').trim() || null;
  }
  // Printable ASCII only: a stray newline or quote would otherwise end up
  // inside a header, and header errors echo the header.
  return value && /^[\x21-\x7e]+$/.test(value) ? value : null;
}

/** The service key is only ever sent to Supabase over TLS, or to a local stack. */
export function supabaseOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PERF_SUPABASE_URL is not a URL.');
  }
  const local = isLoopback(url.hostname);
  const hosted = url.protocol === 'https:' && url.hostname.endsWith('.supabase.co');
  if (!local && !hosted) {
    throw new Error(
      'PERF_SUPABASE_URL must be https://<ref>.supabase.co or a local stack; the service key is not sent anywhere else.',
    );
  }
  return url.origin;
}
