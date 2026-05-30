import type { ConnectorSecrets } from '@stockpilot/core';
import { describe, expect, it, vi } from 'vitest';

import {
  deleteConnectionSecret,
  getConnectionSecret,
  putConnectionSecret,
} from './secret-store';

type RpcResult = { data: unknown; error: { message: string } | null };

function makeAdmin(result: RpcResult) {
  const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => result);
  return { admin: { rpc }, rpc };
}

describe('connector secret store', () => {
  it('getConnectionSecret returns typed secrets', async () => {
    const secret: ConnectorSecrets = {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: '2026-01-01',
    };
    const { admin, rpc } = makeAdmin({ data: secret, error: null });

    const out = await getConnectionSecret(admin, 'sec-id');

    expect(out).toEqual(secret);
    expect(out.accessToken).toBe('a');
    expect(rpc).toHaveBeenCalledWith('connector_secret_get', { p_secret_id: 'sec-id' });
  });

  it('getConnectionSecret throws on error', async () => {
    const { admin } = makeAdmin({ data: null, error: { message: 'boom' } });
    await expect(getConnectionSecret(admin, 'sec-id')).rejects.toThrow(
      /connector_secret_get: boom/,
    );
  });

  it('getConnectionSecret throws when data is null', async () => {
    const { admin } = makeAdmin({ data: null, error: null });
    await expect(getConnectionSecret(admin, 'sec-id')).rejects.toThrow(
      /connector secret not found/,
    );
  });

  it('putConnectionSecret returns the uuid and passes p_secret/p_name', async () => {
    const secret: ConnectorSecrets = {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: '2026-01-01',
    };
    const { admin, rpc } = makeAdmin({
      data: '00000000-0000-0000-0000-000000000001',
      error: null,
    });

    const id = await putConnectionSecret(admin, 'my-conn', secret);

    expect(id).toBe('00000000-0000-0000-0000-000000000001');
    expect(rpc).toHaveBeenCalledWith('connector_secret_put', {
      p_secret: secret,
      p_name: 'my-conn',
    });
  });

  it('putConnectionSecret throws on error', async () => {
    const secret: ConnectorSecrets = {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: '2026-01-01',
    };
    const { admin } = makeAdmin({ data: null, error: { message: 'nope' } });
    await expect(putConnectionSecret(admin, 'my-conn', secret)).rejects.toThrow(
      /connector_secret_put: nope/,
    );
  });

  it('deleteConnectionSecret passes p_secret_id and throws on error', async () => {
    const { admin: okAdmin, rpc } = makeAdmin({ data: null, error: null });
    await expect(deleteConnectionSecret(okAdmin, 'sec-id')).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith('connector_secret_delete', { p_secret_id: 'sec-id' });

    const { admin: errAdmin } = makeAdmin({ data: null, error: { message: 'fail' } });
    await expect(deleteConnectionSecret(errAdmin, 'sec-id')).rejects.toThrow(
      /connector_secret_delete: fail/,
    );
  });
});
