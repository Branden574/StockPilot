import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * OrderAttachmentsService.list signs a full URL and a grid thumb per
 * attachment in parallel. On a cold cache every one is a storage request; they
 * wait for a signing slot (at most 20 in flight), and a failed sign stays
 * visible to the caller as a null url.
 */

const { createSignedUrl } = vi.hoisted(() => ({ createSignedUrl: vi.fn() }));
vi.mock('next/cache', () => ({ unstable_cache: vi.fn((fn: unknown) => fn) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl }) } }),
}));

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import type { ServiceContext } from './context';
import { OrderAttachmentsService } from './order-attachments';

beforeEach(() => {
  createSignedUrl.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('OrderAttachmentsService.list signing', () => {
  it('keeps at most 20 signing requests in flight and returns null for a failed sign', async () => {
    let inFlight = 0;
    let peak = 0;
    createSignedUrl.mockImplementation(async (path: string, _ttl: number, opts?: unknown) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      if (!opts && path.endsWith('/7.jpg'))
        return { data: null, error: { message: 'Bad Gateway' } };
      return { data: { signedUrl: `https://signed/${path}` }, error: null };
    });
    const rows = Array.from({ length: 40 }, (_, i) => ({
      id: `att-${i}`,
      order_request_id: 'ord-1',
      storage_path: `org-1/orders/ord-1/${i}.jpg`,
      content_type: 'image/jpeg',
      kind: 'dropoff_photo',
      created_at: '2026-09-23T00:00:00Z',
    }));
    const stub = makeSupabaseStub({
      'order_request_attachments.select': { data: rows, error: null },
    });
    const svc = new OrderAttachmentsService(
      makeServiceContext(stub.client, { organizationId: 'org-1' }) as unknown as ServiceContext,
    );

    const list = await svc.list('ord-1');

    expect(createSignedUrl).toHaveBeenCalledTimes(80);
    expect(peak).toBe(20);
    expect(list).toHaveLength(40);
    expect(list.find((a) => a.id === 'att-7')?.url).toBeNull();
    expect(list.find((a) => a.id === 'att-8')?.url).toBe('https://signed/org-1/orders/ord-1/8.jpg');
  });
});
