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
  matcher: [
    /*
     * Match all request paths except:
     *  - _next/static, _next/image, favicon.ico
     *  - public assets in /public (svg, png, jpg, jpeg, gif, webp, avif)
     *  - api routes
     */
    '/((?!_next/static|_next/image|favicon\\.ico|api|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif)$).*)',
  ],
};
