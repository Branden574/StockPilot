-- ============================================================================
-- 0040_bundles.sql — Bundle / Kit support
-- ============================================================================
-- Bundles let an org define reusable kits (a "Reading Kit", a "School Visit
-- Pack") composed of N inventory items. Bundles can be:
--   • virtual recipes — components are drawn from individual stock at
--     distribution time; nothing is held as a bundle.
--   • pre-assembled — a hidden phantom inventory_item holds N pre-boxed
--     kits. Distributions drain the phantom first, then fall back to
--     individual components.
-- Distribution is concurrency-safe via the distribute_bundle() function,
-- which holds row locks on the phantom and every component for the
-- duration of one distribution.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- inventory_items.is_bundle — flags phantom items so reports can filter
-- ----------------------------------------------------------------------------
alter table public.inventory_items
  add column if not exists is_bundle boolean not null default false;

create index if not exists inventory_items_is_bundle_idx
  on public.inventory_items(organization_id)
  where is_bundle;

-- ----------------------------------------------------------------------------
-- Extend stock_movements.movement_type with bundle-specific reasons.
-- The original CHECK was created without an explicit name in 0002, so we
-- look it up by column instead of assuming a name.
-- ----------------------------------------------------------------------------
do $$
declare
  v_constraint_name text;
begin
  select conname into v_constraint_name
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  where t.relname = 'stock_movements'
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%movement_type%add%remove%';

  if v_constraint_name is not null then
    execute format(
      'alter table public.stock_movements drop constraint %I',
      v_constraint_name
    );
  end if;
end $$;

alter table public.stock_movements
  add constraint stock_movements_movement_type_check
  check (movement_type in (
    'add','remove','adjust','transfer','receive_po',
    'return','damage','loss','correction','initial',
    'bundle_assembly','bundle_distribution','bundle_shortage'
  ));

-- ----------------------------------------------------------------------------
-- bundles
-- ----------------------------------------------------------------------------
create table public.bundles (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  name                 text not null,
  sku                  text,
  description          text,
  is_active            boolean not null default true,
  preassembly_enabled  boolean not null default false,
  /* Lazily created when the bundle is first assembled. The phantom is a
     hidden inventory_item with is_bundle=true. */
  phantom_item_id      uuid references public.inventory_items(id) on delete set null,
  archived_at          timestamptz,
  created_by           uuid references public.user_profiles(id) on delete set null,
  updated_by           uuid references public.user_profiles(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create trigger bundles_set_updated_at
  before update on public.bundles
  for each row execute function public.tg_set_updated_at();

create index bundles_org_active_idx
  on public.bundles(organization_id)
  where is_active and archived_at is null;

create unique index bundles_org_sku_unique
  on public.bundles(organization_id, sku)
  where sku is not null;

-- ----------------------------------------------------------------------------
-- bundle_components
-- ----------------------------------------------------------------------------
create table public.bundle_components (
  bundle_id    uuid not null references public.bundles(id) on delete cascade,
  item_id      uuid not null references public.inventory_items(id) on delete restrict,
  quantity     numeric(14,4) not null check (quantity > 0),
  is_optional  boolean not null default false,
  created_at   timestamptz not null default now(),
  primary key (bundle_id, item_id)
);

create index bundle_components_bundle_idx
  on public.bundle_components(bundle_id);
create index bundle_components_item_idx
  on public.bundle_components(item_id);

-- ----------------------------------------------------------------------------
-- bundle_distributions
-- ----------------------------------------------------------------------------
create table public.bundle_distributions (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  bundle_id           uuid not null references public.bundles(id) on delete restrict,
  warehouse_id        uuid not null references public.warehouses(id) on delete restrict,
  quantity            numeric(14,4) not null check (quantity > 0),
  /* Optional link back to the schedule event that triggered this run. */
  schedule_event_id   uuid references public.schedule_events(id) on delete set null,
  notes               text,
  shortage_recorded   boolean not null default false,
  distributed_by      uuid references public.user_profiles(id) on delete set null,
  distributed_at      timestamptz not null default now()
);

create index bundle_distributions_org_distributed_at_idx
  on public.bundle_distributions(organization_id, distributed_at desc);
create index bundle_distributions_bundle_idx
  on public.bundle_distributions(bundle_id);
create index bundle_distributions_event_idx
  on public.bundle_distributions(schedule_event_id)
  where schedule_event_id is not null;

-- ============================================================================
-- RLS — read by any org member; manage requires manager+; distribute
-- requires staff+. Distribute permission still allows read of bundles.
-- ============================================================================
alter table public.bundles               enable row level security;
alter table public.bundle_components     enable row level security;
alter table public.bundle_distributions  enable row level security;

-- bundles
create policy bundles_select on public.bundles
  for select to authenticated
  using (public.is_org_member(organization_id));

create policy bundles_insert on public.bundles
  for insert to authenticated
  with check (public.has_org_role(organization_id, 'manager'));

create policy bundles_update on public.bundles
  for update to authenticated
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));

create policy bundles_delete on public.bundles
  for delete to authenticated
  using (public.has_org_role(organization_id, 'admin'));

-- bundle_components — org membership inferred via the parent bundle
create policy bundle_components_select on public.bundle_components
  for select to authenticated
  using (
    exists (
      select 1 from public.bundles b
      where b.id = bundle_components.bundle_id
        and public.is_org_member(b.organization_id)
    )
  );

create policy bundle_components_write on public.bundle_components
  for all to authenticated
  using (
    exists (
      select 1 from public.bundles b
      where b.id = bundle_components.bundle_id
        and public.has_org_role(b.organization_id, 'manager')
    )
  )
  with check (
    exists (
      select 1 from public.bundles b
      where b.id = bundle_components.bundle_id
        and public.has_org_role(b.organization_id, 'manager')
    )
  );

-- bundle_distributions — staff+ can record (assemble + distribute)
create policy bundle_distributions_select on public.bundle_distributions
  for select to authenticated
  using (public.is_org_member(organization_id));

create policy bundle_distributions_insert on public.bundle_distributions
  for insert to authenticated
  with check (public.has_org_role(organization_id, 'staff'));

-- Distributions are immutable post-insert. No update/delete policy.

-- ============================================================================
-- assemble_bundle: pre-box N kits at a warehouse.
--   • Decrements every required component by N × component.quantity.
--   • Creates the phantom inventory_item lazily on first assemble.
--   • Increments the phantom by N.
--   • Records stock_movements rows with movement_type='bundle_assembly'.
-- Concurrency-safe via row locks on phantom + every component.
-- Throws 'insufficient_stock' if any required (non-optional) component
-- can't cover the assembly. Optional components are skipped silently
-- when short.
-- Returns the phantom_item_id and the new phantom quantity.
-- ============================================================================
create or replace function public.assemble_bundle(
  p_bundle_id    uuid,
  p_quantity     numeric,
  p_warehouse_id uuid,
  p_notes        text default null
)
returns table (phantom_item_id uuid, phantom_qty numeric)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_bundle    public.bundles%rowtype;
  v_org       uuid;
  v_phantom   public.inventory_items%rowtype;
  v_user      uuid := auth.uid();
  v_phantom_sku text;
  v_component record;
  v_needed    numeric(14,4);
  v_prev      numeric(14,4);
  v_new       numeric(14,4);
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity_must_be_positive' using errcode = '22023';
  end if;

  select * into v_bundle
  from public.bundles where id = p_bundle_id for update;
  if not found then raise exception 'bundle_not_found' using errcode = 'P0002'; end if;
  if not v_bundle.is_active or v_bundle.archived_at is not null then
    raise exception 'bundle_not_active' using errcode = 'P0001';
  end if;
  if not v_bundle.preassembly_enabled then
    raise exception 'preassembly_disabled' using errcode = 'P0001';
  end if;
  v_org := v_bundle.organization_id;

  if not public.has_org_role(v_org, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Verify warehouse belongs to org
  if not exists (
    select 1 from public.warehouses
    where id = p_warehouse_id and organization_id = v_org
  ) then
    raise exception 'warehouse_not_found' using errcode = 'P0002';
  end if;

  -- Lock or create phantom
  if v_bundle.phantom_item_id is not null then
    select * into v_phantom
    from public.inventory_items
    where id = v_bundle.phantom_item_id for update;
    if v_phantom.warehouse_id is not null and v_phantom.warehouse_id <> p_warehouse_id then
      raise exception 'phantom_warehouse_mismatch' using errcode = 'P0001';
    end if;
  else
    -- SKU is internal, never user-facing. Truncated UUID guarantees
    -- uniqueness without colliding with any real SKU pattern.
    v_phantom_sku := '__BUNDLE__' || substr(p_bundle_id::text, 1, 8);
    insert into public.inventory_items (
      organization_id, sku, name, description, status,
      quantity_on_hand, warehouse_id, is_bundle,
      created_by, updated_by
    ) values (
      v_org, v_phantom_sku, v_bundle.name,
      'Pre-assembled bundle stock for ' || v_bundle.name,
      'active', 0, p_warehouse_id, true, v_user, v_user
    )
    returning * into v_phantom;

    update public.bundles
      set phantom_item_id = v_phantom.id, updated_at = now()
      where id = p_bundle_id;
  end if;

  -- Decrement components in deterministic order to avoid deadlocks
  -- between concurrent assemble/distribute calls.
  for v_component in
    select bc.item_id, bc.quantity, bc.is_optional, ii.quantity_on_hand, ii.id as ii_id
    from public.bundle_components bc
    join public.inventory_items ii on ii.id = bc.item_id
    where bc.bundle_id = p_bundle_id
    order by bc.item_id
    for update of ii
  loop
    v_needed := v_component.quantity * p_quantity;
    if v_component.quantity_on_hand < v_needed then
      if not v_component.is_optional then
        raise exception 'insufficient_stock' using detail = v_component.item_id::text;
      else
        continue;
      end if;
    end if;

    v_prev := v_component.quantity_on_hand;
    v_new  := v_prev - v_needed;
    update public.inventory_items
      set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
      where id = v_component.item_id;

    insert into public.stock_movements (
      organization_id, item_id, movement_type, quantity_change,
      previous_quantity, new_quantity, reason, reference_type,
      reference_id, user_id, notes
    ) values (
      v_org, v_component.item_id, 'bundle_assembly', -v_needed,
      v_prev, v_new, 'bundle_assembly', 'bundle',
      p_bundle_id, v_user, p_notes
    );
  end loop;

  -- Increment phantom
  v_prev := v_phantom.quantity_on_hand;
  v_new  := v_prev + p_quantity;
  update public.inventory_items
    set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
    where id = v_phantom.id;

  insert into public.stock_movements (
    organization_id, item_id, movement_type, quantity_change,
    previous_quantity, new_quantity, reason, reference_type,
    reference_id, user_id, notes
  ) values (
    v_org, v_phantom.id, 'bundle_assembly', p_quantity,
    v_prev, v_new, 'bundle_assembly', 'bundle',
    p_bundle_id, v_user, p_notes
  );

  return query select v_phantom.id, v_new;
end;
$$;

-- ============================================================================
-- distribute_bundle: ship N bundles, drawing from phantom first then
-- components. Records a bundle_distributions row + the per-item
-- stock_movements rows (and shortage marker rows if components are short).
-- Throws 'insufficient_stock' when allow_shortage=false and a required
-- component would short.
-- Returns the new distribution_id.
-- ============================================================================
create or replace function public.distribute_bundle(
  p_bundle_id          uuid,
  p_quantity           numeric,
  p_warehouse_id       uuid,
  p_allow_shortage     boolean,
  p_schedule_event_id  uuid default null,
  p_notes              text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_bundle    public.bundles%rowtype;
  v_org       uuid;
  v_distribution_id uuid;
  v_phantom_qty numeric(14,4) := 0;
  v_use_phantom numeric(14,4) := 0;
  v_use_virtual numeric(14,4);
  v_shortage  boolean := false;
  v_user      uuid := auth.uid();
  v_component record;
  v_needed    numeric(14,4);
  v_have      numeric(14,4);
  v_draw      numeric(14,4);
  v_short     numeric(14,4);
  v_prev      numeric(14,4);
  v_new       numeric(14,4);
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity_must_be_positive' using errcode = '22023';
  end if;

  select * into v_bundle
  from public.bundles where id = p_bundle_id for update;
  if not found then raise exception 'bundle_not_found' using errcode = 'P0002'; end if;
  if not v_bundle.is_active or v_bundle.archived_at is not null then
    raise exception 'bundle_not_active' using errcode = 'P0001';
  end if;
  v_org := v_bundle.organization_id;

  if not public.has_org_role(v_org, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Verify warehouse belongs to org
  if not exists (
    select 1 from public.warehouses
    where id = p_warehouse_id and organization_id = v_org
  ) then
    raise exception 'warehouse_not_found' using errcode = 'P0002';
  end if;

  -- Phantom allocation
  if v_bundle.phantom_item_id is not null then
    select quantity_on_hand into v_phantom_qty
    from public.inventory_items
    where id = v_bundle.phantom_item_id for update;
    v_phantom_qty := greatest(0, coalesce(v_phantom_qty, 0));
  end if;

  v_use_phantom := least(p_quantity, v_phantom_qty);
  v_use_virtual := p_quantity - v_use_phantom;

  -- Drain phantom
  if v_use_phantom > 0 then
    v_prev := v_phantom_qty;
    v_new  := v_prev - v_use_phantom;
    update public.inventory_items
      set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
      where id = v_bundle.phantom_item_id;

    insert into public.stock_movements (
      organization_id, item_id, movement_type, quantity_change,
      previous_quantity, new_quantity, reason, reference_type,
      reference_id, user_id, notes
    ) values (
      v_org, v_bundle.phantom_item_id, 'bundle_distribution', -v_use_phantom,
      v_prev, v_new, 'bundle_distribution', 'bundle',
      p_bundle_id, v_user, p_notes
    );
  end if;

  -- Component allocation for the virtual portion
  if v_use_virtual > 0 then
    for v_component in
      select bc.item_id, bc.quantity, bc.is_optional, ii.quantity_on_hand
      from public.bundle_components bc
      join public.inventory_items ii on ii.id = bc.item_id
      where bc.bundle_id = p_bundle_id
      order by bc.item_id
      for update of ii
    loop
      v_needed := v_component.quantity * v_use_virtual;
      v_have   := greatest(0, v_component.quantity_on_hand);
      v_draw   := least(v_needed, v_have);
      v_short  := v_needed - v_draw;

      if v_draw > 0 then
        v_prev := v_component.quantity_on_hand;
        v_new  := v_prev - v_draw;
        update public.inventory_items
          set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
          where id = v_component.item_id;

        insert into public.stock_movements (
          organization_id, item_id, movement_type, quantity_change,
          previous_quantity, new_quantity, reason, reference_type,
          reference_id, user_id, notes
        ) values (
          v_org, v_component.item_id, 'bundle_distribution', -v_draw,
          v_prev, v_new, 'bundle_distribution', 'bundle',
          p_bundle_id, v_user, p_notes
        );
      end if;

      if v_short > 0 then
        if not p_allow_shortage and not v_component.is_optional then
          raise exception 'insufficient_stock' using detail = v_component.item_id::text;
        end if;
        if not v_component.is_optional then
          v_shortage := true;
          insert into public.stock_movements (
            organization_id, item_id, movement_type, quantity_change,
            previous_quantity, new_quantity, reason, reference_type,
            reference_id, user_id, notes
          ) values (
            v_org, v_component.item_id, 'bundle_shortage', 0,
            v_component.quantity_on_hand, v_component.quantity_on_hand,
            'no_stock', 'bundle', p_bundle_id, v_user,
            'short ' || v_short::text || ' units during bundle distribution'
          );
        end if;
      end if;
    end loop;
  end if;

  insert into public.bundle_distributions (
    organization_id, bundle_id, warehouse_id, quantity,
    schedule_event_id, notes, shortage_recorded, distributed_by
  ) values (
    v_org, p_bundle_id, p_warehouse_id, p_quantity,
    p_schedule_event_id, p_notes, v_shortage, v_user
  )
  returning id into v_distribution_id;

  return v_distribution_id;
end;
$$;

grant execute on function public.assemble_bundle(uuid, numeric, uuid, text) to authenticated;
grant execute on function public.distribute_bundle(uuid, numeric, uuid, boolean, uuid, text) to authenticated;
