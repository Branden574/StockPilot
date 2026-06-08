import 'server-only';

import { API_SCOPES, generateApiKey } from '@/lib/auth/api-key';

import {
  assertModuleEnabled,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';

import { isAdminRole } from '@stockpilot/core';

export interface ApiKeyListRow {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/**
 * Admin-facing management of public API keys (create / list / revoke). Gated on
 * the `api_access` premium module + admin role (matches the RLS floor and the
 * api_access module's manage surface). The raw key is returned ONLY at creation.
 */
export class ApiKeysService {
  constructor(private readonly ctx: ServiceContext) {}
  static async forCurrentUser() {
    return new ApiKeysService(await withContext());
  }

  private gate() {
    assertModuleEnabled(this.ctx, 'api_access');
    if (!isAdminRole(this.ctx.role)) {
      throw new ServiceError('forbidden', 'Only admins can manage API keys.');
    }
  }

  async list(): Promise<ApiKeyListRow[]> {
    this.gate();
    // Never select key_hash — the hash is auth material, not for display.
    const { data, error } = await this.ctx.supabase
      .from('api_keys')
      .select('id, name, key_prefix, scopes, created_at, last_used_at, revoked_at')
      .eq('organization_id', this.ctx.organizationId)
      .order('created_at', { ascending: false });
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      return {
        id: row.id as string,
        name: row.name as string,
        keyPrefix: row.key_prefix as string,
        scopes: (row.scopes as string[] | null) ?? [],
        createdAt: row.created_at as string,
        lastUsedAt: (row.last_used_at as string | null) ?? null,
        revokedAt: (row.revoked_at as string | null) ?? null,
      };
    });
  }

  async create(input: { name: string; scopes: string[] }): Promise<{ id: string; key: string }> {
    this.gate();
    const name = input.name.trim();
    if (!name) throw new ServiceError('validation_error', 'Give the key a name.');
    const scopes = input.scopes.filter((s) => (API_SCOPES as readonly string[]).includes(s));
    if (scopes.length === 0) {
      throw new ServiceError('validation_error', 'Choose at least one scope.');
    }
    const { key, prefix, hash } = generateApiKey();
    const { data, error } = await this.ctx.supabase
      .from('api_keys')
      .insert({
        organization_id: this.ctx.organizationId,
        name,
        key_hash: hash,
        key_prefix: prefix,
        scopes,
        created_by: this.ctx.userId,
      })
      .select('id')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    // Return the raw key exactly once — it's never recoverable after this.
    return { id: (data as { id: string }).id, key };
  }

  async revoke(id: string): Promise<void> {
    this.gate();
    const { error } = await this.ctx.supabase
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .is('revoked_at', null);
    if (error) throw new ServiceError('internal_error', error.message);
  }
}
