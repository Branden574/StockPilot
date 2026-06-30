import { beforeEach, describe, expect, it, vi } from 'vitest';
const connectZendesk = vi.fn();
const disconnect = vi.fn();
const setZendeskSubdomain = vi.fn();
vi.mock('@/server/services/connections', () => ({
  ConnectionsService: { forCurrentUser: vi.fn(async () => ({ connectZendesk, disconnect, setZendeskSubdomain })) },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
import { ConnectionsService } from '@/server/services/connections';
import { connectZendeskAction, disconnectZendeskAction, setZendeskSubdomainAction } from './zendesk';

beforeEach(() => {
  vi.mocked(ConnectionsService.forCurrentUser).mockImplementation(async () => ({ connectZendesk, disconnect, setZendeskSubdomain }) as never);
  connectZendesk.mockReset();
  disconnect.mockReset();
  setZendeskSubdomain.mockReset();
});

describe('zendesk actions', () => {
  it('rejects empty fields', async () => {
    const res = await connectZendeskAction({ subdomain: '', email: '', apiToken: '' });
    expect(res.ok).toBe(false);
  });
  it('connects with valid input', async () => {
    connectZendesk.mockResolvedValueOnce(undefined);
    const res = await connectZendeskAction({ subdomain: 'acme', email: 'a@acme.com', apiToken: 'tok' });
    expect(res.ok).toBe(true);
    expect(connectZendesk).toHaveBeenCalledOnce();
  });
  it('disconnects', async () => {
    disconnect.mockResolvedValueOnce(undefined);
    const res = await disconnectZendeskAction();
    expect(res.ok).toBe(true);
    expect(disconnect).toHaveBeenCalledWith('zendesk');
  });
  it('rejects an empty subdomain (no service call)', async () => {
    const res = await setZendeskSubdomainAction({ subdomain: '' });
    expect(res.ok).toBe(false);
    expect(setZendeskSubdomain).not.toHaveBeenCalled();
  });
  it('saves a valid subdomain', async () => {
    setZendeskSubdomain.mockResolvedValueOnce(undefined);
    const res = await setZendeskSubdomainAction({ subdomain: 'learn4life' });
    expect(res.ok).toBe(true);
    expect(setZendeskSubdomain).toHaveBeenCalledWith('learn4life');
  });
});
