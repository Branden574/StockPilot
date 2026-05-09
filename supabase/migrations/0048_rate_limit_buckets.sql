-- ============================================================================
-- 0048_rate_limit_buckets.sql
-- ============================================================================
-- Persistent rate-limit buckets. Replaces the in-memory Map in
-- apps/web/src/lib/rate-limit.ts that doesn't survive Vercel cold
-- starts and isn't shared across regions. The atomic increment_rate_limit()
-- function lets the app get either {allowed: true, count, reset_at}
-- or {allowed: false, ...} in one round trip.
-- ============================================================================

create table public.rate_limit_buckets (
  -- Composite key: caller scope (IP / user id / org id) + the named
  -- limit ("public-order-request:ip", "ai-chat:user", etc.). Same
  -- key string used by checkRateLimit() in the app.
  key                 text primary key,
  count               integer not null default 0,
  window_started_at   timestamptz not null default now(),
  window_ms           integer not null,
  -- Cap so the table can't grow unbounded — opportunistic cleanup
  -- happens inside increment_rate_limit() on every call.
  expires_at          timestamptz not null
);

create index rate_limit_buckets_expires_idx
  on public.rate_limit_buckets(expires_at);

-- ============================================================================
-- increment_rate_limit(p_key, p_limit, p_window_ms)
-- ============================================================================
-- Atomic check-and-increment. Returns:
--   { allowed boolean, count integer, reset_at timestamptz }
-- Behavior:
--   - If no row exists OR the existing window has expired, create/reset.
--     count=1, allowed=true.
--   - If the existing window is active and count < limit, increment.
--     allowed=true.
--   - Otherwise allowed=false.
-- ============================================================================
create or replace function public.increment_rate_limit(
  p_key       text,
  p_limit     integer,
  p_window_ms integer
)
returns table (allowed boolean, count integer, reset_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now           timestamptz := now();
  v_row           public.rate_limit_buckets%rowtype;
  v_window_ends   timestamptz;
begin
  -- Opportunistic cleanup: drop a handful of expired rows on every
  -- call so the table stays bounded without a separate cron.
  delete from public.rate_limit_buckets
   where expires_at < v_now - interval '1 minute'
   limit 50;

  select * into v_row
    from public.rate_limit_buckets
   where key = p_key
   for update;

  if not found then
    v_window_ends := v_now + (p_window_ms || ' milliseconds')::interval;
    insert into public.rate_limit_buckets (key, count, window_started_at, window_ms, expires_at)
    values (p_key, 1, v_now, p_window_ms, v_window_ends);
    return query select true, 1, v_window_ends;
    return;
  end if;

  v_window_ends := v_row.window_started_at + (v_row.window_ms || ' milliseconds')::interval;

  -- Window expired — reset.
  if v_window_ends <= v_now then
    v_window_ends := v_now + (p_window_ms || ' milliseconds')::interval;
    update public.rate_limit_buckets
       set count = 1,
           window_started_at = v_now,
           window_ms = p_window_ms,
           expires_at = v_window_ends
     where key = p_key;
    return query select true, 1, v_window_ends;
    return;
  end if;

  -- Window active but at the cap.
  if v_row.count >= p_limit then
    return query select false, v_row.count, v_window_ends;
    return;
  end if;

  -- Increment.
  update public.rate_limit_buckets
     set count = v_row.count + 1
   where key = p_key;
  return query select true, v_row.count + 1, v_window_ends;
end;
$$;

-- Allow authenticated callers to invoke. The function runs as definer
-- so the caller doesn't need RLS access to the table itself.
grant execute on function public.increment_rate_limit(text, integer, integer)
  to authenticated, anon;

alter table public.rate_limit_buckets enable row level security;
-- No policies — all access goes through the SECURITY DEFINER function.
