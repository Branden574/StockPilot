#!/usr/bin/env bash
#
# Write overhead of 0393's marker triggers on the two busy log tables
# (orchestrator decision O-A3-1: measure it). Every INSERT and UPDATE on
# stock_movements and audit_logs now passes the WHEN clause of
# zzz_deleted_users_ins / _upd; the function itself must run only when a
# stamp exists or is written, or a person column goes from set to null.
#
#   1. Ordinary writes never call tg_mark_deleted_users: 1,000-row inserts
#      and 1,000-row updates of a non-person column, five runs per table,
#      make 0 calls (counted by a sequence the function bumps, injected into
#      the function inside the rolled-back transaction).
#   2. Their median time with the triggers enabled is within 5 % (or 3 ms) of
#      the same writes with the two triggers disabled. Both medians printed.
#   3. The slow path for comparison: 1,000 rows whose person column a
#      non-API role nulls for a LIVE person call the function 1,000 times and
#      stamp none (the account exists); its median time is printed.
#
# Everything runs in ONE transaction that is rolled back: the fixtures, the
# instrumented function and every ALTER ... DISABLE TRIGGER are undone.
# LOCAL stack only (docker container supabase_db_stockpilot), 0393 applied.
# Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0393_marker_write_overhead.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"
# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

if [ "$("${PSQL[@]}" -c "select count(*) from pg_trigger where tgname = 'zzz_deleted_users_upd' and tgrelid = 'public.stock_movements'::regclass")" != "1" ]; then
  echo "0393 is not applied on the local stack"; exit 1
fi

