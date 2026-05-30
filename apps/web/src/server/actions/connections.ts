'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { ConnectionsService } from '@/server/services/connections';
import { ServiceError } from '@/server/services/context';

import { err, ok, type ActionResult, type ConnectorProviderId } from '@stockpilot/core';

// Only QuickBooks ships today; keep the schema tight so an unknown provider
// can't slip past validation into the service layer.
const providerSchema = z.object({
  provider: z.literal('quickbooks'),
});

const accountMappingSchema = z.object({
  provider: z.literal('quickbooks'),
  // QBO account ids are free-text for the MVP (a chart-of-accounts picker is a
  // future enhancement). Empty strings are allowed so an admin can save a
  // partial mapping and fill the rest later.
  billExpense: z.string().max(64).trim(),
  inventoryAsset: z.string().max(64).trim(),
  valuationOffset: z.string().max(64).trim(),
});

function toActionError(e: unknown): ActionResult<never> {
  if (e instanceof ServiceError) return err(e.code, e.message, e.details);
  console.error(e);
  return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
}

/** Begins an OAuth connect; returns the authorize URL for the client to redirect to. */
export async function beginConnectAction(
  input: { provider: ConnectorProviderId },
): Promise<ActionResult<{ authorizeUrl: string }>> {
  const parsed = providerSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid provider');
  try {
    const svc = await ConnectionsService.forCurrentUser();
    const authorizeUrl = await svc.beginConnect(parsed.data.provider);
    revalidatePath('/dashboard/settings/integrations');
    return ok({ authorizeUrl });
  } catch (e) {
    return toActionError(e);
  }
}

/** Disconnects a provider: destroys the Vault secret + marks the row disconnected. */
export async function disconnectAction(
  input: { provider: ConnectorProviderId },
): Promise<ActionResult> {
  const parsed = providerSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid provider');
  try {
    const svc = await ConnectionsService.forCurrentUser();
    await svc.disconnect(parsed.data.provider);
    revalidatePath('/dashboard/settings/integrations');
    return ok(undefined);
  } catch (e) {
    return toActionError(e);
  }
}

/** Persists the QBO chart-of-accounts mapping into settings.accountIds. */
export async function saveAccountMappingAction(
  input: {
    provider: ConnectorProviderId;
    billExpense: string;
    inventoryAsset: string;
    valuationOffset: string;
  },
): Promise<ActionResult> {
  const parsed = accountMappingSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid account mapping');
  const { provider, billExpense, inventoryAsset, valuationOffset } = parsed.data;
  try {
    const svc = await ConnectionsService.forCurrentUser();
    await svc.saveAccountMapping(provider, { billExpense, inventoryAsset, valuationOffset });
    revalidatePath('/dashboard/settings/integrations');
    return ok(undefined);
  } catch (e) {
    return toActionError(e);
  }
}
