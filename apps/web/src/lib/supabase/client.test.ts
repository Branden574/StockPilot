// @vitest-environment happy-dom
import { createBrowserClient } from '@supabase/ssr';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * ROOT CAUSE PIN (docket B39 review): the web app's browser Supabase client
 * never adopts a session that arrives in the URL fragment.
 *
 * A link Supabase verifies itself (its action_link: an older email, or one
 * sent from the Supabase dashboard) hands its session back in the fragment,
 * and the app's redirects keep that fragment on the way to /signin. The client
 * comes from @supabase/ssr's createBrowserClient, which forces the PKCE flow
 * whatever options it is given, and auth-js refuses an implicit-grant fragment
 * under PKCE. It also reads the query over the fragment, so the
 * ?error=auth_callback_failed that /auth/callback adds makes it refuse even
 * earlier. Either way it keeps no session and leaves the fragment in place.
 *
 * So the sign-in page treats such a fragment as a spent link
 * (lib/auth/auth-page-notices.ts) and takes the tokens out of the address bar
 * (components/auth/session-fragment-scrub.tsx). If this ever fails after an
 * upgrade, do NOT make the page adopt the session (setSession, or a client in
 * the implicit flow): any page could then sign a signed-out browser in to
 * another account by linking to /signin#access_token=<theirs> (login CSRF,
 * docket S14). Placeholder project and tokens; a stubbed fetch records any
 * request and none is made.
 */

vi.mock('@/lib/env.client', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://project.example.invalid',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder-anon-key',
  },
}));

const SESSION =
  '#access_token=h.p.s&expires_in=3600&refresh_token=r1&token_type=bearer&type=recovery';

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

function stubFetch() {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('{}', { status: 500, statusText: 'stub' }));
}

describe('the browser Supabase client and a session in the URL fragment', () => {
  it('is PKCE-only, and refuses the session on the landing /auth/callback gives a link Supabase verified', async () => {
    window.history.replaceState(null, '', `/signin?error=auth_callback_failed${SESSION}`);
    const fetchSpy = stubFetch();
    const { createClient } = await import('./client');
    const supabase = createClient();
    expect((supabase.auth as unknown as { flowType: string }).flowType).toBe('pkce');

    const init = await supabase.auth.initialize();
    const { data } = await supabase.auth.getSession();
    supabase.auth.stopAutoRefresh();

    expect(init.error?.name).toBe('AuthImplicitGrantRedirectError');
    expect(data.session).toBeNull();
    // auth-js clears the fragment only once it has adopted a session.
    expect(window.location.hash).toBe(SESSION);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses it with no error in the query too: an implicit-grant fragment is not a PKCE callback', async () => {
    // A second client of the same make (the app's is a per-page singleton, so
    // a fresh one is built the way lib/supabase/client.ts builds it): the flow
    // is forced after the given auth options are spread, so no option the app
    // could pass changes this.
    window.history.replaceState(null, '', `/signin?redirect=%2Fdashboard${SESSION}`);
    const fetchSpy = stubFetch();
    const supabase = createBrowserClient(
      'https://project.example.invalid',
      'placeholder-anon-key',
      {
        isSingleton: false,
        auth: { flowType: 'implicit' },
      },
    );

    const init = await supabase.auth.initialize();
    const { data } = await supabase.auth.getSession();
    supabase.auth.stopAutoRefresh();

    expect(init.error?.message).toBe('Not a valid PKCE flow url.');
    expect(data.session).toBeNull();
    expect(window.location.hash).toBe(SESSION);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
