import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

/**
 * Security invariant (listed in scripts/security-test.sh).
 *
 * The one place the app records a connector export event (outbox_events). It
 * writes through the service client, in the organization of the checked
 * context (or the one the server resolved for a requester's return or a
 * public request), with the topic, payload and dedupe key the callers have
 * always sent, and reports a failed write instead of dropping it.
 */

const holder = vi.hoisted(() => ({
  client: null as unknown,
  throwOnCreate: null as Error | null,
  creates: 0,
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    holder.creates += 1;
    if (holder.throwOnCreate) throw holder.throwOnCreate;
    return holder.client;
  },
}));

const reportErrorMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock('@/lib/error-reporter', () => ({ reportError: reportErrorMock }));

import {
  publishOutboxEvent,
  publishOutboxEventForResolvedOrganization,
  type MemberOutboxTopic,
} from './outbox-events';

const ID = 'a0a0a0a0-0000-4000-8000-000000000001';

let admin: SupabaseStub;
let member: SupabaseStub;

function useAdmin(
  results: Parameters<typeof makeSupabaseStub>[0] = {
    'rpc:publish_outbox': { data: 'evt-1', error: null },
  },
) {
  admin = makeSupabaseStub(results);
  holder.client = admin.client;
}

beforeEach(() => {
  holder.throwOnCreate = null;
  holder.creates = 0;
  useAdmin();
  member = makeSupabaseStub({ 'rpc:publish_outbox': { data: 'evt-member', error: null } });
});

function ctx(overrides: Parameters<typeof makeServiceContext>[1] = {}) {
  return makeServiceContext(member.client, {
    organizationId: 'org-checked',
    role: 'manager',
    ...overrides,
  }) as never;
}

describe('publishOutboxEvent: a signed-in member action', () => {
  it.each<[MemberOutboxTopic, string]>([
    ['purchase_order.ordered', 'purchase_order'],
    ['receipt.posted', 'receipt'],
    ['return.created', 'return'],
    ['return.closed', 'return'],
    ['order.problem', 'order_request'],
  ])(
    'records %s on the service client with the topic, payload and key <topic>:<id>',
    async (topic, aggregateType) => {
      const payload = { a: 1, b: 'two', c: null, d: { e: [3] } };
      await publishOutboxEvent(ctx(), { topic, aggregateId: ID, payload });
      expect(holder.creates).toBe(1);
      expect(admin.rpcCalls).toEqual([
        {
          name: 'publish_outbox',
          args: {
            p_org_id: 'org-checked',
            p_topic: topic,
            p_aggregate_type: aggregateType,
            p_aggregate_id: ID,
            p_payload: payload,
            p_dedupe_key: `${topic}:${ID}`,
          },
        },
      ]);
      // The payload goes as given, not copied or reshaped.
      expect((admin.rpcCalls[0]!.args as { p_payload: unknown }).p_payload).toBe(payload);
      // The member's own client records nothing.
      expect(member.rpcCalls).toEqual([]);
      expect(reportErrorMock).not.toHaveBeenCalled();
    },
  );

  it('takes the organization from the checked context, whatever the payload names', async () => {
    await publishOutboxEvent(ctx({ organizationId: 'org-active' }), {
      topic: 'order.problem',
      aggregateId: ID,
      payload: { organizationId: 'org-other', p_org_id: 'org-other' },
    });
    expect((admin.rpcCalls[0]!.args as { p_org_id: string }).p_org_id).toBe('org-active');
  });

  it("records nothing, and reports it, when the context does not hold the topic's permission", async () => {
    // Staff hold none of purchase_orders:manage, returns:manage, orders:approve.
    for (const topic of [
      'purchase_order.ordered',
      'return.created',
      'return.closed',
      'order.problem',
    ] as const) {
      await publishOutboxEvent(ctx({ role: 'staff' }), { topic, aggregateId: ID, payload: {} });
    }
    // A manager whose stock:adjust was taken away.
    await publishOutboxEvent(ctx({ permissions: new Set(['purchase_orders:manage']) }), {
      topic: 'receipt.posted',
      aggregateId: ID,
      payload: {},
    });
    expect(holder.creates).toBe(0);
    expect(admin.rpcCalls).toEqual([]);
    expect(member.rpcCalls).toEqual([]);
    expect(reportErrorMock).toHaveBeenCalledTimes(5);
    expect(reportErrorMock.mock.calls[0]![1]).toMatchObject({
      tag: 'outbox.publish',
      organizationId: 'org-checked',
      extra: { topic: 'purchase_order.ordered', aggregateId: ID, reason: 'permission' },
    });
  });

  it('a topic recorded only without a member is refused for a member context', async () => {
    await publishOutboxEvent(ctx({ role: 'owner' }), {
      topic: 'public_request.created' as never,
      aggregateId: ID,
      payload: {},
    });
    expect(admin.rpcCalls).toEqual([]);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
  });
});

