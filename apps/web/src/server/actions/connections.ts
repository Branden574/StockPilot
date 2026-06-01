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

// EasyPost connect: an API key (+ optional webhook signing secret). Both are
// secrets — they go straight to the service, which validates the key and stores
// it in Vault. Never echoed back to the client.
const easyPostConnectSchema = z.object({
  apiKey: z.string().min(1, 'An API key is required.').max(200).trim(),
  webhookSecret: z.string().max(200).trim().optional(),
});

const accountMappingSchema = z.object({
  provider: z.literal('quickbooks'),
  // QBO account ids are free-text for the MVP (a chart-of-accounts picker is a
  // future enhancement). Empty strings are allowed so an admin can save a
  // partial mapping and fill the rest later.
  billExpense: z.string().max(64).trim(),
  inventoryAsset: z.string().max(64).trim(),
  valuationOffset: z.string().max(64).trim(),
  // GL account a closed return's value is credited to (Phase B); the balancing
  // debit is the inventoryAsset account. Optional with a default so saving a
  // mapping from an older form (pre-returnCredit) still parses and leaves it blank.
  returnCredit: z.string().max(64).trim().default(''),
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

/**
 * Connects EasyPost from a pasted API key (+ optional webhook secret). The
 * service validates the key against EasyPost and stores both secrets in Vault;
 * neither is returned to the client. Gated on the shipping module +
 * `shipping:manage` inside the service.
 */
export async function connectEasyPostAction(
  input: { apiKey: string; webhookSecret?: string },
): Promise<ActionResult> {
  const parsed = easyPostConnectSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid EasyPost credentials');
  }
  try {
    const svc = await ConnectionsService.forCurrentUser();
    await svc.connectApiKey('easypost', parsed.data.apiKey, parsed.data.webhookSecret);
    revalidatePath('/dashboard/settings/integrations');
    return ok(undefined);
  } catch (e) {
    return toActionError(e);
  }
}

/** Disconnects EasyPost: destroys the Vault secret + marks the row disconnected. */
export async function disconnectEasyPostAction(): Promise<ActionResult> {
  try {
    const svc = await ConnectionsService.forCurrentUser();
    await svc.disconnect('easypost');
    revalidatePath('/dashboard/settings/integrations');
    return ok(undefined);
  } catch (e) {
    return toActionError(e);
  }
}

const replaySyncSchema = z.object({
  id: z.string().uuid('Invalid sync id.'),
});

/**
 * Replays a dead-lettered/errored connector export: resets the
 * connection_sync_log row to 'pending' so the drainer re-picks it. Org-scoped +
 * admin-gated (integrations:manage OR shipping:manage) inside the service.
 */
export async function replaySyncAction(
  input: { id: string },
): Promise<ActionResult> {
  const parsed = replaySyncSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid sync id');
  try {
    const svc = await ConnectionsService.forCurrentUser();
    await svc.replaySync(parsed.data.id);
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
    returnCredit?: string;
  },
): Promise<ActionResult> {
  const parsed = accountMappingSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid account mapping');
  const { provider, billExpense, inventoryAsset, valuationOffset, returnCredit } = parsed.data;
  try {
    const svc = await ConnectionsService.forCurrentUser();
    await svc.saveAccountMapping(provider, {
      billExpense,
      inventoryAsset,
      valuationOffset,
      returnCredit,
    });
    revalidatePath('/dashboard/settings/integrations');
    return ok(undefined);
  } catch (e) {
    return toActionError(e);
  }
}
