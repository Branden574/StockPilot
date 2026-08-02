-- 0313_stop_notifying_disabled_accounts.sql
-- Closes a Critical found in the fix-wave re-review owed after the account-
-- disable program (0308-0312) shipped: a disabled account still receives
-- LIVE operational push notifications — lock-screen banners carrying PO
-- numbers, low-stock SKUs, order-lifecycle detail and a deep link back into
-- the product. 0308 only stamps user_profiles.disabled_at; it never touches
-- organization_members, so a disabled owner/admin/manager stays a live
-- notification recipient in every path that resolves recipients from that
-- table.
--
-- ── THE TWO FUNCTIONS, AND WHY BOTH ─────────────────────────────────────────
-- public._dispatch_push_for_notification()  (0028) — the AFTER INSERT trigger
--   on public.notifications. This is the UNIVERSAL push fan-out choke point:
--   every notification row, regardless of which of the eleven writer
--   call-sites across the migration history inserted it (the JS
--   createNotification() path included), fires this trigger. It selects
--   public.push_tokens for new.user_id and POSTs to Expo — with no
--   disabled_at check. Guarding HERE closes push for every writer in one
--   place, independent of how each writer picked its recipients.
--
-- public._notify_recipients(p_org uuid)  (0025) — the shared resolver most
--   (not all — see below) SQL trigger writers call to choose in-app
--   recipients: org members with role in (owner, admin, manager) and
--   accepted_at not null. No disabled_at check either. Guarding this closes
--   the IN-APP row (not just the push) for every writer that calls it.
--
-- ── WHY GUARDING _notify_recipients ALONE IS NOT ENOUGH ─────────────────────
-- Two of the writer call-sites resolve at least one recipient INLINE rather
-- than through _notify_recipients:
--   * _notify_po_status (0092) and _notify_receipt_posted (0157) both UNION
--     a specific column (new.created_by / v_po.created_by) into the
--     _notify_recipients(org) set.
--   * _notify_order_request_changes (latest body: 0265) pings
--     new.requester_user_id directly for the requester-facing status
--     branch — it never calls _notify_recipients for that branch.
--   * _notify_cycle_count_assigned (0042) pings new.assigned_to directly —
--     it never calls _notify_recipients at all.
-- A disabled requester/assignee/PO-creator would still get an in-app row
-- from those inline branches even after this migration (see the follow-up
-- note in the report). What this migration guarantees UNCONDITIONALLY,
-- for every one of those inline paths too, is that NONE of them can still
-- push a lock-screen banner to a disabled device, because
-- _dispatch_push_for_notification is downstream of all of them and is the
-- one and only place a push is ever sent from a notifications row.
--
-- ── BACKWARD COMPATIBILITY ───────────────────────────────────────────────────
-- Both guards are purely subtractive: an ACTIVE recipient (disabled_at IS
-- NULL) is unaffected — same push, same in-app row, same recipient set as
-- before this migration. Only a recipient whose profile carries a non-null
-- disabled_at is newly skipped. Nothing here depends on any application
-- code deploy: this migration is safe to apply BEFORE the corresponding web
-- JS-layer filter (createNotification / the push-token registration path)
-- ships, and that JS-layer filter, whenever it lands, is complementary
-- defense-in-depth on top of this database guard — not a dependency of it.
--
-- ── create or replace, NOT drop/recreate ────────────────────────────────────
-- Both functions are CREATE OR REPLACE with signatures unchanged, so per
-- Postgres semantics ownership and grants are NOT affected by the replace
-- (this is documented CREATE FUNCTION behavior, and is pinned by the 0313
-- pgTAP: authenticated still holds EXECUTE on _notify_recipients after this
-- migration runs). The 0028 AFTER INSERT trigger binds to the function by
-- name, not by body, so it is untouched — no drop/recreate needed or done.
--
-- ── WHAT IS REPRODUCED VERBATIM ─────────────────────────────────────────────
-- _dispatch_push_for_notification's 120-day token filter, its "when others"
-- exception handler (pg_net misconfiguration must never break the insert),
-- its SECURITY DEFINER + search_path, and the Expo payload shape are all
-- copied byte-for-byte from the current (0028, never redefined since) body.
-- Only one guard block is added, at the top, before the token loop.
-- _notify_recipients' STABLE / SECURITY DEFINER / search_path and its
-- (organization_id, accepted_at, role) predicate are reproduced verbatim
-- from the current (0025, never redefined since) body; only one
-- `and not exists (...)` clause is appended to the WHERE.
--
-- ── LOCK POSTURE ─────────────────────────────────────────────────────────────
-- CREATE OR REPLACE FUNCTION takes only a brief lock on the function's
-- catalog row, not a table lock — there is no hot read/write path here the
-- way 0310/0311 had on user_profiles. `set lock_timeout` is still applied
-- per repo convention (precedent: 0295, 0298, 0303, 0310, 0311, 0312) so a
-- push under any unexpected contention fails fast and is safely retried
-- rather than blocking.
set lock_timeout = '5s';

-- ============================================================================
-- public._dispatch_push_for_notification() — universal push choke point.
-- Verbatim body from 0028 plus the disabled-account guard at the top.
-- ============================================================================
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
  -- A disabled account must not receive operational push. This is the
  -- universal choke point: every notifications row fires this trigger, so
  -- guarding here closes push for the JS writer AND all SQL trigger writers
  -- in one place (see migration 0313). SECURITY DEFINER, so it reads
  -- user_profiles freely.
  if exists (
    select 1 from public.user_profiles up
    where up.id = new.user_id and up.disabled_at is not null
  ) then
    return new;  -- swallow the dispatch, keep the row insert intact
  end if;

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

-- ============================================================================
-- public._notify_recipients(p_org uuid) — shared org-recipient resolver.
-- Verbatim body from 0025 plus one `and not exists (...)` clause.
-- ============================================================================
create or replace function public._notify_recipients(p_org uuid)
returns table(user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select om.user_id
  from public.organization_members om
  where om.organization_id = p_org
    and om.accepted_at is not null
    and om.role in ('owner', 'admin', 'manager')
    and not exists (
      select 1 from public.user_profiles up
      where up.id = om.user_id and up.disabled_at is not null
    );
$$;

reset lock_timeout;
