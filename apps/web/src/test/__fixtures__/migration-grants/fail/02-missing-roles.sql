-- Each role is decided on its own: two of three is not enough.
create table public.orders_archive (id bigint primary key);
grant select on public.orders_archive to authenticated;
grant select on public.orders_archive to anon;

create view public.orders_archive_view as select id from public.orders_archive;
grant select on public.orders_archive_view to authenticated;
