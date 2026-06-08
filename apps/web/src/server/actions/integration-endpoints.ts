'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { ServiceError } from '@/server/services/context';
import {
  IntegrationEndpointsService,
  INTEGRATION_EVENT_TYPES,
} from '@/server/services/integration-events';

import { err, ok, type ActionResult } from '@stockpilot/core';

const REVALIDATE = '/dashboard/settings/integrations';

function fail(e: unknown): ActionResult<never> {
  if (e instanceof ServiceError) {
    return err(e.code as Parameters<typeof err>[0], e.message);
  }
  return err('internal_error', e instanceof Error ? e.message : 'Something went wrong.');
}

const createSchema = z.object({
  type: z.enum(['webhook', 'slack', 'teams']),
  url: z.string().url().max(2000),
  eventTypes: z.array(z.enum(INTEGRATION_EVENT_TYPES)).min(1),
  description: z.string().max(200).optional(),
});

export async function createIntegrationEndpointAction(
  input: { type: 'webhook' | 'slack' | 'teams'; url: string; eventTypes: string[]; description?: string },
): Promise<ActionResult<{ id: string; secret: string | null }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await IntegrationEndpointsService.forCurrentUser();
    const res = await svc.create(parsed.data);
    revalidatePath(REVALIDATE);
    return ok(res);
  } catch (e) {
    return fail(e);
  }
}

export async function setIntegrationEndpointEnabledAction(
  id: string,
  enabled: boolean,
): Promise<ActionResult<null>> {
  try {
    const svc = await IntegrationEndpointsService.forCurrentUser();
    await svc.setEnabled(id, enabled);
    revalidatePath(REVALIDATE);
    return ok(null);
  } catch (e) {
    return fail(e);
  }
}

export async function deleteIntegrationEndpointAction(id: string): Promise<ActionResult<null>> {
  try {
    const svc = await IntegrationEndpointsService.forCurrentUser();
    await svc.remove(id);
    revalidatePath(REVALIDATE);
    return ok(null);
  } catch (e) {
    return fail(e);
  }
}

export async function rotateIntegrationEndpointSecretAction(
  id: string,
): Promise<ActionResult<{ secret: string }>> {
  try {
    const svc = await IntegrationEndpointsService.forCurrentUser();
    const res = await svc.rotateSecret(id);
    revalidatePath(REVALIDATE);
    return ok(res);
  } catch (e) {
    return fail(e);
  }
}

export async function testIntegrationEndpointAction(
  id: string,
): Promise<ActionResult<{ ok: boolean; status: number | null; error: string | null }>> {
  try {
    const svc = await IntegrationEndpointsService.forCurrentUser();
    const res = await svc.test(id);
    return ok(res);
  } catch (e) {
    return fail(e);
  }
}
