-- ============================================================================
-- 0148_connector_drain_candidates.sql — bounded candidate selection for the
-- outbox drainer (head-of-line starvation fix).
--
-- WHY
-- ---
-- The drainer previously selected the oldest-N outbox_events for an org+topics
-- and excluded already-terminal (success/dead) deliveries by fetching ALL such
-- outbox_event_ids from connection_sync_log and passing them as a PostgREST
-- not.in.(uuid,uuid,...) filter. That exclusion list was:
--   - unbounded + subject to PostgREST's db.max-rows cap (default 1000) with no
--     .order(), so once a connection accrued >1000 terminal deliveries the list
--     silently truncated and the un-excluded oldest terminal events refilled the
--     oldest-N window — re-introducing head-of-line starvation non-deterministically;
--   - serialized into a multi-kilobyte request URL (proxy/URL-length risk);
--   - unsupported by any index (connection_sync_log_due_idx only covers
--     status in (pending,error)), forcing a per-connection scan each tick.
--
-- This RPC inverts the query so the candidate set is bounded by WORK-REMAINING
-- rather than work-done. It returns the oldest-first outbox_events for an
-- org+topics that are NOT yet terminal for this connection AND are not an error
-- row still inside its backoff window — directly off the table, no IN-list.
--
-- SECURITY
-- --------
-- SECURITY DEFINER so the service-role worker can span connection_sync_log /
-- outbox_events. It returns NO secret material (only outbox event columns, which
-- the worker already reads). CREATE FUNCTION grants EXECUTE to PUBLIC by default
-- and PUBLIC is inherited by authenticated/anon, so we revoke FROM public first
-- (matching 0146/0125/0127/0129) and grant only to service_role.
-- ============================================================================

set check_function_bodies = off;

create or replace function public.connector_drain_candidates(
  p_connection_id   uuid,
  p_organization_id uuid,
  p_topics          text[],
  p_now             timestamptz,
  p_limit           int default 200
)
returns setof public.outbox_events
language sql
security definer
set search_path = public
as $$
  select e.*
  from public.outbox_events e
  where e.organization_id = p_organization_id
    and e.topic = any (p_topics)
    -- exclude events already terminal (success/dead) for THIS connection, and
    -- error rows whose backoff window has not elapsed. Events with no log row
    -- (never attempted) and due error rows are eligible.
    and not exists (
      select 1
      from public.connection_sync_log l
      where l.connection_id = p_connection_id
        and l.outbox_event_id = e.id
        and (
          l.status in ('success', 'dead')
          or (l.status = 'error' and l.next_attempt_at is not null and l.next_attempt_at > p_now)
        )
    )
  order by e.created_at asc
  limit greatest(1, p_limit);
$$;

revoke all on function public.connector_drain_candidates(uuid, uuid, text[], timestamptz, int) from public, authenticated, anon;
grant execute on function public.connector_drain_candidates(uuid, uuid, text[], timestamptz, int) to service_role;

-- Supporting index for the NOT EXISTS point-lookup + the candidate ordering.
-- The NOT EXISTS correlates on (connection_id, outbox_event_id); the existing
-- unique (connection_id, outbox_event_id) already covers that probe. The
-- candidate scan walks outbox_events by (organization_id, topic, created_at);
-- outbox_topic_idx (organization_id, topic, created_at desc) from 0016 serves it
-- (a backwards index scan satisfies the asc order). No new index required.
