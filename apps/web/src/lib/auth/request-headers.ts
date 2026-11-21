import 'server-only';

import { headers } from 'next/headers';

/**
 * The request's headers, or null outside a request (a script, a test): never
 * a throw. For code that records a security event beside its real work and
 * must not fail because of it (lib/auth/verify-password.ts,
 * lib/auth/mfa-code-attempts.ts).
 */
export async function requestHeadersOrNull(): Promise<Awaited<ReturnType<typeof headers>> | null> {
  try {
    return await headers();
  } catch {
    return null;
  }
}
