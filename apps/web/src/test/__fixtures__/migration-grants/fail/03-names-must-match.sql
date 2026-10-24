-- A grant on another spelling names another object: quoted "Widgets" is not
-- widgets, order_lines is not "Order Lines", and another schema's gizmos is
-- not public.gizmos.
create table "Widgets" (id int primary key);
create table widgets (id int primary key);
grant select on "Widgets" to anon, authenticated, service_role;

create table "Order Lines" (id int primary key);
create table order_lines (id int primary key);
grant select on order_lines to anon, authenticated, service_role;

create schema if not exists d1_other;
create table d1_other.gizmos (id int primary key);
create table public.gizmos (id int primary key);
grant select on d1_other.gizmos to anon, authenticated, service_role;
