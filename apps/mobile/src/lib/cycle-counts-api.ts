import { api } from './api';

/**
 * Thin typed wrappers over the mobile `api()` client for cycle counts — the
 * same "mirror, don't reach into apps/web" posture every other *-api.ts here
 * follows.
 *
 * WHY POSTING MOVED OFF THE RPC (SP-055). The detail screen used to call
 * `supabase.rpc('post_cycle_count')` straight from the device. The RPC applies
 * the variance, but it is only HALF of what posting a count means on the web
 * (CycleCountsService.post):
 *   • assertModuleEnabled('cycle_counts') — an org with the module off could
 *     still post from a stale mobile build;
 *   • assertPermission('stock:adjust') + assertSessionAccess() — the RPC checks
 *     manager role but NOT the warehouse write scope, so a warehouse-scoped
 *     manager could post a count for a warehouse they cannot write to;
 *   • audit('cycle_count.posted') — mobile-posted counts left no audit row;
 *   • dispatchEvent('cycle_count.completed') — no webhook/Slack event fired, so
 *     integrations never heard about a count posted from a phone.
 * Going through the Bearer twin gives the phone the identical path the web
 * takes, and the route hands back copy that is already mapped to a sentence.
 */

/** Envelope returned by POST /api/v1/cycle-counts/[id]/post. */
export interface PostCycleCountResponse {
  ok: boolean;
  cycleCount: unknown;
}

/**
 * Posts a cycle count. Throws `ApiError` (api.ts) on refusal; its `message` is
 * the server's already-user-facing sentence and is safe to show verbatim.
 */
export async function postCycleCount(id: string): Promise<PostCycleCountResponse> {
  return api<PostCycleCountResponse>(`/api/v1/cycle-counts/${id}/post`, {
    method: 'POST',
  });
}
