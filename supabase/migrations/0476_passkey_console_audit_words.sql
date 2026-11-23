-- 0476_passkey_console_audit_words.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- The platform console's words for the passkey switches (part 2, plan 1.5 and
-- 2.6 H). The console (apps/web server/actions/platform/passkeys.ts) records
-- every press that changes a switch in public.platform_admin_audit:
--   passkeys_switched      a platform-wide setting: detail {setting
--                          ('passkeys_on' or 'passkey_adds_on'), from, to}
--   org_passkeys_switched  one organization's switch: target organization,
--                          detail {from, to}
-- 0475 left these words out on purpose (0413's test S9 pins the check, and a
-- re-add is not additive). Until this file is live the console's audit insert
-- is refused by the check, so every ON is refused before anything is switched
-- (its record is written first), and an OFF stands with "the change could not
-- be recorded". Nothing else changes.
--
-- WHAT IT CHANGES: platform_admin_audit_action_check is dropped and added
-- again with every value it accepted (the twelve 0413 left, read back and
-- pinned by the preflight) plus the two above. No row, grant, policy, table,
-- function or trigger changes. Every existing row passes the new check (it is
-- a superset).
--
-- LOCKS: one NOWAIT prelude takes public.platform_admin_audit ACCESS
-- EXCLUSIVE before any change (40 attempts, 50 to 150 ms apart, holding
-- nothing between; 55P03 after about 4 to 5 s behind an open reader or
-- writer, nothing applied, then run again). The add validates every row
-- under that lock: one sequential scan of platform_admin_audit (a small
-- table: one row per console action). Beyond it only the preflight's ACCESS
-- SHARE on pg_constraint and its indexes, and the new constraint's own
-- object lock; no other table, nothing in auth.
--
-- ROLLBACK (run in a quiet minute; only while no row carries either word, or
-- after deleting those rows, which the append-only trail should not lose):
--   begin;
--   lock table only public.platform_admin_audit in access exclusive mode nowait;
--   alter table public.platform_admin_audit drop constraint platform_admin_audit_action_check;
--   alter table public.platform_admin_audit add constraint platform_admin_audit_action_check
--     check (action in ('viewed_org', 'acted_as_start', 'acted_as_end', 'billing_changed',
--       'password_reset_sent', 'org_provisioned', 'ticket_updated', 'deletion_passphrase_set',
--       'org_deleted', 'user_disabled', 'user_reenabled', 'permission_exception_changed'));
--   commit;
-- An older web build never writes either word, so a rollback needs no app
-- rollback; the console's switches then refuse every ON again.
-- ─────────────────────────────────────────────────────────────────────────────

set lock_timeout = '900ms';

-- ═══ 0. Preflight (catalogs only) ═══════════════════════════════════════════
do $preflight$
declare
  v_bad text := '';
begin
  if to_regclass('public.platform_admin_audit') is null then
    v_bad := v_bad || ' public.platform_admin_audit is missing;';
  -- The check as 0413 left it, by its definition's md5 (0475's test pinned
  -- the same value until this file).
  elsif (select md5(pg_get_constraintdef(c.oid)) from pg_catalog.pg_constraint c
          where c.conrelid = 'public.platform_admin_audit'::regclass
            and c.conname = 'platform_admin_audit_action_check')
        is distinct from '5c5206f38b7c1c7c60301d7d2ec92f2c' then
    v_bad := v_bad || ' platform_admin_audit_action_check drifted (or this file already ran);';
  end if;
  if v_bad <> '' then
    raise exception 'passkey_console_audit_words_preflight: %', v_bad
      using errcode = '55000', hint = 'passkey_console_audit_words_preflight';
  end if;
end
$preflight$;

-- ═══ 1. The lock prelude ═══════════════════════════════════════════════════
-- Inside DO because the CLI batch is not a transaction block (a top-level
-- LOCK TABLE refuses there, as 0373 found); the lock lasts until the batch
-- commits.
do $lock_words$
declare
  v_try integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.platform_admin_audit in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if v_try >= 40 then
        raise;
      end if;
    end;
    perform pg_sleep(0.05 + random() * 0.1);
  end loop;
end $lock_words$;

-- ═══ 2. The vocabulary ═════════════════════════════════════════════════════
-- The re-add MUST restate every accepted value (0308's warning).
alter table public.platform_admin_audit
  drop constraint platform_admin_audit_action_check;
alter table public.platform_admin_audit
  add constraint platform_admin_audit_action_check
  check (action in (
    'viewed_org', 'acted_as_start', 'acted_as_end',
    'billing_changed', 'password_reset_sent',
    'org_provisioned', 'ticket_updated',
    'deletion_passphrase_set', 'org_deleted',
    'user_disabled', 'user_reenabled',
    'permission_exception_changed',
    'passkeys_switched', 'org_passkeys_switched'
  ));
