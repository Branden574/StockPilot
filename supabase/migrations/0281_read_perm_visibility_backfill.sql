-- 0281_read_perm_visibility_backfill.sql
-- Auditor visibility follow-up (adversarial review finding).
--
-- 0279 seeded the new read permissions to MIRROR each surface's old gating
-- write permission (staff got cycle_counts:read because staff held
-- stock:adjust, etc.). That mirrors DEFAULTS — but an org that deliberately
-- HID a surface from a role by REVOKING the write permission via the matrix
-- would have the surface silently reappear (read-only) through the new read
-- default. This backfill preserves each org's existing visibility choices:
-- wherever an override REVOKES the old gating write permission, insert a
-- matching revoke of the paired read permission — unless the org has already
-- made an explicit choice for the read permission (on conflict do nothing).
--
-- Orgs never touched by the matrix are unaffected (no override rows). New
-- grants made after this migration behave per the new model.
--
-- Pairs (write → read):
--   stock:adjust       → cycle_counts:read
--   schedule:manage    → schedule:read
--   bundles:distribute → bundles:read
--   rentals:create     → rentals:read
--   returns:manage     → returns:read

with pairs(write_perm, read_perm) as (
  values
    ('stock:adjust',       'cycle_counts:read'),
    ('schedule:manage',    'schedule:read'),
    ('bundles:distribute', 'bundles:read'),
    ('rentals:create',     'rentals:read'),
    ('returns:manage',     'returns:read')
)
insert into public.role_permission_overrides (organization_id, role, permission, granted, updated_by)
select o.organization_id, o.role, p.read_perm, false, null
  from public.role_permission_overrides o
  join pairs p on p.write_perm = o.permission
 where o.granted = false
on conflict (organization_id, role, permission) do nothing;

with pairs(write_perm, read_perm) as (
  values
    ('stock:adjust',       'cycle_counts:read'),
    ('schedule:manage',    'schedule:read'),
    ('bundles:distribute', 'bundles:read'),
    ('rentals:create',     'rentals:read'),
    ('returns:manage',     'returns:read')
)
insert into public.user_permission_overrides (organization_id, user_id, permission, granted, updated_by)
select o.organization_id, o.user_id, p.read_perm, false, null
  from public.user_permission_overrides o
  join pairs p on p.write_perm = o.permission
 where o.granted = false
on conflict (organization_id, user_id, permission) do nothing;
