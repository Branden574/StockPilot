import 'server-only';

import { timingSafeEqual } from 'node:crypto';

import type { createAdminClient } from '@/lib/supabase/admin';

import type { ModuleId } from '@stockpilot/core';

import { ServiceError, type ServiceContext } from '../context';

/**
 * The SYSTEM context: an org-scoped, owner-equivalent context on the
 * service-role client, for work that runs as the system rather than as a
 * signed-in person (crons, and tail work scheduled after a response).
 *
 * ═══ WHY THIS MODULE EXISTS ═══
 *
 * `buildSystemContext` and `secretsEqual` were defined privately in every
 * route that needed them (six and nineteen copies). The daily-briefing route
 * test pins that the copies agree and that their number only goes down. New
 * code imports from here instead of pasting a new copy; that same test
 * compares these two functions with the route copies, so the shared versions
 * cannot drift from them either (recurring pattern #26).
 *
 * ═══ WHY THE CONTEXT IS BRANDED ═══
 *
 * A service-role client bypasses RLS, so under it the `.eq('organization_id',
 * …)` filters are the ONLY tenant boundary, and some work must only ever run
 * as the system. The Exception Center's evaluator is one: evaluated with a
 * reader-scoped context it would see a subset of the org, and a sync fed a
 * subset would resolve every occurrence the reader cannot see. So the
 * evaluator takes a `SystemServiceContext`, and the only way to get one is
 * `buildSystemContext` below. The brand is checked at RUNTIME too
 * (`assertSystemContext`), through a WeakSet of the contexts this module
 * issued: a cast, a spread copy or a hand-built object literal is refused.
 */

declare const SYSTEM_CONTEXT: unique symbol;

/** A context issued by `buildSystemContext`, and only by it. */
export type SystemServiceContext = ServiceContext & { readonly [SYSTEM_CONTEXT]: true };

/** Every context this module issued. A WeakSet, so a context that goes out of
 *  scope is collected; membership is identity, so a copy is not a member. */
const issued = new WeakSet<object>();

function brandSystemContext(ctx: ServiceContext): SystemServiceContext {
  issued.add(ctx);
  return ctx as SystemServiceContext;
}

/** True only for a context `buildSystemContext` returned (not a copy of one). */
export function isSystemContext(ctx: unknown): ctx is SystemServiceContext {
  return typeof ctx === 'object' && ctx !== null && issued.has(ctx);
}

/** Refuses any context that is not a system context. */
export function assertSystemContext(ctx: unknown): asserts ctx is SystemServiceContext {
  if (!isSystemContext(ctx)) {
    throw new ServiceError('forbidden', 'This operation runs only as the system.');
  }
}

/**
 * Constant-time comparison of a presented secret with the expected one (a
 * naive `a !== b` leaks the matching prefix length through timing). Same body
 * as the route copies; see the module comment.
 */
export function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Owner-equivalent system context for one org (service-role client, org-scoped
 * queries, MFA satisfied, real enabled-module set). Null when the org has no
 * accepted owner/admin to attribute to.
 *
 * The body is the route copies' body, unchanged, so the actor predicate is the
 * same everywhere: accepted, not an impersonation seat, owner or admin. The
 * only difference is that the result is branded (see above).
 */
export async function buildSystemContext(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
): Promise<SystemServiceContext | null> {
  const [{ data: members }, { data: mods }] = await Promise.all([
    admin
      .from('organization_members')
      .select('user_id, role')
      .eq('organization_id', orgId)
      .in('role', ['owner', 'admin'])
      .not('accepted_at', 'is', null)
      .is('impersonation_expires_at', null)
      .limit(1),
    admin
      .from('organization_modules')
      .select('module_id')
      .eq('organization_id', orgId)
      .eq('enabled', true),
  ]);

  const actor = (members ?? [])[0] as { user_id: string; role: string } | undefined;
  if (!actor) return null;

  const enabledModules = new Set(
    ((mods ?? []) as Array<{ module_id: string }>).map((m) => m.module_id as ModuleId),
  );

  return brandSystemContext({
    organizationId: orgId,
    userId: actor.user_id,
    role: 'owner',
    supabase: admin as unknown as ServiceContext['supabase'],
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules,
  });
}
