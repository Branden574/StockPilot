import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => undefined) }));

import { ApiKeysService } from './api-keys';
import { audit } from './audit';
import { dispatchEvent } from './integration-events';

const WITH_API = new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'api_access']);
const KEY_ID = '7a000000-0000-4000-8000-00000000000a';

function service(
  results: Parameters<typeof makeSupabaseStub>[0],
  mfa: { mfaRequired: boolean; mfaSatisfied: boolean },
) {
  const stub = makeSupabaseStub(results);
  const svc = new ApiKeysService(
    makeServiceContext(stub.client, { role: 'admin', enabledModules: WITH_API, ...mfa }) as never,
  );
  return { stub, svc };
}

const REQUIRED_UNSATISFIED = { mfaRequired: true, mfaSatisfied: false };
const REQUIRED_SATISFIED = { mfaRequired: true, mfaSatisfied: true };

const CREATED = { 'api_keys.insert': { data: { id: KEY_ID }, error: null } };
const REVOKED = { 'api_keys.update': { data: { name: 'Ledger sync' }, error: null } };

beforeEach(() => vi.clearAllMocks());

describe('ApiKeysService gives the authenticator answer before a key is made or revoked', () => {
  it('create, required and not satisfied: mfa_required, nothing written or announced', async () => {
    const { stub, svc } = service(CREATED, REQUIRED_UNSATISFIED);
    await expect(
      svc.create({ name: 'Ledger sync', scopes: ['inventory:read'] }),
    ).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'mfa_required' },
    });
    expect(stub.fromCalls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('revoke, required and not satisfied: mfa_required, nothing written or announced', async () => {
    const { stub, svc } = service(REVOKED, REQUIRED_UNSATISFIED);
    await expect(svc.revoke(KEY_ID)).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'mfa_required' },
    });
    expect(stub.fromCalls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('create, required and satisfied: the key is made and returned once', async () => {
    const { stub, svc } = service(CREATED, REQUIRED_SATISFIED);
    const res = await svc.create({ name: 'Ledger sync', scopes: ['inventory:read'] });
    expect(res.id).toBe(KEY_ID);
    expect(res.key.length).toBeGreaterThan(20);
    expect(stub.chains.get('api_keys.insert')).toBeDefined();
  });

  it('revoke, required and satisfied: the key is revoked', async () => {
    const { stub, svc } = service(REVOKED, REQUIRED_SATISFIED);
    await svc.revoke(KEY_ID);
    expect(stub.chainArgs.get('api_keys.update')).toContainEqual(['id', KEY_ID]);
  });

  it('the list stays readable under the banner: listing is a read', async () => {
    const { svc } = service({ 'api_keys.select': { data: [], error: null } }, REQUIRED_UNSATISFIED);
    await expect(svc.list()).resolves.toEqual([]);
  });

  it('a member who is not an admin is still refused in the same words', async () => {
    const stub = makeSupabaseStub(CREATED);
    const svc = new ApiKeysService(
      makeServiceContext(stub.client, { role: 'staff', enabledModules: WITH_API }) as never,
    );
    await expect(
      svc.create({ name: 'Ledger sync', scopes: ['inventory:read'] }),
    ).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Only admins can manage API keys.',
    });
    expect(stub.fromCalls).toEqual([]);
  });
});

describe('ApiKeysService writes an audit row when a key is made or revoked', () => {
  it('create: api_key.created with the key id, its name and its scopes, and no key material', async () => {
    const { svc } = service(CREATED, REQUIRED_SATISFIED);
    const res = await svc.create({
      name: 'Ledger sync',
      scopes: ['inventory:read', 'orders:read'],
    });
    expect(audit).toHaveBeenCalledTimes(1);
    const [payload, ctx] = vi.mocked(audit).mock.calls[0]!;
    expect(payload).toEqual({
      event: 'api_key.created',
      entityType: 'api_key',
      entityId: KEY_ID,
      extra: { name: 'Ledger sync', scopes: ['inventory:read', 'orders:read'] },
    });
    expect(ctx).toBeDefined();
    const written = JSON.stringify(payload);
    expect(written).not.toContain(res.key);
    expect(written).not.toContain(res.key.slice(0, 12));
    expect(written).not.toMatch(/hash|prefix/i);
  });

  it('revoke: api_key.revoked with the key id and its name', async () => {
    const { svc } = service(REVOKED, REQUIRED_SATISFIED);
    await svc.revoke(KEY_ID);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]![0]).toEqual({
      event: 'api_key.revoked',
      entityType: 'api_key',
      entityId: KEY_ID,
      extra: { name: 'Ledger sync' },
    });
  });

  it('a second revoke of a key already revoked writes no second row', async () => {
    const { svc } = service(
      {
        'api_keys.update': { data: null, error: null },
        'api_keys.select': {
          data: { id: KEY_ID, revoked_at: '2026-11-01T00:00:00Z' },
          error: null,
        },
      },
      REQUIRED_SATISFIED,
    );
    await svc.revoke(KEY_ID);
    expect(audit).not.toHaveBeenCalled();
  });
});
