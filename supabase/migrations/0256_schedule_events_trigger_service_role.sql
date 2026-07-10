-- 0256: let service-role writes through the 0084 identity trigger.
--
-- 0084's _enforce_schedule_events_writer forces created_by/updated_by :=
-- auth.uid() so a USER client can't spoof authorship. But service-role
-- connections have auth.uid() = NULL, so the 0255 auto-scheduler's insert
-- (which supplies the APPROVING USER's id explicitly) got created_by nulled
-- → NOT NULL violation → no auto event. Keep the anti-spoof for user
-- contexts (a non-null auth.uid() still overrides whatever the client sent)
-- and only when auth.uid() is NULL (service role — trusted by definition)
-- accept the caller-supplied identity. created_by stays immutable on UPDATE.
create or replace function public._enforce_schedule_events_writer()
returns trigger
language plpgsql
as $$
begin
  if (tg_op = 'INSERT') then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.updated_by := coalesce(auth.uid(), new.updated_by, new.created_by);
  elsif (tg_op = 'UPDATE') then
    new.created_by := old.created_by;
    new.updated_by := coalesce(auth.uid(), new.updated_by);
  end if;
  return new;
end;
$$;
