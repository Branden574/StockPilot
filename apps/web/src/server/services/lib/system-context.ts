import 'server-only';

import { timingSafeEqual } from 'node:crypto';

import { reportError } from '@/lib/error-reporter';
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
 * compares `secretsEqual` with the route copies, so the shared version cannot
 * drift from them either (recurring pattern #26). Every route copy of the
 * system context is gone (each copy dropped its read errors); the routes call
 * `loadSystemContext` / `systemContextLoader`, and the same test pins its
 * actor predicate and that no route copy comes back.
 *
 * ═══ WHY THE CONTEXT IS BRANDED ═══
 *
 * A service-role client bypasses RLS, so under it the `.eq('organization_id',
 * …)` filters are the ONLY tenant boundary, and some work must only ever run
 * as the system. The Exception Center's evaluator is one: evaluated with a
 * reader-scoped context it would see a subset of the org, and a sync fed a
 * subset would resolve every occurrence the reader cannot see. So the
 * evaluator takes a `SystemServiceContext`, and the only way to get one is
 * `loadSystemContext` below. The brand is checked at RUNTIME too
 * (`assertSystemContext`), through a WeakSet of the contexts this module
 * issued: a cast, a spread copy or a hand-built object literal is refused.
 */

declare const SYSTEM_CONTEXT: unique symbol;

/** A context issued by `loadSystemContext`, and only by it. */
export type SystemServiceContext = ServiceContext & { readonly [SYSTEM_CONTEXT]: true };

/** Every context this module issued. A WeakSet, so a context that goes out of
 *  scope is collected; membership is identity, so a copy is not a member. */
const issued = new WeakSet<object>();

function brandSystemContext(ctx: ServiceContext): SystemServiceContext {
  issued.add(ctx);
  return ctx as SystemServiceContext;
}

/** True only for a context `loadSystemContext` issued (not a copy of one). */
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
 * How loading the system context for one org ended. `read_failed`: the
 * members read or the modules read failed, so nothing is known (never "no
 * owner", never "no modules"). `no_actor`: both reads answered and the org
 * has no accepted owner or admin to attribute the work to.
 */
export type SystemContextResult =
  { ok: true; ctx: SystemServiceContext } | { ok: false; reason: 'read_failed' | 'no_actor' };

/**
 * Owner-equivalent system context for one org (service-role client, org-scoped
 * queries, MFA satisfied, real enabled-module set), the one every scheduled
 * job uses. The actor predicate: accepted, not an impersonation seat, owner
 * or admin.
 *
 * Either read failing is `read_failed`: before, every copy of this function
 * dropped both errors, so a failed members read looked like an org with no
 * owner (skipped as such) and a failed modules read built a context with an
 * empty module set (the job refused or, worse, ran as if every optional
 * module were off). The result is branded (see above).
 */
export async function loadSystemContext(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
): Promise<SystemContextResult> {
  const [members, mods] = await Promise.all([
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
  if (members.error || mods.error) return { ok: false, reason: 'read_failed' };

  const actor = (members.data ?? [])[0] as { user_id: string; role: string } | undefined;
  if (!actor) return { ok: false, reason: 'no_actor' };

  const enabledModules = new Set(
    ((mods.data ?? []) as Array<{ module_id: string }>).map((m) => m.module_id as ModuleId),
  );

  return {
    ok: true,
    ctx: brandSystemContext({
      organizationId: orgId,
      userId: actor.user_id,
      role: 'owner',
      supabase: admin as unknown as ServiceContext['supabase'],
      mfaRequired: false,
      mfaSatisfied: true,
      isSystem: true,
      enabledModules,
    }),
  };
}

/**
 * loadSystemContext for one run of a scheduled job: a `read_failed` is
 * reported ONCE per run under `reportTag` (no org ids; the count is in the
 * job's log line), and the caller counts that organization as a failure.
 */
export function systemContextLoader(
  admin: ReturnType<typeof createAdminClient>,
  reportTag: string,
): (orgId: string) => Promise<SystemContextResult> {
  let reported = false;
  return async (orgId) => {
    const loaded = await loadSystemContext(admin, orgId);
    if (!loaded.ok && loaded.reason === 'read_failed' && !reported) {
      reported = true;
      void reportError(new Error('The system context could not be read'), { tag: reportTag });
    }
    return loaded;
  };
}

/**
 * loadSystemContext for a caller that wants a context or null: null when the
 * org has no owner or admin, and a thrown ServiceError when a read failed.
 */
export async function buildSystemContext(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
): Promise<SystemServiceContext | null> {
  const loaded = await loadSystemContext(admin, orgId);
  if (loaded.ok) return loaded.ctx;
  if (loaded.reason === 'no_actor') return null;
  throw new ServiceError('internal_error', 'The system context could not be read.', {
    step: 'system_context',
  });
}
