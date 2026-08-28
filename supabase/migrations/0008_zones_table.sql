-- Zones become a first-class table. They previously lived as levels rows with
-- is_zone = true, which made them invisible to anyone browsing the database
-- ("where are zones?"). The app still treats a zone as a level-shaped object
-- in memory — CustomerRepository splits/merges at the persistence boundary.
--
-- Zone polygons (canvas geometry) stay inside the *parent* level's config
-- jsonb under "zones" — they're drawing data with no cross-table references.

create table zones (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null references garages(id) on delete cascade,
  parent_level_id uuid not null references levels(id) on delete cascade,
  name text not null,
  internal_name text,
  total_spots integer default 0,
  ev_spots integer default 0,
  handicap_spots integer default 0,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_zones_garage on zones(garage_id);
create index idx_zones_parent_level on zones(parent_level_id);

create trigger trg_zones_updated_at before update on zones
  for each row execute function set_updated_at();

alter table zones enable row level security;

create policy "ensight staff can do anything with zones"
  on zones for all
  using (is_ensight_staff())
  with check (is_ensight_staff());

-- Move existing zone rows over. Rows with no parent link are dropped: the
-- link was never persisted before 0007, so such zones were already broken
-- (they forgot their parent floor on every reload).
insert into zones (id, garage_id, parent_level_id, name, internal_name,
                   total_spots, ev_spots, handicap_spots, config, created_at, updated_at)
select id, garage_id, parent_level_id, name, internal_name,
       total_spots, ev_spots, handicap_spots, config, created_at, updated_at
from levels
where is_zone and parent_level_id is not null;

delete from levels where is_zone;

-- levels now holds floors only.
alter table levels drop column is_zone;
alter table levels drop column parent_level_id;
