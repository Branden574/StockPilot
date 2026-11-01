-- Each role is decided on its own: two of three is not enough.
create table public.orders_archive (id bigint primary key);
grant all on public.orders_archive to authenticated;
revoke all on public.orders_archive from anon;

create view public.orders_archive_view as select id from public.orders_archive;
grant all on public.orders_archive_view to authenticated;
