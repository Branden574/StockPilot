import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { DashboardShell } from '@/components/dashboard/dashboard-shell';
import { MfaRequiredBanner } from '@/components/dashboard/mfa-required-banner';
import { ModulesUnreadBanner } from '@/components/dashboard/modules-unread-banner';
import {
  DENSITY_COOKIE,
  NAV_COLLAPSED_COOKIE,
  SIDEBAR_HIDDEN_COOKIE,
  parseCollapsedSections,
  parseDensity,
  parseSidebarHidden,
} from '@/components/dashboard/sidebar-pref';
import { ImpersonationBanner } from '@/components/platform/impersonation-banner';
import { currentUserIsPlatformAdminFromRequestHeader } from '@/lib/auth/platform-admin';
import { InventoryRealtime } from '@/components/realtime/inventory-realtime';
import { getSessionMemberships, requireOrgContext } from '@/lib/auth/session';
import {
  getMfaFactorsForRequest,
  getModulesForRequest,
  getOrgRowForRequest,
  getWarehousesForRequest,
} from '@/lib/dashboard/request-cache';
import { factorsOf } from '@/lib/auth/mfa-factors';
import { moduleSetUnreadable } from '@/lib/modules/module-state';
import { enforcedMfaPolicy } from '@/lib/auth/mfa-policy';
import { orSessionEnded } from '@/lib/auth/session-ended';
import { getVerifiedSessionClaimsForRequest } from '@/lib/auth/verified-claims';
import { userMenuRoleLabel } from '@/lib/auth/user-menu-role';
import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';

import { resolveTerminology } from '@stockpilot/core';
import { ActivityBeacon } from '@/components/activity-beacon';

// Override the root layout's marketing title for everything under
// /dashboard. Without this, every dashboard page that doesn't export
// its own `metadata.title` inherits "StockPilot — Inventory you'll
// actually enjoy using" — confusing in the browser tab when the user
// is deep in /dashboard/inventory or /dashboard/orders.
//
// Pages that DO export a title still get the root layout's
// `%s · StockPilot` template; pages that DON'T fall back to
// "Dashboard · StockPilot" instead of the marketing string.
export const metadata: Metadata = {
  title: {
    // Just "Dashboard" — the root layout's `%s · StockPilot` template
    // wraps this into "Dashboard · StockPilot". Putting the full
    // "Dashboard · StockPilot" here was double-wrapping into
    // "Dashboard · StockPilot · StockPilot".
    default: 'Dashboard',
    template: '%s · StockPilot',
  },
};

