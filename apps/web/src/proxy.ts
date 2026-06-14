import type { NextRequest } from 'next/server';

import { updateSession } from '@/lib/supabase/middleware';

/**
 * Next.js 16 renamed the middleware convention to "proxy". File is now
 * apps/web/src/proxy.ts and the export is `proxy`. Behavior unchanged.
 */
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Explicit allowlist of paths that actually need an auth.getUser() round
  // trip + cookie refresh. The previous matcher caught everything except
  // /_next, /api, and static images, which meant the marketing landing,
  // /p/items, /r/* public order pages, /orders/sign/*, /i/* shortcuts —
  // all anonymous surfaces — paid for a Supabase Auth API call on every
  // visit. Anonymous pages now skip the proxy entirely.
  //
  // What's NOT here (intentionally excluded — verified each handles
  // session/cookies on its own or doesn't need one):
  //   /                     marketing landing, fully anonymous
  //   /p/items/[id]         public item page, no auth
  //   /r/[token], /r/track, /r/confirm  public order requests
  //   /orders/sign/[token]  public signature collect, no auth
  //   /i/[token]            invite-shortcut route handler (handles auth itself)
  //   /auth/callback        OAuth/magic-link callback (uses createClient
  //                         to exchange the code; doesn't need middleware)
  //   /api/**               API routes always handle their own auth
  matcher: [
    '/dashboard/:path*',
    '/platform/:path*',
    '/onboarding/:path*',
    '/signin/:path*',
    '/signup',
    '/reset/:path*',
    '/invite/:path*',
  ],
};
