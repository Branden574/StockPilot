-- B2B portal P2: portal-originated orders are their own source value so
-- reporting/filters can distinguish them from staff-created ('internal') and
-- anonymous public-link orders. Additive: existing values stay valid.
--
-- Portal orders enter at 'pending_approval' (not 'pending_confirmation'): the
-- requester is an AUTHENTICATED invited portal user, so the email-confirmation
-- hop the anonymous flow needs is meaningless here.

alter table public.order_requests
  drop constraint if exists order_requests_source_check;

alter table public.order_requests
  add constraint order_requests_source_check
  check (source in ('internal', 'public_link', 'portal'));

-- identity_chk ends in ELSE false, so an unknown source can never insert —
-- extend it: a portal order is always attributed to the signed-in portal user.
alter table public.order_requests
  drop constraint if exists order_requests_identity_chk;

alter table public.order_requests
  add constraint order_requests_identity_chk
  check (
    case source
      when 'internal'    then (requester_user_id is not null or requester_email is not null)
      when 'public_link' then (requester_email is not null)
      when 'portal'      then (requester_user_id is not null)
      else false
    end
  );
