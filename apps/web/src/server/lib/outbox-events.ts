import 'server-only';

import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';

import { can, type Permission } from '@stockpilot/core';

import type { ServiceContext } from '@/server/services/context';

/**
 * Connector export events (outbox_events, drained to QuickBooks, Sage Intacct
 * and Zendesk) are recorded here and nowhere else in the app.
 *
 * Every event is written through the service client, with the topic and
 * payload each caller has always sent and the dedupe key `<topic>:<aggregate
 * id>` (the id in lower case, so one document sent in another letter case is
 * still one event; every id the app holds is already lower case), after the
 * action that causes it has succeeded. The organization is never taken from
 * a request:
 *
 *   - publishOutboxEvent(ctx, ...) is for a signed-in member's action. The
 *     organization is the checked service context's, and the context must
 *     hold the permission the topic's action requires (EVENT_TOPICS), which
 *     the calling service has already asserted before the action ran. A
 *     context without it records nothing and the refusal is reported.
 *   - publishOutboxEventForResolvedOrganization(...) is for the two paths
 *     with no signed-in member (a requester's return, a public order
 *     request). The organization is the one the server resolved from the
 *     return token, the portal or member order, or the public request link.
 *     Only those two topics are accepted, and
 *     src/test/outbox-publish-sites.guard.test.ts pins its callers.
 *
 * Best effort, as each caller always was: neither function throws, so a
 * failed write never undoes the action that already succeeded. A failed
 * write (an error answer, a thrown call, a missing service key) is reported
 * under the tag `outbox.publish` instead of being dropped. A repeated key is
 * not an error: the function answers no id and the first event stands.
 */

/** Each topic the app records: the aggregate it names, and the permission of
 *  the member action that records it (null: no member action records it). */
const EVENT_TOPICS = {
  'purchase_order.ordered': {
    aggregateType: 'purchase_order',
    permission: 'purchase_orders:manage',
  },
  'receipt.posted': { aggregateType: 'receipt', permission: 'stock:adjust' },
  'return.created': { aggregateType: 'return', permission: 'returns:manage' },
  'return.closed': { aggregateType: 'return', permission: 'returns:manage' },
  'order.problem': { aggregateType: 'order_request', permission: 'orders:approve' },
  'public_request.created': { aggregateType: 'order_request', permission: null },
} as const satisfies Record<string, { aggregateType: string; permission: Permission | null }>;

export type OutboxTopic = keyof typeof EVENT_TOPICS;

/** Topics a signed-in member's action records. */
export type MemberOutboxTopic = {
  [T in OutboxTopic]: (typeof EVENT_TOPICS)[T]['permission'] extends null ? never : T;
}[OutboxTopic];

/** Topics recorded with no signed-in member: a requester's return and a public order request. */
export type ResolvedOutboxTopic = 'return.created' | 'public_request.created';

const RESOLVED_TOPICS: ReadonlySet<string> = new Set<ResolvedOutboxTopic>([
  'return.created',
  'public_request.created',
]);

/** How the server resolved the organization of an event with no signed-in member. */
export type ResolvedOrganization = {
  organizationId: string;
  /** requester_return: the order behind a return token, a portal order or a
   *  member's own order (returns.ts createRequesterRpc); public_request_link:
   *  the organization of an open public request link (the public order route). */
  resolvedBy: 'requester_return' | 'public_request_link';
};

export interface OutboxEventInput<T extends OutboxTopic> {
  topic: T;
  /** The purchase order, receipt, return or order the event is about. */
  aggregateId: string;
  payload: Record<string, unknown>;
}

const TAG = 'outbox.publish';

/**
 * Records one export event for a signed-in member's action, through the
 * service client, in the organization of `ctx`. Call it only after the
 * action it reports has succeeded. Never throws.
 */
export async function publishOutboxEvent<T extends MemberOutboxTopic>(
  ctx: ServiceContext,
  event: OutboxEventInput<T>,
): Promise<void> {
  const permission = EVENT_TOPICS[event.topic]?.permission;
  if (!permission || !can(ctx, permission)) {
    void reportError(
      new Error(
        `export event not recorded: the context does not hold ${permission ?? 'a member permission'}`,
      ),
      {
        tag: TAG,
        organizationId: ctx.organizationId,
        extra: { topic: event.topic, aggregateId: event.aggregateId, reason: 'permission' },
      },
    );
    return;
  }
  await write(ctx.organizationId, event);
}

/**
 * Records one export event with no signed-in member (a requester's return,
 * a public order request), through the service client, in the organization
 * the server resolved. Never throws.
 */
export async function publishOutboxEventForResolvedOrganization<T extends ResolvedOutboxTopic>(
  resolved: ResolvedOrganization,
  event: OutboxEventInput<T>,
): Promise<void> {
  if (!RESOLVED_TOPICS.has(event.topic)) {
    void reportError(new Error('export event not recorded: topic not recorded without a member'), {
      tag: TAG,
      organizationId: resolved.organizationId,
      extra: {
        topic: event.topic,
        aggregateId: event.aggregateId,
        reason: 'topic',
        resolvedBy: resolved.resolvedBy,
      },
    });
    return;
  }
  await write(resolved.organizationId, event);
}

async function write(organizationId: string, event: OutboxEventInput<OutboxTopic>): Promise<void> {
  const extra = { topic: event.topic, aggregateId: event.aggregateId };
  try {
    const { error } = await createAdminClient().rpc('publish_outbox', {
      p_org_id: organizationId,
      p_topic: event.topic,
      p_aggregate_type: EVENT_TOPICS[event.topic].aggregateType,
      p_aggregate_id: event.aggregateId,
      p_payload: event.payload,
      p_dedupe_key: `${event.topic}:${event.aggregateId.toLowerCase()}`,
    });
    if (error) {
      void reportError(error, {
        tag: TAG,
        organizationId,
        extra: { ...extra, reason: 'write_failed' },
      });
    }
  } catch (err) {
    void reportError(err, { tag: TAG, organizationId, extra: { ...extra, reason: 'threw' } });
  }
}
