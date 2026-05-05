-- 0027_mfa_recovery_codes.sql
-- ============================================================================
-- Backup recovery codes for MFA. If a user loses their TOTP device, they can
-- consume a one-time recovery code to unenroll their factors and sign back
-- in. Codes are stored hashed (sha256 hex). Plaintext is returned exactly
-- once at generation time and never retrievable again.
-- ============================================================================

create table if not exists public.mfa_recovery_codes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  code_hash   text not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists mfa_recovery_codes_user_idx
  on public.mfa_recovery_codes(user_id);
create index if not exists mfa_recovery_codes_unused_idx
  on public.mfa_recovery_codes(user_id) where used_at is null;

alter table public.mfa_recovery_codes enable row level security;

drop policy if exists mfa_recovery_codes_own on public.mfa_recovery_codes;
create policy mfa_recovery_codes_own on public.mfa_recovery_codes
  for select using (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────
-- generate_mfa_recovery_codes(): wipes the caller's existing codes and
-- generates 10 fresh ones. Returns the plaintexts so the UI can show
-- them once. Codes are 4 groups of 4 base32-friendly chars, dashed.
-- ─────────────────────────────────────────────────────────────────────

create or replace function public.generate_mfa_recovery_codes()
returns table(code text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uid uuid := auth.uid();
  i int;
  raw_code text;
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  group_a text;
  group_b text;
  group_c text;
  group_d text;
  pos int;
  rnd_byte int;
begin
  if uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  delete from public.mfa_recovery_codes where user_id = uid;

  for i in 1..10 loop
    -- 16 chars from a 32-char alphabet → ~80 bits of entropy.
    group_a := '';
    group_b := '';
    group_c := '';
    group_d := '';
    for pos in 1..4 loop
      group_a := group_a || substring(alphabet
        from (1 + (get_byte(extensions.gen_random_bytes(1), 0) % 32))::int for 1);
      group_b := group_b || substring(alphabet
        from (1 + (get_byte(extensions.gen_random_bytes(1), 0) % 32))::int for 1);
      group_c := group_c || substring(alphabet
        from (1 + (get_byte(extensions.gen_random_bytes(1), 0) % 32))::int for 1);
      group_d := group_d || substring(alphabet
        from (1 + (get_byte(extensions.gen_random_bytes(1), 0) % 32))::int for 1);
    end loop;
    raw_code := group_a || '-' || group_b || '-' || group_c || '-' || group_d;
    insert into public.mfa_recovery_codes (user_id, code_hash)
    values (uid, encode(extensions.digest(raw_code, 'sha256'), 'hex'));
    code := raw_code;
    return next;
  end loop;
  return;
end;
$$;

grant execute on function public.generate_mfa_recovery_codes() to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- consume_mfa_recovery_code(p_code): canonicalizes the input (uppercase,
-- preserves dashes) and tries to mark a matching unused code as used.
-- Returns true on success, false if the code is wrong or already used.
-- Does NOT do MFA unenrollment — the calling server action handles that
-- with the admin client because RLS on auth.* requires it.
-- ─────────────────────────────────────────────────────────────────────

create or replace function public.consume_mfa_recovery_code(p_code text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uid uuid := auth.uid();
  hashed text;
  matched_id uuid;
begin
  if uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_code is null or length(trim(p_code)) = 0 then
    return false;
  end if;
  hashed := encode(extensions.digest(upper(trim(p_code)), 'sha256'), 'hex');
  update public.mfa_recovery_codes
    set used_at = now()
    where user_id = uid
      and code_hash = hashed
      and used_at is null
    returning id into matched_id;
  return matched_id is not null;
end;
$$;

grant execute on function public.consume_mfa_recovery_code(text) to authenticated;
