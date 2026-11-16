import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';
import {
  isAuthPagePath,
  RETURN_PATH_HEADER,
  SESSION_HEADER_USER_EMAIL,
  SESSION_HEADER_USER_ID,
} from '@/lib/supabase/middleware';
import { loadEffectivePermissions } from '@/lib/auth/effective-permissions';
import { safeRedirectPath } from '@/lib/auth/safe-redirect';
import {
  bundleMembership,
  heldMembership,
  holdMembership,
  resolveRequestContext,
  type BundleMembership,
  type RequestContextBundle,
} from '@/lib/auth/request-context-bundle';
import {
  assertAccountActiveOrRedirect,
  resolveAccountStatus,
  type AccountStatusRow,
} from '@/lib/auth/account-status';
import {
  authenticatorSetUpIsOwed,
  startStepUpReads,
  stepUpIsOwed,
  type StepUpReads,
} from '@/lib/auth/step-up-gate';
import {
  AUTHENTICATOR_SET_UP_URL,
  openBeforeAuthenticatorSetUp,
} from '@/lib/auth/authenticator-set-up';

import { effectivePermissions, type Permission, type Role } from '@stockpilot/core';

export interface ServerSession {
  userId: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  defaultOrganizationId: string | null;
}

export interface OrgContext extends ServerSession {
  organizationId: string;
  organizationName: string;
  role: Role;
  /**
   * Effective permission set = static role defaults with org-level role +
   * per-user overrides applied. Consult via `can(ctx, perm)` for every
   * request-scoped gate so configurable overrides take effect. Computed once
   * per request (this fn is React.cache()d). Optional only so synthetic
   * contexts elsewhere stay valid — requireOrgContext always sets it; when
   * absent `can()` falls back to the static role defaults.
   */
  permissions?: Set<Permission>;
}

/**
 * One accepted org membership of the current user, shaped for the org
 * switcher. Derived from loadSessionAndContext's single membership
 * query (cold-start plan rank 8) — the dashboard layout used to issue
 * a THIRD organization_members query per render just to get logo_url.
 */
export interface SessionMembership {
  organizationId: string;
  role: Role;
  name: string;
  logoUrl: string | null;
}

interface LoadedContext {
  session: ServerSession | null;
  orgRole: Role | null;
  orgId: string | null;
  orgName: string | null;
  memberships: SessionMembership[];
  /**
   * True when the legacy membership read failed. `memberships` is then empty
   * because nothing could be read, not because the person belongs to no
   * organization (readSessionMemberships tells the two apart). Never set from
   * the bundle, and false with no session: a signed-out or refuted session
   * has no memberships to read.
   */
  membershipsUnreadable: boolean;
  /**
   * The bundle this context was resolved from, or null when the legacy reads
   * ran. THREADED to the permission resolver instead of asking again: React
   * `cache()` does not memoize inside a Server Action, so a second ask there
   * would be a second round trip AND a second snapshot of the database.
   */
  bundle: RequestContextBundle | null;
}

function pickOrgName(
  orgs: { name: string } | { name: string }[] | null | undefined,
): string | null {
  if (!orgs) return null;
  if (Array.isArray(orgs)) return orgs[0]?.name ?? null;
  return orgs.name ?? null;
}

/**
 * The legacy shape of the first wave: two parallel PostgREST reads. Kept as the
 * fallback for `loadRequestContextBundle()` returning null.
 */
