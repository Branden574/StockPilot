import { beforeEach, describe, expect, it, vi } from 'vitest';
const connectZendesk = vi.fn();
const disconnect = vi.fn();
vi.mock('@/server/services/connections', () => ({
  ConnectionsService: { forCurrentUser: vi.fn(async () => ({ connectZendesk, disconnect })) },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
import { ConnectionsService } from '@/server/services/connections';
import { connectZendeskAction, disconnectZendeskAction } from './zendesk';

beforeEach(() => {
  vi.mocked(ConnectionsService.forCurrentUser).mockImplementation(async () => ({ connectZendesk, disconnect }) as never);
  connectZendesk.mockReset();
  disconnect.mockReset();
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
});
