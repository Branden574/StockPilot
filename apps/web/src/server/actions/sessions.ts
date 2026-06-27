'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { sessionIdFromJwt } from '@/lib/auth/api-context';
import { broadcastToChannel } from '@/lib/realtime/broadcast';
import { audit } from '@/server/services/audit';
import { ServiceError, withContext } from '@/server/services/context';
import { SessionsService } from '@/server/services/sessions';

import { err, ok, type ActionResult } from '@stockpilot/core';

const revokeSchema = z.object({ sessionId: z.string().uuid() });

async function currentSessionId(): Promise<string | null> {
  const ctx = await withContext();
  const {
    data: { session },
  } = await ctx.supabase.auth.getSession();
  return session?.access_token ? sessionIdFromJwt(session.access_token) : null;
}

export async function revokeSessionAction(input: {
  sessionId: string;
}): Promise<ActionResult<null>> {
  const parsed = revokeSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid session id');
  try {
    const ctx = await withContext();
    const svc = new SessionsService(ctx);
    await svc.revoke(parsed.data.sessionId);
    // Live force-logout for the targeted device if it's online.
    await broadcastToChannel(`user:${ctx.userId}:sessions`, 'revoked', {
      sessionIds: [parsed.data.sessionId],
    });
    await audit(
      { event: 'security.session_revoked', entityType: 'session', entityId: parsed.data.sessionId },
      ctx,
    );
    revalidatePath('/dashboard/settings/security');
    return ok(null);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Failed to sign out device');
  }
}

export async function revokeOtherSessionsAction(): Promise<ActionResult<{ revoked: 'others' }>> {
  try {
    const ctx = await withContext();
    const keep = await currentSessionId();
    const svc = new SessionsService(ctx);
    await svc.revokeOthers(keep ?? '00000000-0000-0000-0000-000000000000');
    await broadcastToChannel(`user:${ctx.userId}:sessions`, 'revoked', {
      keepId: keep ?? null,
    });
    await audit({ event: 'security.session_revoked', entityType: 'session', extra: { scope: 'others' } }, ctx);
    revalidatePath('/dashboard/settings/security');
    return ok({ revoked: 'others' });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Failed to sign out devices');
  }
}
