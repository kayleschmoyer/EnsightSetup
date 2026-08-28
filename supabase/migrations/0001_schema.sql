-- Core schema for garage-level-webapp Supabase migration.
-- Mirrors the entity tree previously embedded in the Google Sheets "SetupJson" blob:
-- customers -> garages -> levels -> devices, plus customer-wide servers/display groups/
-- sensor groups/display schedules. See docs/customer-api-example.json (legacy app) and
-- src/lib/configSheetSchema.js for the field-level source of truth this mirrors.

create extension if not exists pgcrypto;

create table customers (
  id uuid primary key default gen_random_uuid(),
  customer_id text unique not null,
  code text not null default '',
  friendly_name text not null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table display_schedules (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  start_time text,
  end_time text,
  day text,
  count_position jsonb,
  file_path text,
  garage1 text,
  level1 text,
  garage2 text,
  level2 text,
  created_at timestamptz not null default now()
);

create table garages (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  name text not null,
  internal_name text,
  address text,
  city text,
  state text,
  zip text,
  maps_url text,
  image_path text,
  quick_links jsonb not null default '[]'::jsonb,
  contacts jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table servers (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  manufacturer text,
  device_type text,
  name text,
  status text,
  location text,
  mdf_idf_location text,
  ip text,
  mac text,
  ip_assignment_method text,
  subnet text,
  gateway text,
  dns text,
  username text,
  password text,
  notes text,
  stream_address text,
  created_at timestamptz not null default now()
);

create table display_groups (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null references garages(id) on delete cascade,
  name text not null,
  send_only_on_updates boolean not null default false,
  force_send_after_seconds integer
);

create table sensor_groups (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null references garages(id) on delete cascade,
  group_id text not null,
  controller_address text,
  controller_key text,
  sensor_protocol text default 'NWAVE',
  garage_name text,
  level_name text,
  parent_level text
);

create table mdf_idf_locations (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null references garages(id) on delete cascade,
  name text not null
);

create table levels (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null references garages(id) on delete cascade,
  name text not null,
  internal_name text,
  total_spots integer default 100,
  ev_spots integer default 0,
  handicap_spots integer default 0,
  bg_image_path text,
  is_zone boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create type device_family as enum ('camera', 'sign', 'sensor');

create table devices (
  id uuid primary key default gen_random_uuid(),
  level_id uuid not null references levels(id) on delete cascade,
  family device_family not null,
  type text not null,
  name text,
  x double precision,
  y double precision,
  rotation double precision,
  server_id uuid references servers(id) on delete set null,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- attributes jsonb shape by family (documented, not DB-enforced, to stay flexible during dev):
--  camera: { visibleName, hardwareType, stream1{...}, stream2{...}, resolution, disabled,
--            isEntryExitCamera, dependentCameraName, trafficFlow{direction} }
--  sign:   { controllerName, visibleName, displayGroupId, ipAddress, port, serialAddress,
--            displayProtocol, displayMap, hardwareType, keepLevelCountsSeparate,
--            displayGarageId, displayLevelIds[]/displayLevelAll, positionName,
--            photoPaths[] (Storage object paths, max 10), inserts[] (monument sign inserts) }
--  sensor: { sensorId, configSensorGroupId, parkingType, tempParkingTimeInMinutes, sensors[] }

create index idx_display_schedules_customer on display_schedules(customer_id);
create index idx_garages_customer on garages(customer_id);
create index idx_servers_customer on servers(customer_id);
create index idx_display_groups_garage on display_groups(garage_id);
create index idx_sensor_groups_garage on sensor_groups(garage_id);
create index idx_mdf_idf_locations_garage on mdf_idf_locations(garage_id);
create index idx_levels_garage on levels(garage_id);
create index idx_devices_level on devices(level_id);
create index idx_devices_family_type on devices(family, type);
create index idx_devices_server on devices(server_id);
create index idx_devices_attributes_gin on devices using gin (attributes);

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_customers_updated_at before update on customers
  for each row execute function set_updated_at();
create trigger trg_garages_updated_at before update on garages
  for each row execute function set_updated_at();
create trigger trg_levels_updated_at before update on levels
  for each row execute function set_updated_at();
create trigger trg_devices_updated_at before update on devices
  for each row execute function set_updated_at();