"${PSQL[@]}" > "$TMP/bench.out" 2>&1 <<'SQL'
begin;
insert into auth.users (id, email, raw_user_meta_data)
values ('03942222-0000-0000-0000-0000000000a1', '0393-bench@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('03942222-0000-0000-0000-00000000000a', '0393 Bench', '0393-bench');
insert into public.warehouses (id, organization_id, name, code, status)
values ('03942222-0000-0000-0000-000000000101', '03942222-0000-0000-0000-00000000000a', '0393 Bench WH', 'WH-0393-B', 'active');
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
values ('03942222-0000-0000-0000-000000000102', '03942222-0000-0000-0000-00000000000a', '03942222-0000-0000-0000-000000000101',
        'SKU-0393-B', '0393 bench item', 100, 'active', 'none');
create temp sequence zz_mark_calls;
do $inject$
declare v_def text; v_new text;
begin
  v_def := pg_get_functiondef('public.tg_mark_deleted_users()'::regprocedure);
  v_new := replace(v_def, E'begin\n  if tg_op = ''INSERT'' then', E'begin\n  perform nextval(''zz_mark_calls'');\n  if tg_op = ''INSERT'' then');
  if v_new = v_def then
    raise exception 'the injection point was not found in tg_mark_deleted_users';
  end if;
  execute v_new;
end $inject$;

do $bench$
declare
  c_org  constant uuid := '03942222-0000-0000-0000-00000000000a';
  c_item constant uuid := '03942222-0000-0000-0000-000000000102';
  c_user constant uuid := '03942222-0000-0000-0000-0000000000a1';
  v_tbl  text;
  v_mode text;
  v_run  int;
  t0     timestamptz;
  v_ins  double precision;
  v_upd  double precision;
  v_nul  double precision;
  v_c0   bigint;
  v_calls bigint;
  v_stamped bigint;
  r_ins  double precision[];
  r_upd  double precision[];
  r_nul  double precision[];
  r_calls bigint[];
  r_nulcalls bigint[];
  r_stamped bigint[];
  m_ins_on double precision; m_ins_off double precision;
  m_upd_on double precision; m_upd_off double precision;
  m_nul_on double precision; m_nul_off double precision;
begin
  foreach v_tbl in array array['stock_movements', 'audit_logs'] loop
    foreach v_mode in array array['on', 'off'] loop
      r_ins := '{}'; r_upd := '{}'; r_nul := '{}'; r_calls := '{}'; r_nulcalls := '{}'; r_stamped := '{}';
      for v_run in 1..5 loop
        begin
          if v_mode = 'off' then
            execute format('alter table public.%I disable trigger zzz_deleted_users_ins, disable trigger zzz_deleted_users_upd', v_tbl);
          end if;
          select last_value + (case when is_called then 0 else -1 end) into v_c0 from zz_mark_calls;
          t0 := clock_timestamp();
          if v_tbl = 'stock_movements' then
            insert into public.stock_movements (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, user_id)
            select c_org, c_item, 'adjust', 0, 100, 100, c_user from generate_series(1, 1000);
          else
            insert into public.audit_logs (organization_id, user_id, event)
            select c_org, c_user, 'test.0393.bench' from generate_series(1, 1000);
          end if;
          v_ins := extract(epoch from clock_timestamp() - t0) * 1000;
          t0 := clock_timestamp();
          if v_tbl = 'stock_movements' then
            update public.stock_movements set notes = 'bench' where organization_id = c_org;
          else
            update public.audit_logs set metadata = jsonb_build_object('bench', true) where organization_id = c_org;
          end if;
          v_upd := extract(epoch from clock_timestamp() - t0) * 1000;
          select last_value + (case when is_called then 0 else -1 end) - v_c0 into v_calls from zz_mark_calls;
          r_calls := r_calls || v_calls;
          -- The slow path: a non-API role nulls a LIVE person (no stamp).
          select last_value + (case when is_called then 0 else -1 end) into v_c0 from zz_mark_calls;
          t0 := clock_timestamp();
          execute format('update public.%I set user_id = null where organization_id = %L', v_tbl, c_org);
          v_nul := extract(epoch from clock_timestamp() - t0) * 1000;
          select last_value + (case when is_called then 0 else -1 end) - v_c0 into v_calls from zz_mark_calls;
          r_nulcalls := r_nulcalls || v_calls;
          execute format('select count(*) from public.%I where organization_id = %L and deleted_users is not null', v_tbl, c_org) into v_stamped;
          r_stamped := r_stamped || v_stamped;
          raise exception using errcode = 'XX394', message = 'bench_undo';
        exception when sqlstate 'XX394' then
          null;
        end;
        r_ins := r_ins || v_ins; r_upd := r_upd || v_upd; r_nul := r_nul || v_nul;
      end loop;
      raise notice 'RUN % % ins_ms=% upd_ms=% null_ms=% calls=% null_calls=% stamped=%',
        v_tbl, v_mode,
        (select percentile_cont(0.5) within group (order by x) from unnest(r_ins) x),
        (select percentile_cont(0.5) within group (order by x) from unnest(r_upd) x),
        (select percentile_cont(0.5) within group (order by x) from unnest(r_nul) x),
        (select sum(x) from unnest(r_calls) x),
        (select max(x) from unnest(r_nulcalls) x),
        (select max(x) from unnest(r_stamped) x);
    end loop;
  end loop;
end $bench$;
rollback;
SQL
RC=$?
if [ "$RC" -ne 0 ]; then echo "the benchmark failed:"; cat "$TMP/bench.out"; exit 1; fi
grep 'RUN ' "$TMP/bench.out" | sed 's/.*NOTICE:  //'

python3 - "$TMP/bench.out" <<'PY'
import re, sys
runs = {}
for line in open(sys.argv[1]):
    m = re.search(r'RUN (\w+) (on|off) ins_ms=([\d.]+) upd_ms=([\d.]+) null_ms=([\d.]+) calls=(\d+) null_calls=(\d+) stamped=(\d+)', line)
    if m:
        runs[(m[1], m[2])] = dict(ins=float(m[3]), upd=float(m[4]), nul=float(m[5]), calls=int(m[6]), nulcalls=int(m[7]), stamped=int(m[8]))
fails = 0
def ok(s): print('ok     ' + s)
def bad(s):
    global fails
    fails += 1
    print('FAIL   ' + s)
for t in ('stock_movements', 'audit_logs'):
    on, off = runs.get((t, 'on')), runs.get((t, 'off'))
    if not on or not off:
        bad(f'{t}: missing runs'); continue
    if on['calls'] == 0: ok(f'1: {t}: 5 x (1,000 inserts + 1,000 updates) made 0 calls to tg_mark_deleted_users')
    else: bad(f'1: {t}: {on["calls"]} calls on ordinary writes')
    for k, label in (('ins', 'insert'), ('upd', 'update')):
        delta = on[k] - off[k]
        pct = 100.0 * delta / off[k] if off[k] else 0.0
        msg = f'2: {t} {label}: median {on[k]:.1f} ms with the triggers, {off[k]:.1f} ms without ({pct:+.1f} %, {delta:+.1f} ms)'
        if pct < 5.0 or delta < 3.0: ok(msg)
        else: bad(msg)
    if on['nulcalls'] == 1000 and on['stamped'] == 0:
        ok(f'3: {t}: nulling a LIVE person on 1,000 rows called the function 1,000 times and stamped none '
           f'(median {on["nul"]:.1f} ms; {off["nul"]:.1f} ms without the triggers)')
    else:
        bad(f'3: {t}: null path calls {on["nulcalls"]}, stamped {on["stamped"]}')
print()
print('ALL CHECKS PASSED' if fails == 0 else f'{fails} CHECK(S) FAILED')
sys.exit(1 if fails else 0)
PY