/** The MFA challenge, coming back to this dashboard page once the code is in. */
async function mfaChallengePath(): Promise<string> {
  const pathname = (await headers()).get('x-pathname') ?? '';
  const qs = pathname.startsWith('/dashboard') ? `?redirect=${encodeURIComponent(pathname)}` : '';
  return `/signin/mfa${qs}`;
}

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // STARTED BEFORE THE CONTEXT RESOLVES, for the same reason as in
  // withContext(): the factor list is a GoTrue round trip that needs nothing
  // from the org context, and waiting for get_request_context() first put two
  // Supabase calls in series ahead of every dashboard render. Request-cached,
  // so the page's withContext() shares this very read. The rejection is
  // observed at creation because requireOrgContext() below can redirect and
  // leave it behind; the Promise.all further down awaits the SAME promise, so
  // an unreadable list still fails this layout closed (error screen, #229).
  const mfaFactorsRead = getMfaFactorsForRequest();
  mfaFactorsRead.catch(() => {});
  // ALSO STARTED FIRST: the session's verified claims, for the enrolled-member
  // gate below. Page renders keep their own key set (the proxy is a separate
  // function), so the first read in a server instance, and the first after
  // auth-js's 10-minute cache expires, fetches it from the Auth server. Started
  // here, that fetch runs alongside the context and the batch below instead of
  // after them. Request-cached, so the page's withContext() takes this same
  // read. It never rejects, and only the gate awaits it: a member with no
  // authenticator is never held by it.
  const claimsRead = getVerifiedSessionClaimsForRequest();
  // Cached: this resolves with the same data the page will use in the
  // same render — zero extra DB round trips beyond the page's own.
  const ctx = await requireOrgContext();
  // Gates the "Platform admin" link in the account menu. Header-based on
  // purpose (perf plan 2026-07-02 P1d): the previous
  // `currentUserIsPlatformAdmin()` made a SECOND GoTrue `auth.getUser()`
  // round-trip on every hard dashboard render just to decide link
  // visibility. The middleware already validated the user and forwards the
  // verified email header (set-after-validation, deleted otherwise, matcher
  // covers all of /dashboard). The real gates on /platform pages/actions
  // still use the live-verified checks — see the trust-chain comment on
  // currentUserIsPlatformAdminFromRequestHeader.
  const platformAdmin = await currentUserIsPlatformAdminFromRequestHeader();

  // The shell's per-viewer preferences are cookies, read here so the first
  // paint already has them: no flash, and no database read.
  const cookieStore = await cookies();
  const initialSidebarHidden = parseSidebarHidden(cookieStore.get(SIDEBAR_HIDDEN_COOKIE)?.value);
  const initialDensity = parseDensity(cookieStore.get(DENSITY_COOKIE)?.value);
  const initialCollapsedSections = parseCollapsedSections(
    cookieStore.get(NAV_COLLAPSED_COOKIE)?.value,
  );

  // Layout-blocking parallel fan-out. Org row, warehouses list, and MFA
  // factors go through request-cached helpers so the dashboard page (or
  // any other page in this layout) reuses the same fetch instead of
  // re-issuing the same Supabase queries in its own Promise.all.
  //
  // Only what the first byte truly needs belongs in this wave. 3-5% of our
  // server's Supabase calls stall 1-8 s on weekday daytimes (logs,
  // 2026-09-22), and the wave waits for its slowest member, so every extra
  // call is one more chance to hold every dashboard page. The bell's unread
  // count used to be one; the bell now reads it in the browser after mount,
  // as it already did to replace this seed with the exact total
  // (notification-bell.tsx).
  const [
    access,
    activeWarehouseId,
    orgRow,
    mfaFactors,
    sessionMemberships,
    warehousesList,
    enabledModuleSet,
  ] = await Promise.all([
    getWarehouseAccess(),
    getActiveWarehouseFilter(),
    getOrgRowForRequest(ctx.organizationId),
    // An ENDED session goes to sign-in; any other failure still fails closed.
    orSessionEnded(mfaFactorsRead),
    // Rank 8 (query hygiene): derived from loadSessionAndContext's single
    // membership query (requireOrgContext above already resolved it in this
    // render) instead of a THIRD organization_members round trip. Same
    // filters (accepted only), same rows, now with logo_url widened into
    // the shared select.
    getSessionMemberships(),
    getWarehousesForRequest(ctx.organizationId),
    // Request-cached: shares ONE organization_modules round-trip with
    // withContext() in the same render. Rows that could not be read come
    // back as a set that cannot be listed (see below), never as "no rows".
    getModulesForRequest(ctx.organizationId),
  ]);

  // Module IDs enabled for this org, serialized as plain strings so the
  // client DashboardShell/Sidebar can reconstruct a Set across the RSC
  // boundary. Core modules are always treated as enabled by the resolver
  // regardless of this list, so a grandfathered org with no rows still gets
  // the full core nav.
  //
  // A module state that could not be read is UNKNOWN, not "off"
  // (`getModulesForRequest` logs the failed read and holds the state in a set
  // that refuses to be listed: lib/modules/module-state). The menu then shows
  // only what is known to be on, which is the core sections (a comp that was
  // read decides every module and comes back as a plain set), and the strip
  // below says the modules could not be checked and offers Try again. Never a
  // fuller nav than the reads showed, and never a core-only nav passed off as
  // the organization's own.
  const moduleStateUnknown = moduleSetUnreadable(enabledModuleSet);
  const enabledModules = moduleStateUnknown ? [] : Array.from(enabledModuleSet);

  const memberships = sessionMemberships
    .map((m) => ({
      id: m.organizationId,
      name: m.name,
      logoUrl: m.logoUrl,
      role: m.role as string,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // ── MFA enforcement ────────────────────────────────────────────────
  // A member the policy requires an authenticator of, with none verified, is
  // sent to set-up (below). The set-up page itself renders with the banner.
  // An org row this member cannot read is held to the strictest policy, not
  // 'optional' (lib/auth/mfa-policy.ts).
  const policy = enforcedMfaPolicy(orgRow);
  const isAdmin = ctx.role === 'owner' || ctx.role === 'admin';
  const mfaRequired = policy === 'all_required' || (policy === 'admins_required' && isAdmin);
  // Whether this member has an authenticator comes from THEIR factor list only
  // (S43a, review round s43ar). The list is a read of the cookie session, like
  // the claims the gate below reads, so a load of the session can refresh it
  // into another account (see the gate's note). The list of an account with no
  // factor would read as "no authenticator" and skip that gate entirely. A list
  // that is not this member's says nothing about them, so they go to the MFA
  // challenge, as any session that has not shown its code does.
  const ownFactors = factorsOf(mfaFactors, ctx.userId);
  if (!ownFactors) redirect(await mfaChallengePath());
  const hasVerifiedFactor = ownFactors.some((f) => f.status === 'verified');
  const showMfaBanner = mfaRequired && !hasVerifiedFactor;

  // Set-up first: a member the policy requires an authenticator of (everyone
  // under all_required; owners and admins under admins_required) who has no
  // verified factor sees only the security settings page until they set one
  // up. Every other dashboard page sends them there. assertPermission in
  // services already blocks changes at AAL1; this keeps the rest of the
  // dashboard's reads behind set-up too.
  //
  // The security page is exempt, and neither it nor the settings layout
  // redirects, so the redirect lands on a page this gate lets through: one
  // hop, never a loop. Chrome stops a page that keeps navigating in a loop
  // ("Throttling navigation to prevent the browser from hanging", a blank
  // screen), which is why the target must never send the member on again
  // (layout.authenticator-set-up.test.tsx follows the redirect to prove it).
  // Sign-out and organization switching are Server Actions on that page's
  // shell, so they stay available.
  if (mfaRequired && !hasVerifiedFactor) {
    const h = await headers();
    const pathname = h.get('x-pathname') ?? '';
    if (!pathname.startsWith('/dashboard/settings/security')) {
      redirect('/dashboard/settings/security?mfa=required');
    }
  }

  // Hard gate for ENROLLED users (HI-6): a verified TOTP factor must be
  // satisfied regardless of org policy — otherwise an attacker with only
  // the password walks into the dashboard at AAL1 under the default
  // 'optional' policy. Same challenge flow policy-required users get:
  // /signin/mfa (outside this layout, exempt in the middleware's
  // signed-in bounce, and renders fine at AAL1 — so no redirect loop).
  // The level is the access token's `aal` claim, read only once the token's
  // signature checks out (lib/auth/verified-claims: a local ES256 check, no
  // Auth round trip once the key set is cached), not
  // getAuthenticatorAssuranceLevel()'s unchecked decode of the cookie. The
  // read has been under way since the top of this layout. An unverifiable
  // token fails CLOSED into the challenge page, which itself skips straight
  // to /dashboard when the session is really AAL2.
  //
  // And only the level of THIS member's session counts: the claims' subject
  // must be the user the context resolved (S43a). The read loads the cookie
  // session on a client of its own, and a load refreshes it with the cookie's
  // own refresh token when the cookie's own `expires_at` says so; nothing
  // signs either field. A member's password alone (an aal1 token) beside the
  // refresh token of another enrolled account's session would verify THAT
  // account's aal2. Started where they are, the claims read and the factor
  // list load alongside the context's identity read, which then refutes such
  // a session; with both inputs held to the context's user, the gate does not
  // rely on that order.
  if (hasVerifiedFactor) {
    const claims = await claimsRead;
    if (claims?.userId !== ctx.userId || claims.aal !== 'aal2') {
      redirect(await mfaChallengePath());
    }
  }

  const term = resolveTerminology(
    (orgRow?.terminology as Partial<ReturnType<typeof resolveTerminology>>) ?? null,
  );

  // Only managers/admins get the topbar filter — warehouse-scoped users
  // have a forced warehouse and the filter would be a UX dead-end for
  // them. Warehouses list itself comes from the cached helper in the
  // Promise.all above, so this branch is just a no-DB shape mapping.
  const warehouseFilter = access.hasAllAccess
    ? {
        warehouses: warehousesList,
        activeId: activeWarehouseId,
        warehouseLabel: term.warehouse_singular,
        warehousePluralLabel: term.warehouse_plural,
      }
    : undefined;

  return (
    <>
      <InventoryRealtime organizationId={ctx.organizationId} />
      <DashboardShell
        email={ctx.email}
        fullName={ctx.fullName}
        avatarUrl={ctx.avatarUrl}
        userId={ctx.userId}
        organizationId={ctx.organizationId}
        organizationName={ctx.organizationName}
        organizationLogoUrl={orgRow?.logo_url ?? null}
        memberships={memberships}
        userName={ctx.fullName ?? ctx.email}
        userRole={`${userMenuRoleLabel(ctx.role)} · ${ctx.organizationName}`}
        role={ctx.role}
        permissions={ctx.permissions ? [...ctx.permissions] : undefined}
        isPlatformAdmin={platformAdmin}
        initialSidebarHidden={initialSidebarHidden}
        initialDensity={initialDensity}
        initialCollapsedSections={initialCollapsedSections}
        enabledModules={enabledModules}
        navOverrides={orgRow?.nav_overrides ?? null}
        orderStatusConfig={orgRow?.order_status_config ?? null}
        warehouseFilter={warehouseFilter}
      >
        <ImpersonationBanner />
        {showMfaBanner && <MfaRequiredBanner />}
        {moduleStateUnknown && <ModulesUnreadBanner />}
        {children}
        {/* "Last seen" for the platform console (mig 0352). Scope keeps one account or
            organization from throttling another on a shared device; it never leaves
            the browser, and the server stamps the session's own user and org. */}
        <ActivityBeacon scope={`${ctx.userId}:${ctx.organizationId}`} />
      </DashboardShell>
    </>
  );
}
