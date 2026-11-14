-- customer_users: a portal user's invitation and acceptance times, and the
-- customer and account a row joins, are set by the server.
--
-- A customer_users row maps one account (user_id) to one B2B customer
-- (customer_id) of one organization. Two of its columns are times the portal
-- relies on:
--   - invited_at: when the organization invited the account;
--   - accepted_at: when the account first opened the portal for this
--     customer. The portal's resolver (resolvePortalContext in
--     apps/web/src/server/services/portal.ts) stamps it with the service-role
--     client, and only for the row it chose; among an account's rows an
--     accepted one comes first, and among accepted rows the earliest
--     acceptance comes first.
--
-- Row access is unchanged by this file. It adds one BEFORE INSERT OR UPDATE
-- trigger that holds, for every caller that is not the service role or a
-- direct database connection:
--   INSERT  accepted_at is null and invited_at is the database's now(),
--           whatever the statement named (the app's invite names neither, so
--           it writes exactly what it wrote before);
--   UPDATE  accepted_at, invited_at, user_id and customer_id keep their
--           values; a statement that would change any of them is refused
--           with 42501 and hint customer_users_server_managed, and nothing
--           is written.
-- DELETE is not touched.
--
-- WHO IS "THE SERVER". current_user, as 0218 and 0309 decided and measured:
-- PostgREST switches it per request to the token's role (authenticated,
-- anon, or service_role for createAdminClient), and a direct connection
-- (migrations, pgTAP, operator SQL) is postgres or supabase_admin. The list
-- below is an allowlist, so any other role is held to the rule. The trigger
-- function is SECURITY INVOKER so current_user is the writer.
--
-- WHO CHANGES TODAY. Nobody the app serves. Every writer of the table:
--   - CustomersService.inviteUser (apps/web/src/server/services/customers.ts)
--     upserts (customer_id, user_id, email, invited_by) with the member's own
--     client. A first invite inserts; the trigger sets the two times to what
--     the column defaults gave. A re-invite of the same account updates
--     email and invited_by and sets customer_id and user_id to the values
--     they already hold, which is no change; invited_at and accepted_at are
--     not in the statement and keep their values, as before.
--   - CustomersService.removeUser deletes with the member's client: no
--     trigger on DELETE.
--   - resolvePortalContext stamps accepted_at with the service-role client:
--     allowed through.
--   - Account deletion removes rows by the user_id foreign key's ON DELETE
--     CASCADE: a delete, no trigger.
-- The phone app reads the table only (a count); no database function writes
-- it.
--
-- LOCKS. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on public.customer_users
-- to commit: reads go on, and a write to the table waits for this file's
-- commit (milliseconds). If a write or another DDL holds the table, the file
-- waits at most lock_timeout 900ms, then ends with 55P03 and nothing applied,
-- and the push can be run again. CREATE FUNCTION, REVOKE and COMMENT lock no
-- table.
--
-- DATA SAFETY: no row changes. No table, view, sequence, policy or table
-- grant is created or changed. One function (EXECUTE revoked from every API
-- role; a trigger runs it regardless) and one trigger are created.
--
-- ERRORS: 42501 with a plain sentence and hint customer_users_server_managed;
-- never 40001 or 40P01 (PostgREST retries those forever).

set lock_timeout = '900ms';

create function public.tg_customer_users_server_stamps()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  -- The service-role client and direct connections write what they name.
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- A new mapping is invited now and not yet accepted.
    new.accepted_at := null;
    new.invited_at := now();
    return new;
  end if;

  if new.accepted_at is distinct from old.accepted_at
     or new.invited_at is distinct from old.invited_at
     or new.user_id is distinct from old.user_id
     or new.customer_id is distinct from old.customer_id then
    raise exception 'A portal user''s invitation and acceptance are recorded by StockPilot.'
      using errcode = '42501', hint = 'customer_users_server_managed';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_customer_users_server_stamps() from public, anon, authenticated, service_role;

create trigger trg_customer_users_server_stamps
  before insert or update on public.customer_users
  for each row execute function public.tg_customer_users_server_stamps();

comment on function public.tg_customer_users_server_stamps() is
  'BEFORE INSERT OR UPDATE on customer_users. For any writer that is not service_role, postgres or '
  'supabase_admin (current_user; SECURITY INVOKER): INSERT sets accepted_at to null and invited_at to now(); '
  'UPDATE refuses a change of accepted_at, invited_at, user_id or customer_id with 42501, hint '
  'customer_users_server_managed. email and invited_by are not held. The portal stamps accepted_at with the '
  'service-role client.';

reset lock_timeout;
