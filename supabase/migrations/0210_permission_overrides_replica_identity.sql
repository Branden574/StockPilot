-- 0210_permission_overrides_replica_identity.sql
--
-- Fix: realtime permission push (mig 0209) delivered INSERTs (granting/restoring
-- a permission) live, but NOT DELETEs (taking a permission away — the matrix
-- clears the override row to revert to the role default). Supabase Realtime
-- evaluates the table's RLS SELECT policy against the changed row to decide
-- delivery; with the DEFAULT replica identity the WAL's "old" tuple for a DELETE
-- carries only the primary key, so the policy (which needs organization_id /
-- user_id) can't be evaluated and the event is dropped — the revoked user had to
-- refresh to see the change.
--
-- REPLICA IDENTITY FULL makes UPDATE/DELETE log the COMPLETE old row, so RLS can
-- authorize delivery and the client receives the event (its handler reads
-- payload.old). These tables are tiny + low-write (admin config changes), so the
-- extra WAL volume is negligible.

alter table public.role_permission_overrides replica identity full;
alter table public.user_permission_overrides replica identity full;
