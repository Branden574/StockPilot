-- 0028_push_dispatch.sql
-- ============================================================================
-- Push-notification dispatch. When a row is inserted into
-- public.notifications, fan it out to every Expo push token registered for
-- the recipient via pg_net.http_post → https://exp.host/--/api/v2/push/send.
-- The HTTP call is fire-and-forget; failures don't block the trigger.
--
-- Why pg_net + Expo Push API directly:
--   • Expo's push service handles APNs + FCM for us. No need for our own
--     dispatcher process.
--   • pg_net runs the POST asynchronously so the INSERT that fired the
--     trigger isn't held up by network latency.
-- ============================================================================

-- pg_net ships pre-installed on Supabase; this is a no-op there but keeps
-- self-hosted setups buildable. Functions live in the `net` schema.
create extension if not exists pg_net;

create or replace function public._dispatch_push_for_notification()
returns trigger
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  tok record;
  payload jsonb;
begin
  -- Build one Expo push message per registered token. Drop tokens older
  -- than 120 days as a courtesy: Expo invalidates them automatically and
  -- they'll just bounce.
  for tok in
    select token
      from public.push_tokens
     where user_id = new.user_id
       and last_used_at > now() - interval '120 days'
  loop
    payload := jsonb_build_object(
      'to', tok.token,
      'title', new.title,
      'body', coalesce(new.body, ''),
      'sound', 'default',
      'priority', 'high',
      'channelId', 'default',
      'data', jsonb_build_object('link', new.link, 'type', new.type)
    );

    perform net.http_post(
      url := 'https://exp.host/--/api/v2/push/send',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Accept', 'application/json',
        'Accept-Encoding', 'gzip, deflate'
      ),
      body := payload,
      timeout_milliseconds := 5000
    );
  end loop;
  return new;
exception
  when others then
    -- pg_net misconfigured? Don't break the insert.
    raise warning '[push] dispatch failed for notification %: %', new.id, sqlerrm;
    return new;
end;
$$;

drop trigger if exists trg_notifications_dispatch_push on public.notifications;
create trigger trg_notifications_dispatch_push
  after insert on public.notifications
  for each row execute function public._dispatch_push_for_notification();