describe('publishOutboxEventForResolvedOrganization: a requester return or a public request', () => {
  it.each([
    ['return.created', 'return', 'requester_return'],
    ['public_request.created', 'order_request', 'public_request_link'],
  ] as const)(
    'records %s on the service client in the resolved organization',
    async (topic, aggregateType, resolvedBy) => {
      const payload = { orderRequestId: ID };
      await publishOutboxEventForResolvedOrganization(
        { organizationId: 'org-resolved', resolvedBy },
        { topic, aggregateId: ID, payload },
      );
      expect(admin.rpcCalls).toEqual([
        {
          name: 'publish_outbox',
          args: {
            p_org_id: 'org-resolved',
            p_topic: topic,
            p_aggregate_type: aggregateType,
            p_aggregate_id: ID,
            p_payload: payload,
            p_dedupe_key: `${topic}:${ID}`,
          },
        },
      ]);
      expect(reportErrorMock).not.toHaveBeenCalled();
    },
  );

  it.each(['purchase_order.ordered', 'receipt.posted', 'return.closed', 'order.problem'])(
    'refuses %s, which only a member action records, and reports it',
    async (topic) => {
      await publishOutboxEventForResolvedOrganization(
        { organizationId: 'org-resolved', resolvedBy: 'public_request_link' },
        { topic: topic as never, aggregateId: ID, payload: {} },
      );
      expect(holder.creates).toBe(0);
      expect(admin.rpcCalls).toEqual([]);
      expect(reportErrorMock).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tag: 'outbox.publish',
          extra: expect.objectContaining({ reason: 'topic' }),
        }),
      );
    },
  );
});

describe('the dedupe key names the document in lower case', () => {
  const UPPER = ID.toUpperCase();

  it('a member event for an upper-case id has the same key as for the lower-case id', async () => {
    await publishOutboxEvent(ctx(), {
      topic: 'purchase_order.ordered',
      aggregateId: UPPER,
      payload: {},
    });
    await publishOutboxEvent(ctx(), {
      topic: 'purchase_order.ordered',
      aggregateId: ID,
      payload: {},
    });
    const keys = admin.rpcCalls.map((c) => (c.args as { p_dedupe_key: string }).p_dedupe_key);
    expect(keys).toEqual([`purchase_order.ordered:${ID}`, `purchase_order.ordered:${ID}`]);
  });

  it('a member-free event for an upper-case id has the same key as for the lower-case id', async () => {
    const resolved = { organizationId: 'org-resolved', resolvedBy: 'public_request_link' } as const;
    await publishOutboxEventForResolvedOrganization(resolved, {
      topic: 'public_request.created',
      aggregateId: UPPER,
      payload: {},
    });
    await publishOutboxEventForResolvedOrganization(resolved, {
      topic: 'public_request.created',
      aggregateId: ID,
      payload: {},
    });
    const keys = admin.rpcCalls.map((c) => (c.args as { p_dedupe_key: string }).p_dedupe_key);
    expect(keys).toEqual([`public_request.created:${ID}`, `public_request.created:${ID}`]);
  });
});

describe('a failed write is reported and never thrown', () => {
  const event = {
    topic: 'purchase_order.ordered' as const,
    aggregateId: ID,
    payload: { poId: ID },
  };

  it('an error answer is reported under outbox.publish', async () => {
    const error = { message: 'permission denied for function publish_outbox', code: '42501' };
    useAdmin({ 'rpc:publish_outbox': { data: null, error } });
    await expect(publishOutboxEvent(ctx(), event)).resolves.toBeUndefined();
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock).toHaveBeenCalledWith(error, {
      tag: 'outbox.publish',
      organizationId: 'org-checked',
      extra: { topic: 'purchase_order.ordered', aggregateId: ID, reason: 'write_failed' },
    });
  });

  it('a missing service key (createAdminClient throws) is reported', async () => {
    holder.throwOnCreate = new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    await expect(publishOutboxEvent(ctx(), event)).resolves.toBeUndefined();
    expect(reportErrorMock).toHaveBeenCalledWith(
      holder.throwOnCreate,
      expect.objectContaining({
        tag: 'outbox.publish',
        extra: expect.objectContaining({ reason: 'threw' }),
      }),
    );
    expect(member.rpcCalls).toEqual([]);
  });

  it('a call that rejects (network) is reported', async () => {
    useAdmin({
      'rpc:publish_outbox': () => {
        throw new Error('fetch failed');
      },
    });
    await expect(
      publishOutboxEventForResolvedOrganization(
        { organizationId: 'org-resolved', resolvedBy: 'public_request_link' },
        { topic: 'public_request.created', aggregateId: ID, payload: {} },
      ),
    ).resolves.toBeUndefined();
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'fetch failed' }),
      expect.objectContaining({ tag: 'outbox.publish', organizationId: 'org-resolved' }),
    );
  });

  it('a repeated key (no id back, no error) is not a failure', async () => {
    useAdmin({ 'rpc:publish_outbox': { data: null, error: null } });
    await publishOutboxEvent(ctx(), event);
    expect(admin.rpcCalls).toHaveLength(1);
    expect(reportErrorMock).not.toHaveBeenCalled();
  });
});
