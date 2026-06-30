'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { ConnectionsService } from '@/server/services/connections';
import { ServiceError } from '@/server/services/context';

import { err, ok, type ActionResult } from '@stockpilot/core';

const connectSchema = z.object({
  subdomain: z.string().min(1).max(120),
  email: z.string().email().max(254),
  apiToken: z.string().min(1).max(512),
});

/**
 * Connects Zendesk from a pasted subdomain + agent email + API token. The
 * service validates the credentials and stores the token in Vault; it is never
 * returned to the client. Gated on the zendesk module + admin permission inside
 * the service.
 */
export async function connectZendeskAction(
  input: z.input<typeof connectSchema>,
): Promise<ActionResult> {
  const parsed = connectSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid Zendesk credentials.');
  }
  try {
    const svc = await ConnectionsService.forCurrentUser();
    await svc.connectZendesk(parsed.data);
    revalidatePath('/dashboard/zendesk');
    return ok(undefined);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

const subdomainSchema = z.object({ subdomain: z.string().min(1).max(120) });

/**
 * Saves ONLY the org's Zendesk subdomain (no API token) — powers the embedded /
 * SSO path for managed Zendesk accounts that can't issue API credentials. Gated
 * on the zendesk module + admin permission inside the service.
 */
export async function setZendeskSubdomainAction(
  input: z.input<typeof subdomainSchema>,
): Promise<ActionResult> {
  const parsed = subdomainSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Enter your Zendesk subdomain.');
  }
  try {
    const svc = await ConnectionsService.forCurrentUser();
    await svc.setZendeskSubdomain(parsed.data.subdomain);
    revalidatePath('/dashboard/zendesk');
    return ok(undefined);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

/** Disconnects Zendesk: destroys the Vault secret + marks the row disconnected. */
export async function disconnectZendeskAction(): Promise<ActionResult> {
  try {
    const svc = await ConnectionsService.forCurrentUser();
    await svc.disconnect('zendesk');
    revalidatePath('/dashboard/zendesk');
    return ok(undefined);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
