-- 0288_rack_number_not_composite.sql
--
-- PROPOSED — NOT APPLIED. Database-level backstop for the 2026-07-23 rack-shape
-- incident: rack 22-B was created with the WHOLE label in the number column,
-- locations = ('22-B', null) instead of ('22','B'). Put-away copied that pair
-- onto every item it placed there, and the Items rack filter — which requires
-- rack_number = '22' AND rack_row = 'B' — matched nothing. Three racks and
-- eight items were invisible to their own filter while the Rack COLUMN still
-- printed "22-B", because display just joins the pair.
--
-- The primary fix is in the app: ONE parser (@stockpilot/core's
-- parseRackLabel / normalizeRackFields) that every writer decomposes through,
-- plus readers that tolerate a legacy composite row. This constraint is the
-- belt-and-braces layer that would have made the bad INSERT fail loudly.
--
-- ADOPTION IS SAFE TODAY. The controller already split all three composite
-- locations and all eight items; verified against production 2026-07-23:
--   select count(*) from locations
--    where rack_number is not null and rack_number like '%-%';   -- 0 of 44
-- so this ALTER cannot fail on existing rows.
--
-- WHY THE PREDICATE IS NARROW (and why this migration is OPTIONAL): a rack may
-- legitimately be NAMED with a dash and have no row — "E2E-RACK", "Aisle-North".
-- A blanket "no dashes" check would reject those. This targets only the shape
-- the incident produced: a row-LESS rack whose number ends in a dash followed
-- by a short row-looking token (1-3 alphanumerics), i.e. exactly "22-B" /
-- "100-A" / "3-C". Racks that carry their own rack_row are exempt entirely,
-- since a decomposed pair is by definition not the failure mode.
--
-- If the false-positive risk is judged too high for an org that names racks
-- like "BAY-12" with no row, DO NOT apply this — the app-level parser plus the
-- writer-guard tests already close the recurrence path. It is offered, not
-- required.
--
-- NOT VALID + a separate VALIDATE keeps the write lock short: the ALTER takes
-- only a brief ACCESS EXCLUSIVE lock and the scan runs afterwards under a
-- weaker lock. Both statements are included since the table is small (44 rack
-- rows), but they stay separate so the pattern is right if it ever grows.

alter table public.locations
  add constraint locations_rack_number_not_composite
  check (
    rack_number is null
    or rack_row is not null
    or rack_number !~ '-[A-Za-z0-9]{1,3}$'
  ) not valid;

alter table public.locations
  validate constraint locations_rack_number_not_composite;

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- alter table public.locations
--   drop constraint if exists locations_rack_number_not_composite;
--
-- Dropping is instantaneous and touches no data: the constraint only ever
-- rejected future INSERT/UPDATEs, it never rewrote a row.
