import 'server-only';

import type { ConnectorSecrets } from '@stockpilot/core';

/**
 * Minimal shape of a Supabase service-role admin client needed to call the
 * connector secret RPCs. These SECURITY DEFINER RPCs are granted to
 * `service_role` only (see migration 0146) — connector OAuth tokens must NEVER
 * be readable by the browser/client or the `authenticated` role.
 */
type Admin = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

/**
 * Store (insert or update) a connector secret in Supabase Vault and return its
 * Vault secret id. `name` is the Vault secret name used for upsert.
 */
export async function putConnectionSecret(
  admin: Admin,
  name: string,
  secret: ConnectorSecrets,
): Promise<string> {
  const { data, error } = await admin.rpc('connector_secret_put', {
    p_secret: secret,
    p_name: name,
  });
  if (error) throw new Error(`connector_secret_put: ${error.message}`);
  return data as string;
}

/**
 * Read and decrypt a connector secret from Supabase Vault by its secret id.
 * Throws if the secret is missing so callers never operate on absent tokens.
 */
export async function getConnectionSecret(
  admin: Admin,
  secretId: string,
): Promise<ConnectorSecrets> {
  const { data, error } = await admin.rpc('connector_secret_get', {
    p_secret_id: secretId,
  });
  if (error) throw new Error(`connector_secret_get: ${error.message}`);
  if (!data) throw new Error('connector secret not found');
  return data as ConnectorSecrets;
}

/** Permanently delete a connector secret from Supabase Vault by its secret id. */
export async function deleteConnectionSecret(
  admin: Admin,
  secretId: string,
): Promise<void> {
  const { error } = await admin.rpc('connector_secret_delete', {
    p_secret_id: secretId,
  });
  if (error) throw new Error(`connector_secret_delete: ${error.message}`);
}