function loadProfileAndMemberships(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
) {
  // Memberships are fetched WITHOUT a limit(1) on purpose (perf plan
  // 2026-07-02 P1e): the old shape grabbed ONE arbitrary membership and,
  // whenever it wasn't the user's default org, issued a SECOND sequential
  // membership query — a per-request penalty for every multi-org user on
  // every dashboard render. A user's accepted memberships are a handful of
  // tiny rows; fetching them all and picking in JS costs the same single
  // round-trip for everyone.
  return Promise.all([
    supabase
      .from('user_profiles')
      // disabled_at rides this EXISTING select for free — the row is already
      // fetched by primary key on every authenticated render, so the
      // platform-wide account-disable check costs zero extra round trips here.
      .select('id, email, full_name, avatar_url, default_organization_id, disabled_at')
      .eq('id', userId)
      .maybeSingle(),
    supabase
      .from('organization_members')
      // id + logo_url ride along (rank 8) so the dashboard layout's org
      // switcher derives from THIS query instead of issuing its own
      // organization_members query per render. Widened columns only —
      // filters/limits are unchanged, so the membership-selection (and
      // therefore permission-floor) semantics are identical.
      .select('organization_id, role, organizations:organization_id (id, name, logo_url)')
      .eq('user_id', userId)
      .not('accepted_at', 'is', null)
      // Same order as get_request_context() (0355). See the note in the loader.
      .order('created_at', { ascending: true })
      .order('organization_id', { ascending: true }),
  ]);
}

function noSession(): LoadedContext {
  return {
    session: null,
    orgRole: null,
    orgId: null,
    orgName: null,
    memberships: [],
    membershipsUnreadable: false,
    bundle: null,
  };
}

/**
 * The user id of this request's cookie session, VERIFIED, or null. The same
 * two steps the proxy takes (lib/supabase/middleware.ts): auth.getClaims()
 * verifies the JWT locally, auth.getUser() asks the Auth server when that
 * cannot answer. Never getSession() or a bare decode: both return whatever the
 * cookie says. Any error is "no verified user", which denies.
 *
 * Only reached when get_request_context() gave no answer, so the fast path
 * never pays for it.
 */
