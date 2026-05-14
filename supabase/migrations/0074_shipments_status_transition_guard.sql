-- ============================================================================
-- 0074_shipments_status_transition_guard.sql
--
-- I13 from the Shipments hunter report: there is no DB-level guard against
-- backwards transitions on `shipments.status`. The TS service layer
-- (markShipped / markCancelled / markDelivered) blocks the obvious cases,
-- but a manual SQL fix, an admin-tool update, or a future code path that
-- forgets the precondition could silently demote `delivered` back to
-- `shipped` and bypass the audit trail. The state machine should be
-- enforced by the table itself.
--
-- Allowed transitions:
--   draft     → shipped   (post_shipment_shipped RPC)
--   draft     → cancelled (markCancelled)
--   shipped   → delivered (markDelivered / signature flow)
--   shipped   → cancelled (intentionally NOT allowed — the service layer
--                          refuses to cancel a shipped slip; documented
--                          in markCancelled and enforced here too)
--   delivered → (terminal)
--   cancelled → (terminal)
--
-- Updates that don't change `status` are always allowed so partial writes
-- (signed_by_name, notes, etc.) keep working.
-- ============================================================================

create or replace function public.shipments_enforce_status_transition()
returns trigger
language plpgsql
as $$
begin
  if old.status is distinct from new.status then
    if not (
      (old.status = 'draft'   and new.status in ('shipped', 'cancelled'))
      or (old.status = 'shipped' and new.status = 'delivered')
    ) then
      raise exception 'shipment_invalid_status_transition'
        using errcode = 'P0001',
              detail  = format(
                'Cannot move shipment from %s to %s. Allowed: draft→shipped, draft→cancelled, shipped→delivered.',
                old.status, new.status
              );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists shipments_status_transition_guard on public.shipments;
create trigger shipments_status_transition_guard
  before update of status on public.shipments
  for each row
  execute function public.shipments_enforce_status_transition();

comment on function public.shipments_enforce_status_transition() is
  '0074: enforces the shipments.status state machine at the table level so '
  'no path (TS bug, admin SQL, future code) can demote a delivered or '
  'cancelled slip or shortcut the allowed transitions.';
