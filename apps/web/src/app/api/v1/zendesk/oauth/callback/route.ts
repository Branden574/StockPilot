import { NextResponse, type NextRequest } from 'next/server';
import { withApiContext } from '@/lib/auth/api-context';
import { UserConnectionsService } from '@/server/services/user-connections';
import { verifyState } from '@/server/connectors/zendesk/oauth-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');

  // Determine platform early (before auth) so we can redirect correctly on any
  // failure — the user's browser is already on this page. A missing/invalid
  // state can't tell us the platform, so default to web.
  const platform = (state ? verifyState(state) : null)?.platform ?? 'web';

  const successTarget =
    platform === 'mobile'
      ? 'stockpilot://zendesk/connected'
      : new URL('/dashboard/zendesk?connected=1', req.url).toString();
  const errorTarget =
    platform === 'mobile'
      ? 'stockpilot://zendesk/error'
      : new URL('/dashboard/zendesk?error=connect_failed', req.url).toString();

  // This is a browser landing, so EVERY failure — including an expired/absent
  // session — redirects to the console error page, never dumps JSON at the user.
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.redirect(errorTarget, { status: 302 });

  if (!code || !state) {
    return NextResponse.redirect(errorTarget, { status: 302 });
  }

  try {
    await new UserConnectionsService(ctx).completeZendeskConnect(code, state);
    return NextResponse.redirect(successTarget, { status: 302 });
  } catch {
    return NextResponse.redirect(errorTarget, { status: 302 });
  }
}