async function verifiedCookieUserId(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<string | null> {
  try {
    const { data, error } = await supabase.auth.getClaims();
    if (!error && typeof data?.claims?.sub === 'string') return data.claims.sub;
  } catch {
    // getClaims() rethrows non-Auth errors (a bad JWK, no WebCrypto). The
    // network check below gives the authoritative answer.
  }
  try {
    const { data, error } = await supabase.auth.getUser();
    if (!error && data?.user?.id) return data.user.id;
  } catch {
    // Fall through: unverifiable is unverified.
  }
  return null;
}

/**
 * Loads user, profile, active membership, and active org name in
 * **one** parallel-pair Supabase round trip. The user id comes from a
 * request header the proxy sets after session verification
 * (auth.getClaims() local JWT verify, auth.getUser() fallback — see
 * lib/supabase/middleware.ts), and is used only once this request's own
 * session is shown to be that user (see below).
 *
 * Wrapped in React.cache() so every consumer in the same render shares
 * one fetch — layout, page, and every service. Layouts no longer need
 * their own membership query.
 */
const loadSessionAndContext = cache(async (): Promise<LoadedContext> => {
  const h = await headers();
  const userId = h.get(SESSION_HEADER_USER_ID);
  if (!userId) return noSession();

  const email = h.get(SESSION_HEADER_USER_EMAIL) ?? '';
  const supabase = await createClient();

  // ═══ THE HEADER IS A HINT, NOT AN IDENTITY ═══
  //
  // The proxy sets or deletes the header only on the routes in its matcher
  // (src/proxy.ts). On `/api/**`, the public pages, and a Server Action POSTed
  // to one of them, it is whatever the client sent. Taken at its word, a signed
  // in member could name a colleague and get the colleague's organization, role
  // and permissions, with the service-role paths scoped by that context.
  //
  // So the header is used only once the request's own session agrees with it.
  // The fast path costs nothing extra: get_request_context() answers with
  // auth.uid(), which PostgREST took from a verified JWT. An answer about
  // anyone else (or nobody) means no session. Without an answer (switched off,
  // failed), the cookie session is verified here before the legacy reads run.
  const resolution = await resolveRequestContext();
  if (resolution.identity === 'refuted') return noSession();
  if (resolution.identity === 'unknown' && (await verifiedCookieUserId(supabase)) !== userId) {
    return noSession();
  }

  // ONE ROUND TRIP WHEN IT CAN BE (migration 0355). `get_request_context()`
  // returns these two reads, and the five that used to follow them, in a single
  // call evaluated under the same row level security. It hands this function
  // the SAME rows in the SAME shape, so everything below (the account-status
  // gate, the org-from-membership rule, the switcher list) is untouched. null
  // means "resolve this request the old way", and the two reads below run.
  // Both sources list memberships OLDEST FIRST (created_at, then organization
  // id), and so do the other two resolvers (api-context pickActiveMembership,
  // services/auth-audit resolveDefaultOrgAndRole). The order only matters to a
  // user with several organizations and no valid default, and for that user
  // every path must land on the SAME organization: the page and the
  // cookie-authed /api calls it makes, and a request that fell back to the
  // legacy reads. The audit resolver counts only memberships with no end time
  // (impersonation_expires_at null), so for an account that also holds a
  // temporary seat it can answer a different organization, on purpose.
  const bundle = resolution.bundle;
  const [profileRes, membersRes] = bundle
    ? [
        { data: bundle.profile, error: null },
        {
          data: bundle.memberships.map((m) => ({
            organization_id: m.organization_id,
            role: m.role,
            organizations: m.organization
              ? {
                  id: m.organization.id,
                  name: m.organization.name,
                  logo_url: m.organization.logo_url,
                }
              : null,
          })),
          error: null,
        },
      ]
    : await loadProfileAndMemberships(supabase, userId);

  const profile = profileRes.data as {
    id: string;
    email: string;
    full_name: string | null;
    avatar_url: string | null;
    default_organization_id: string | null;
    disabled_at: string | null;
  } | null;

  // Account-status gate (install point 1 of 3). This covers every RSC page and
  // every org-scoped Server Action, inherited by all ~128 requireOrgContext and
  // ~166 withContext call sites without touching any of them.
  //
  // It is safe to redirect from inside this cache()d loader because an /api
  // route has no proxy-set header and returns early above, so it can never
  // throw NEXT_REDIRECT out of a route handler (recurring bug #23). A client
  // that sends the header itself gets here only when it names its OWN verified
  // session (checked above), and then only redirects its own request.
  //
  // The read is CLASSIFIED, not merely null-checked. This used to be
  // `if (profile) assertAccountActiveOrRedirect(profile)`, which never looked at
  // profileRes.error: any failure of the select above produced {data: null},
  // skipped the guard entirely, and fell through to the header-derived session
  // below — a disabled user got a complete OrgContext with org and role, and
  // nothing was reported. The same error failed CLOSED at the other two funnels,
  // so one error class produced opposite outcomes. resolveAccountStatus reports
  // the failure and returns 'unreadable', which denies (by throwing) WITHOUT
  // showing the disabled screen to someone whose account is fine.
  const status = await resolveAccountStatus(
    { data: profileRes.data as AccountStatusRow | null, error: profileRes.error },
    userId,
  );
  assertAccountActiveOrRedirect(status);

  const session: ServerSession = profile
    ? {
        userId: profile.id,
        email: profile.email,
        fullName: profile.full_name,
        avatarUrl: profile.avatar_url,
        defaultOrganizationId: profile.default_organization_id,
      }
    : {
        userId,
        email,
        fullName: null,
        avatarUrl: null,
        defaultOrganizationId: null,
      };

  type MemberOrg = { id: string; name: string; logo_url: string | null };
  const memberRows = (membersRes.data ?? []) as Array<{
    organization_id: string;
    role: Role;
    organizations: MemberOrg | MemberOrg[] | null;
  }>;
  // A failed read answers { data: null, error }, which the line above turns
  // into no rows. Every page still redirects to /onboarding on that (no org
  // below), and /onboarding reads again with its own error check; code that
  // must tell a failed read from no membership asks readSessionMemberships.
  // The code only, never the message, which can quote request details.
  const membershipsUnreadable = membersRes.error != null;
  if (membershipsUnreadable) {
    console.warn('[session] membership read failed:', membersRes.error?.code || 'unknown');
  }

  // Same selection semantics as the old two-query shape: prefer the
  // membership matching the profile's default org; otherwise fall back to
  // the first row PostgREST returned (previously the arbitrary limit(1) row).
  const memberRow =
    (session.defaultOrganizationId
      ? memberRows.find((m) => m.organization_id === session.defaultOrganizationId)
      : undefined) ??
    memberRows[0] ??
    null;

  // Org-switcher shape, derived from the SAME rows (rank 8). Rows whose
  // to-one embed came back empty are dropped — identical to the layout's
  // old `if (!org) return null` mapping.
  const memberships: SessionMembership[] = memberRows
    .map((m) => {
      const org = Array.isArray(m.organizations) ? m.organizations[0] : m.organizations;
      if (!org) return null;
      return {
        organizationId: m.organization_id,
        role: m.role,
        name: org.name,
        logoUrl: org.logo_url ?? null,
      };
    })
    .filter((m): m is SessionMembership => m !== null);

  return {
    session,
    orgRole: memberRow?.role ?? null,
    orgId: memberRow?.organization_id ?? null,
    orgName: memberRow ? pickOrgName(memberRow.organizations) : null,
    memberships,
    membershipsUnreadable,
    bundle,
  };
});

/**
 * The current user's accepted memberships (org switcher data), shared
 * with every other consumer of loadSessionAndContext in the render —
 * zero additional round trips. Empty array when signed out.
 */
export const getSessionMemberships = cache(async (): Promise<SessionMembership[]> => {
  const { memberships } = await loadSessionAndContext();
  return memberships;
});

export type SessionMembershipsRead = { ok: true; memberships: SessionMembership[] } | { ok: false };

/**
 * The current user's accepted memberships, or `{ ok: false }` when they could
 * not be read. A list that cannot be read is not "no organization":
 * getSessionMemberships() answers both with an empty array, which is right for
 * the org switcher (it renders only after requireOrgContext() resolved a
 * membership). Code that must tell the two apart uses this reader. Signed out
 * is `{ ok: true, memberships: [] }`.
 */
export const readSessionMemberships = cache(async (): Promise<SessionMembershipsRead> => {
  const { memberships, membershipsUnreadable } = await loadSessionAndContext();
  if (membershipsUnreadable) return { ok: false };
  return { ok: true, memberships };
});

/** The organization requireOrgContext() resolves for this request, and the member's role in it. */
export interface SessionOrganization {
  organizationId: string;
  role: Role;
  /** The membership it came from when get_request_context() answered, else null. */
  held: BundleMembership | null;
}

export type SessionOrganizationRead =
  | { ok: false; reason: 'no_verified_session' | 'memberships_unreadable' }
  | { ok: true; userId: string; organization: SessionOrganization | null };

/**
 * Which organization requireOrgContext() resolves for this request, from the
 * same load and by the same rule (the profile's default organization when it
 * is an accepted membership, else the oldest), with none of its redirects and
 * no context. For a funnel that validated its own user and must still work for
 * an account with no organization: the sign-in email change asks it which
 * organization's authenticator policy applies (server/actions/email-change.ts).
 * NOT a context: nothing is read or written for the organization on it.
 *
 * `organization` is null for an account with no accepted membership.
 * `{ ok: false }` when this request has no verified session, or when the
 * memberships could not be read (`reason` says which): the caller cannot
 * tell which organization applies, so it refuses. The load still sends a disabled account to its own
 * page, as it does for every caller.
 */
export const readSessionOrganization = cache(async (): Promise<SessionOrganizationRead> => {
  const { session, orgId, orgRole, membershipsUnreadable, bundle } = await loadSessionAndContext();
  if (!session) return { ok: false, reason: 'no_verified_session' };
  if (membershipsUnreadable) return { ok: false, reason: 'memberships_unreadable' };
  return {
    ok: true,
    userId: session.userId,
    organization:
      orgId && orgRole
        ? { organizationId: orgId, role: orgRole, held: bundleMembership(bundle, orgId) }
        : null,
  };
});

export const getServerSession = cache(async (): Promise<ServerSession | null> => {
  const { session } = await loadSessionAndContext();
  return session;
});

/**
 * Sign-in, carrying the page to come back to: `?redirect=<path and query>`,
 * the proxy's own rule for a signed-out request (lib/supabase/middleware.ts),
 * which the sign-in form reads back through safeRedirectPath. For a Server
 * Action it is the page the action was sent from. The path is the proxy's on
 * the routes in its matcher and the client's anywhere else, so it is
 * sanitized the same way (a same-origin path or nothing), and dropped when it
 * is a sign-in page itself.
 */
async function signInPath(): Promise<string> {
  const back = safeRedirectPath((await headers()).get(RETURN_PATH_HEADER), '');
  if (!back || isAuthPagePath(back)) return '/signin';
  return `/signin?${new URLSearchParams({ redirect: back }).toString()}`;
}

/**
 * The authenticator code page, carrying the page to come back to by the same
 * rule as signInPath() above; the code form reads it back through
 * safeRedirectPath too. Never the code page itself, or any other sign-in
 * page: isAuthPagePath drops those.
 */
async function codePagePath(): Promise<string> {
  const back = safeRedirectPath((await headers()).get(RETURN_PATH_HEADER), '');
  if (!back || isAuthPagePath(back)) return '/signin/mfa';
  return `/signin/mfa?${new URLSearchParams({ redirect: back }).toString()}`;
}

export const requireSession = cache(async (): Promise<ServerSession> => {
  const session = await getServerSession();
  if (!session) redirect(await signInPath());
  return session;
});

/**
 * The signed-in member's context in an organization: what every dashboard
 * page and every Server Action that works for an organization builds on,
 * directly or through withContext().
 *
 * No session goes to sign-in, a disabled account to its own page (the loader),
 * a member with no organization to /onboarding. And a member who has a
 * verified authenticator, on a session that has not entered its code, goes to
 * /signin/mfa before anything else is resolved (lib/auth/step-up-gate): the
 * rule the dashboard layout applies to a page load, here for every caller, so
 * a Server Action and a request for one page segment are held to it too.
 *
 * And once the organization and the role are resolved, a member whose
 * organization's policy requires an authenticator of their role, and who has
 * none verified, goes to the security settings page to set one up
 * (sendToSetUpWhenOwed below). Only the security page and the profile page
 * are open to them (lib/auth/authenticator-set-up), with the Server Actions
 * made from those pages: on the security page setting up an authenticator and
 * switching organization run; on the profile page the page opens and the
 * appearance setting works, while the profile's own actions (name, avatar,
 * email, deleting the account) reach their own authenticator check, which
 * answers that one is required.
 *
 * ONE EXIT. The context is resolved by resolveOrgContext() below, and this is
 * the only place its answer is handed to a page or an action, always through
 * sendToSetUpWhenOwed() (authenticator-set-up.guard.test.ts pins the shape).
 *
 * requireSession() above does NOT ask for the code, on purpose: the code page
 * itself, the recovery code, enrolling a first authenticator and signing out
 * all run on a session that has not entered one.
 */
export const requireOrgContext = cache(async (orgId?: string): Promise<OrgContext> => {
  const { ctx, reads } = await resolveOrgContext(orgId);
  return sendToSetUpWhenOwed(reads, ctx);
});

/**
 * FOR THE DASHBOARD'S LAYOUTS ONLY: the same context as requireOrgContext(),
 * with every rule but the set-up redirect (sign-in, a disabled account, the
 * authenticator code, no organization: their pages are outside these layouts).
 *
 * NO LAYOUT MAY REDIRECT TO A PAGE UNDER ITSELF. When a layout is rendered for
 * a client-side navigation or a refresh (the landing after sign-in, an
 * organization switch, accepting an invitation), a redirect thrown by it is
 * kept by the browser as that layout's answer; the target shares the layout,
 * so the server does not send the layout again, and the browser renders the
 * kept redirect again and again. The security page is under the dashboard's
 * layouts, so they take this context, and the pages below them ask
 * requireOrgContext(), whose redirect is caught below the layouts.
 *
 * Only layout.tsx files under app/(dashboard) may use it
 * (authenticator-set-up.guard.test.ts). The same cached resolve serves both,
 * so a layout and its page read the context once.
 */
export const requireOrgContextForLayout = cache(
  async (orgId?: string): Promise<OrgContext> => (await resolveOrgContext(orgId)).ctx,
);

/** The context and the code gate's reads, before the set-up rule (requireOrgContext above). */
const resolveOrgContext = cache(
  async (orgId?: string): Promise<{ ctx: OrgContext; reads: StepUpReads }> => {
    // Started before the context resolves, so the gate's reads run alongside it.
    // Not for a request with no identity header: the loader finds no session
    // there, and nothing is read about one that is not there.
    const stepUp = (await headers()).get(SESSION_HEADER_USER_ID) ? startStepUpReads() : null;
    const {
      session,
      orgRole,
      orgId: defaultOrgId,
      orgName,
      bundle,
    } = await loadSessionAndContext();
    if (!session) redirect(await signInPath());
    const reads = stepUp ?? startStepUpReads();

    // ═══ THE AUTHENTICATOR CODE COMES FIRST ═══
    //
    // Before the organization, the role or a permission is resolved. Safe to
    // redirect from here for the same reason as the account-status gate in the
    // loader: an /api route has no proxy-set header and is sent to sign-in
    // above, and a client that sends the header itself gets here only as its
    // own verified session, so it redirects only its own request. The /api
    // routes answer such a session themselves (lib/auth/api-context).
    if (await stepUpIsOwed(reads, session.userId)) {
      redirect(await codePagePath());
    }

    // ═══ THE ORG MUST COME FROM A MEMBERSHIP, NEVER FROM A PREFERENCE ═══
    //
    // `defaultOrgId` is the org of the membership the loader RESOLVED above: it
    // already prefers the profile's `default_organization_id` when that is a
    // real, accepted membership, and falls back to another one when it is not.
    //
    // Reading `session.defaultOrganizationId` here instead re-introduced the raw
    // preference AFTER that resolution. Nothing clears the column when a member
    // is removed (TeamService.removeMember only deletes membership + assignment
    // rows), so a user removed from org A while still belonging to org B got a
    // context with organizationId = A and the role, name and permissions of B.
    // RLS blocks most reads for a non-member, but every service-role path scopes
    // by ctx.organizationId — so writes were aimed at an org the user had been
    // removed from, with a role they held somewhere else.
    const targetOrgId = orgId ?? defaultOrgId;
    if (!targetOrgId) redirect('/onboarding');

    if (orgId && orgId !== defaultOrgId) {
      // The bundle already holds EVERY accepted membership of this user, so an
      // explicit org is answered from it: present means member (with that role),
      // absent means not a member, which is the same redirect the read below ends
      // in. Only without a bundle does the legacy membership read run.
      if (bundle) {
        const held = bundleMembership(bundle, orgId);
        if (!held) redirect('/onboarding');
        // Carried on the context so withContext() takes the org row and modules
        // from this same membership instead of asking again (see holdMembership).
        return {
          reads,
          ctx: holdMembership(
            {
              ...session,
              organizationId: orgId,
              organizationName: held.organization?.name ?? 'Workspace',
              role: held.role,
              permissions: await resolvePermissions(bundle, orgId, session.userId, held.role),
            },
            held,
          ),
        };
      }
      const supabase = await createClient();
      const { data: member } = await supabase
        .from('organization_members')
        .select('role, organizations:organization_id (name)')
        .eq('organization_id', orgId)
        .eq('user_id', session.userId)
        .not('accepted_at', 'is', null)
        .maybeSingle();
      if (!member) redirect('/onboarding');
      const orgs = (member as { organizations: { name: string } | { name: string }[] | null })
        .organizations;
      const role = (member as { role: Role }).role;
      return {
        reads,
        ctx: {
          ...session,
          organizationId: orgId,
          organizationName: pickOrgName(orgs) ?? 'Workspace',
          role,
          permissions: await loadEffectivePermissions(supabase, orgId, session.userId, role),
        },
      };
    }

    if (!orgRole) redirect('/onboarding');

    // Legacy reads (no bundle) attach nothing, and withContext() then reads the
    // org row and modules the way it always has.
    return {
      reads,
      ctx: holdMembership(
        {
          ...session,
          organizationId: targetOrgId,
          organizationName: orgName ?? 'Workspace',
          role: orgRole,
          permissions: await resolvePermissions(bundle, targetOrgId, session.userId, orgRole),
        },
        bundleMembership(bundle, targetOrgId),
      ),
    };
  },
);

/**
 * ═══ AUTHENTICATOR SET-UP COMES BEFORE EVERY OTHER PAGE ═══
 *
 * `ctx` when the member owes no set-up, or the request is for a page open to
 * them before set-up; otherwise a redirect to the security settings page with
 * its "Enroll to continue" callout.
 *
 * The page is `x-pathname`. The proxy (lib/supabase/middleware) sets it,
 * replacing any value the client sent, on the routes its matcher covers, which
 * include every dashboard page and every Server Action posted to one (there it
 * is the page the action was made from). On a route outside the matcher the
 * header is whatever the client sent. With no path the member is sent to
 * set-up. The security page and the profile page do not redirect, no dashboard
 * layout redirects to set-up (requireOrgContextForLayout above), and the
 * sign-in pages never ask requireOrgContext() (page-step-up.guard.test.ts).
 *
 * Checked on the page first, so an open page reads nothing for it. The answer
 * itself (authenticatorSetUpIsOwed, lib/auth/step-up-gate) reads nothing at
 * aal2, and otherwise only the gate's own factor list and the membership (or,
 * without one, the request-cached organization row the layout reads too).
 */
async function sendToSetUpWhenOwed<T extends OrgContext>(reads: StepUpReads, ctx: T): Promise<T> {
  if (openBeforeAuthenticatorSetUp((await headers()).get('x-pathname'))) return ctx;
  if (await authenticatorSetUpIsOwed(reads, ctx, heldMembership(ctx))) {
    redirect(AUTHENTICATOR_SET_UP_URL);
  }
  return ctx;
}

/**
 * Effective permissions = static role defaults + the organization's overrides
 * for that role + this user's overrides.
 *
 * From the bundle when it holds this organization WITH THIS ROLE: the override
 * rows are the same rows `loadEffectivePermissions` selects, read in the same
 * round trip as the membership they belong to, and fed to the same
 * `effectivePermissions`. Owner is never overridable, in either path, EXCEPT
 * for a platform-managed key StockPilot support explicitly denied to them
 * (orders:manage_catalog_visibility, migration 0413): the owner's own user
 * rows are handed over, and core applies only that deny. Any disagreement (no
 * bundle, organization not in it, a different role) goes to the legacy loader.
 * When it cannot read a non-owner's overrides it REFUSES the request
 * (PermissionsUnavailableError, docket S19) rather than answer with the role's
 * defaults, which would hand back every permission the organization took away.
 * The error is not a redirect: it reaches the page's error boundary, which
 * offers to try again, and a Server Action's own catch.
 */
async function resolvePermissions(
  bundle: RequestContextBundle | null,
  organizationId: string,
  userId: string,
  role: Role,
): Promise<Set<Permission>> {
  // The SAME bundle the role came from: one snapshot, so the role and the
  // overrides that modify it can never be from two different moments.
  const held = bundleMembership(bundle, organizationId);
  if (held && held.role === role) {
    return effectivePermissions(role, held.role_overrides, held.user_overrides);
  }
  const supabase = await createClient();
  return loadEffectivePermissions(supabase, organizationId, userId, role);
}
