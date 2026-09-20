import { existsSync, readFileSync, rmSync } from 'node:fs';

import { serviceKey, supabaseOrigin } from './supabase-admin';

/** @supabase/ssr stores the session as `sb-<ref>-auth-token[.N]`, base64url JSON, chunked when long. */
function accessToken(statePath: string): string | null {
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      cookies?: Array<{ name: string; value: string }>;
    };
    const chunks = (state.cookies ?? [])
      .filter((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name))
      .sort((a, b) => Number(a.name.split('.')[1] ?? 0) - Number(b.name.split('.')[1] ?? 0));
    if (chunks.length === 0) return null;
    const joined = decodeURIComponent(chunks.map((c) => c.value).join(''));
    const json = joined.startsWith('base64-')
      ? Buffer.from(joined.slice(7), 'base64url').toString('utf8')
      : joined;
    const token = (JSON.parse(json) as { access_token?: unknown }).access_token;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Signs ONE saved session out (`scope=local`: the account's other sessions are
 * untouched) and deletes the file. Sign-out is best-effort, deletion is not: if
 * the token cannot be read the file still goes, and with it the only copy of
 * the refresh token.
 */
export async function endSavedSession(statePath: string): Promise<void> {
  try {
    const supabaseUrl = process.env.PERF_SUPABASE_URL;
    const token = existsSync(statePath) ? accessToken(statePath) : null;
    // The gateway wants a project API key beside the user's own token; the
    // service key the setup already uses for this origin is the one at hand.
    const apikey = serviceKey();
    if (supabaseUrl && token && apikey) {
      await fetch(`${supabaseOrigin(supabaseUrl)}/auth/v1/logout?scope=local`, {
        method: 'POST',
        redirect: 'error',
        headers: { apikey, Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
  } catch {
    /* best-effort: the deletion below is what matters */
  } finally {
    rmSync(statePath, { force: true });
  }
}
