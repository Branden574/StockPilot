import { NextResponse } from 'next/server';
import { z } from 'zod';

import { APPEARANCE_STORAGE_KEYS, appearanceStyleSchema } from '@stockpilot/core';

import { isSameOriginBrowserRequest } from '@/lib/auth/cross-site-request';

/**
 * POST /api/appearance/style: the server sets the Liquid Glass Design cookie
 * (plans/REVISION-DEFAULT.md R6).
 *
 * The first-paint head script and the marketing rewrites read `sp_style`.
 * WebKit caps a cookie written by `document.cookie` at 7 days, so a person who
 * chose Classic and stayed away a week would see a moment of glass. A cookie
 * set by the server is not capped: this answers with the same cookie for 400
 * days (Chrome's cap). The browser calls it right after every cookie it writes
 * itself, and at most once a day otherwise (components/theme/appearance-
 * cookie.ts). Not HttpOnly: the head script reads it.
 *
 * A route handler, not a Server Action: setting a cookie in a Server Action
 * makes Next render the current route again on the server, a refetch on every
 * switch, which the plan forbids.
 *
 * No auth and no database: it only sets the caller's own cookie to a
 * validated Design. So that a page on another site cannot flip someone's
 * cookie, it needs the browser's own same-origin headers (Sec-Fetch-Site,
 * else a matching Origin: lib/auth/cross-site-request.ts) and the header
 * `x-sp-appearance: 1`, which a plain form, link or image cannot send. Every
 * answer is `Cache-Control: no-store`.
 */

const MAX_AGE = 34560000;
const MAX_BODY = 256;

const bodySchema = z.object({ style: appearanceStyleSchema });

function answer(status: number, cookie?: string): NextResponse {
  const response = new NextResponse(null, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
  if (cookie) response.headers.append('Set-Cookie', cookie);
  return response;
}

/**
 * Secure on https (always in production). A plain-http local server (the lab)
 * leaves it off, because some browsers drop a Secure cookie there.
 */
function isHttps(request: Request): boolean {
  if (request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https') return true;
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return true;
  }
}

export async function POST(request: Request) {
  if (request.headers.get('x-sp-appearance') !== '1') return answer(403);
  if (!isSameOriginBrowserRequest(request)) return answer(403);

  let raw: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return answer(400);
    raw = JSON.parse(text) as unknown;
  } catch {
    return answer(400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return answer(400);

  const secure = isHttps(request) ? '; Secure' : '';
  return answer(
    204,
    `${APPEARANCE_STORAGE_KEYS.webCookie}=${parsed.data.style}; Path=/; Max-Age=${MAX_AGE}; SameSite=Lax${secure}`,
  );
}
