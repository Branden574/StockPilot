import { NextResponse } from 'next/server';
import { z } from 'zod';

import { cookieSessionOwesStepUp } from '@/lib/auth/api-context';
import { isSameOriginBrowserRequest } from '@/lib/auth/cross-site-request';
import { rethrowControlFlow } from '@/lib/control-flow';
import { reportError } from '@/lib/error-reporter';
import { createClient } from '@/lib/supabase/server';
import {
  appearanceUserIdSchema,
  readOwnAppearanceRow,
  type OwnAppearanceAnswer,
} from '@/server/lib/own-appearance-row';

/**
 * POST /api/appearance/account: the signed-in person's own Design and Theme,
 * as their account holds them. Body `{"userId": "<uuid>"}`: the person the
 * page believes is signed in. The answer is the JSON the read action answers
 * (server/actions/appearance.ts), from the same server function
 * (server/lib/own-appearance-row.ts): the row, or a reason.
 *
 * A ROUTE HANDLER, NOT A SERVER ACTION (measured 2026-11-11). The provider
 * reads the row a few milliseconds after the hydration commit of every
 * signed-in load. While a server action is pending, React holds the hydration
 * of the page's streamed content and the router holds a client redirect and
 * may queue a link click behind it. A plain request holds none of them.
 *
 * WHO IT ANSWERS, in this order, before anything is read:
 *   1. a page of this origin only: the header `x-sp-appearance: 1`, which a
 *      plain form, link or image cannot send, and the browser's own
 *      same-origin headers (Sec-Fetch-Site, else a matching Origin:
 *      lib/auth/cross-site-request.ts). Anything else is 403;
 *   2. a body of at most 256 bytes that names one uuid. Anything else is 400
 *      `invalid`. The id travels in the body, never in the URL;
 *   3. the session's own account: the user the Auth server validates for this
 *      cookie (getUser) must be the one named. Signed out, or another
 *      person's id, is `unauthenticated`, as JSON and never a redirect (the
 *      proxy leaves /api to the routes);
 *   4. a session that owes no authenticator code (docket S43a,
 *      cookieSessionOwesStepUp, the rule every route that reads a cookie
 *      session keeps: src/test/api-step-up.guard.test.ts). An enrolled
 *      account signed in with the password alone is `unauthenticated`. No
 *      page that names its person to the appearance layer is shown to such a
 *      session, so the app never asks for it.
 * The read then verifies the session's token for that same account and reads
 * as that token, own row only, under RLS (readOwnAppearanceRow).
 *
 * It renders nothing, revalidates nothing and sets no cookie of its own (the
 * cookie client keeps a session it had to renew, as on every route). Every
 * answer is `Cache-Control: no-store`, and the route is never prerendered.
 */

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 256;

const bodySchema = z.object({ userId: appearanceUserIdSchema });

const INVALID: OwnAppearanceAnswer = { ok: false, reason: 'invalid' };
const UNAUTHENTICATED: OwnAppearanceAnswer = { ok: false, reason: 'unauthenticated' };

const NO_STORE = { 'Cache-Control': 'no-store' };

function refuse(): NextResponse {
  return new NextResponse(null, { status: 403, headers: NO_STORE });
}

function answer(body: OwnAppearanceAnswer, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function POST(request: Request) {
  if (request.headers.get('x-sp-appearance') !== '1') return refuse();
  if (!isSameOriginBrowserRequest(request)) return refuse();

  let raw: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return answer(INVALID, 400);
    raw = JSON.parse(text) as unknown;
  } catch {
    return answer(INVALID, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return answer(INVALID, 400);
  const { userId } = parsed.data;

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user || user.id !== userId) return answer(UNAUTHENTICATED);

    // THE AUTHENTICATOR CODE (docket S43a): asked the way withApiContext asks
    // it, right after the identity check and before anything is read.
    if (await cookieSessionOwesStepUp(supabase, user)) return answer(UNAUTHENTICATED);

    return answer(await readOwnAppearanceRow(userId, supabase));
  } catch (e) {
    rethrowControlFlow(e);
    void reportError(e, { tag: 'appearance.read', level: 'warning' });
    return answer({ ok: false, reason: 'error' });
  }
}
