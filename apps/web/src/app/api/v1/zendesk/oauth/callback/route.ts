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

  if (!code || !state) {
    return NextResponse.redirect(errorTarget, { status: 302 });
  }

  // Dual completion path:
  //   - Web: withApiContext succeeds (cookie session) → use the session-bound
  //     instance method, which re-checks module + permission gates.
  //   - Mobile: the system browser carries no app session, so ctx is null.
  //     Trust the HMAC-signed state (capability token) instead. Authorization
  //     was enforced when the state was issued at GET /api/v1/zendesk/me/connect-url.
  // The branch is chosen by SESSION PRESENCE (ctx), NOT state.platform — and
  // identity safety doesn't depend on platform either way: completeFromState
  // binds org_id/user_id solely to the verified state's own embedded identity.
  // (state.platform only selects the redirect target above.)
  const ctx = await withApiContext(req);
  try {
    if (ctx) {
      await new UserConnectionsService(ctx).completeZendeskConnect(code, state);
    } else {
      await UserConnectionsService.completeFromState(code, state);
    }
    return NextResponse.redirect(successTarget, { status: 302 });
  } catch {
    return NextResponse.redirect(errorTarget, { status: 302 });
  }
}
