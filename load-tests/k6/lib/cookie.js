// The session cookie the web app's pages read, built the way the installed
// @supabase/ssr (0.12.x) writes it, so a load test can open signed-in pages
// without a browser.
//
// What @supabase/ssr does (node_modules/@supabase/ssr/dist/main):
//   - name: the client's storage key, `sb-<first label of the Supabase host>-auth-token`
//     (supabase-js SupabaseClient: `sb-${hostname.split('.')[0]}-auth-token`);
//     for http://127.0.0.1:58421 that is `sb-127-auth-token`.
//   - value: `base64-` + base64url (no padding) of the UTF-8 JSON of the
//     session (cookieEncoding defaults to "base64url"; cookies.js BASE64_PREFIX).
//   - chunking: when encodeURIComponent(value) is longer than 3180 characters
//     (utils/chunker.js MAX_CHUNK_SIZE) the value is split into `<name>.0`,
//     `<name>.1`, ... each at most 3180 characters once URI-encoded.
//
// No k6 imports: the vitest guard test feeds this cookie to the real
// @supabase/ssr reader and checks the session comes back.

export const MAX_CHUNK_SIZE = 3180;
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** UTF-8 bytes of a string (no TextEncoder in k6's runtime). */
function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
  }
  return out;
}

/** base64url without padding, as @supabase/ssr's stringToBase64URL writes it. */
export function base64UrlOf(str) {
  const bytes = utf8Bytes(str);
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      BASE64URL[(n >> 18) & 63] +
      BASE64URL[(n >> 12) & 63] +
      BASE64URL[(n >> 6) & 63] +
      BASE64URL[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += BASE64URL[(n >> 18) & 63] + BASE64URL[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += BASE64URL[(n >> 18) & 63] + BASE64URL[(n >> 12) & 63] + BASE64URL[(n >> 6) & 63];
  }
  return out;
}

/** The storage key supabase-js derives from the Supabase address. */
export function storageKeyFor(supabaseUrl) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i.exec(supabaseUrl);
  if (!m) throw new Error('storageKeyFor: unreadable Supabase address');
  return `sb-${m[1].split('.')[0]}-auth-token`;
}

/**
 * The cookies (name, value pairs) for one session. The value pieces are the
 * raw cookie values @supabase/ssr stores; `cookieHeader` joins them for a
 * Cookie request header.
 *
 * `session` is the body GoTrue answers a verify with: access_token,
 * refresh_token, expires_in, expires_at, token_type, user.
 */
export function sessionCookies(supabaseUrl, session) {
  const key = storageKeyFor(supabaseUrl);
  const stored = {
    access_token: session.access_token,
    token_type: session.token_type || 'bearer',
    expires_in: session.expires_in,
    expires_at:
      session.expires_at || Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600),
    refresh_token: session.refresh_token,
    user: session.user,
  };
  const value = 'base64-' + base64UrlOf(JSON.stringify(stored));
  // Same split as utils/chunker.js createChunks: base64url and the prefix are
  // all URI-safe characters, so the encoded and raw lengths are the same.
  if (encodeURIComponent(value).length <= MAX_CHUNK_SIZE) return [{ name: key, value }];
  const chunks = [];
  for (let i = 0, n = 0; i < value.length; i += MAX_CHUNK_SIZE, n++) {
    chunks.push({ name: `${key}.${n}`, value: value.slice(i, i + MAX_CHUNK_SIZE) });
  }
  return chunks;
}

/** A Cookie header value for the session. */
export function cookieHeader(supabaseUrl, session) {
  return sessionCookies(supabaseUrl, session)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}
