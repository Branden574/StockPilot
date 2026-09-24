/**
 * WHO HOLDS THE SESSION ON THIS DEVICE, read from the persisted auth entry
 * itself: no refresh, no network, no auth lock.
 *
 * WHY NOT supabase.auth.getSession(). In auth-js 2.105.1, getSession() treats
 * an access token within 90 s of expiry as expired and refreshes it first
 * (GoTrueClient __loadSession -> _callRefreshToken). Offline, that refresh
 * fails with AuthRetryableFetchError after about 25 s of retries; auth-js then
 * KEEPS the session in storage (only a non-retryable error removes it) but
 * getSession() answers `{ session: null, error }`, and signOut() returns that
 * same error without removing anything. Calls queue behind the auth lock, so
 * two reads took about 50 s. Reading "no session" out of that answer meant:
 *   - a sign-out that failed offline looked like it had worked, so the
 *     biometric lock and the MFA gate were lifted on a session still present
 *     (auth-context signOutToFallback), and a deliberate sign-out wiped the
 *     cache while the user stayed signed in;
 *   - the offline outbox, counting for more than an hour, stamped new rows
 *     with no owner, dropped the user's own rows from every counter, listed
 *     them as another account's, and waited 25 s or more on every save.
 * Reproduced against the exact dist the app resolves; auth-storage.test.ts
 * runs the same client.
 *
 * WHAT IS READ. auth-js writes the whole session JSON (with `user`) under ONE
 * key, and removes that key only when the session really ends (a successful
 * sign-out, or a refresh the server refused). So:
 *   - the key's HEAD entry present = a session is on this device. The chunked
 *     SecureStore adapter (supabase.ts) rewrites the head in place and deletes
 *     it last, so the head never disappears while a session exists, even
 *     mid-write;
 *   - the parsed session's user.id = whose it is. Mid-write (a chunk missing)
 *     or unparseable, the session is present but its owner is not known right
 *     now (userId null).
 */

export interface StoredAuthSession {
  /** A session is persisted on this device (it may be expired; it is not over). */
  present: boolean;
  /** Its account, or null when none is present or the entry cannot be read now. */
  userId: string | null;
}

/** The two reads the chunked SecureStore adapter offers. */
export interface AuthStorageReader {
  /** The raw head entry for `key` (SecureStore.getItemAsync). */
  head(key: string): Promise<string | null>;
  /** The whole value, chunks reassembled (the adapter's getItem). */
  full(key: string): Promise<string | null>;
}

/**
 * The storage key supabase-js derives for a project URL when none is passed:
 * `sb-<first label of the host>-auth-token` (SupabaseClient constructor,
 * 2.105.1). supabase.ts passes it explicitly so the client and the reader
 * below can never disagree; auth-storage.test.ts pins that it equals the
 * default, so passing it moved no existing session.
 */
export function authStorageKeyFor(supabaseUrl: string): string {
  return `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
}

/**
 * The account id in a persisted session value, or null. Mirrors auth-js's
 * own validity test (_isValidSession: access_token, refresh_token and
 * expires_at present): a value auth-js would discard has no owner.
 */
export function storedSessionUserId(raw: string | null): string | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const s = parsed as Record<string, unknown>;
  if (!('access_token' in s) || !('refresh_token' in s) || !('expires_at' in s)) return null;
  const user = s.user as Record<string, unknown> | null | undefined;
  const id = user && typeof user === 'object' ? user.id : null;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Read the persisted session. REJECTS when the storage cannot be read (a
 * locked Keychain): the caller decides which way to fail, and every caller
 * that gates something on it treats a rejection as "still signed in".
 */
export async function readStoredAuthSession(
  storage: AuthStorageReader,
  key: string,
): Promise<StoredAuthSession> {
  const head = await storage.head(key);
  if (head === null) return { present: false, userId: null };
  return { present: true, userId: storedSessionUserId(await storage.full(key)) };
}
