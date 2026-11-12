'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { API_SCOPES } from '@/lib/auth/api-key';
import { rethrowControlFlow } from '@/lib/control-flow';
import { actionErrorResult } from '@/server/lib/action-error-result';
import { ApiKeysService } from '@/server/services/api-keys';

import { err, ok, type ActionResult } from '@stockpilot/core';

const REVALIDATE = '/dashboard/settings/integrations';

function fail(e: unknown): ActionResult<never> {
  rethrowControlFlow(e);
  return actionErrorResult(e, 'actions.api_keys');
}

const createSchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(API_SCOPES)).min(1),
});

export async function createApiKeyAction(
  input: { name: string; scopes: string[] },
): Promise<ActionResult<{ id: string; key: string }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await ApiKeysService.forCurrentUser();
    const res = await svc.create(parsed.data);
    revalidatePath(REVALIDATE);
    return ok(res);
  } catch (e) {
    return fail(e);
  }
}

export async function revokeApiKeyAction(id: string): Promise<ActionResult<null>> {
  try {
    const svc = await ApiKeysService.forCurrentUser();
    await svc.revoke(id);
    revalidatePath(REVALIDATE);
    return ok(null);
  } catch (e) {
    return fail(e);
  }
}
