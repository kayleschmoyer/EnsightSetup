-- Every camera/sign/sensor field used to be shoved into devices.attributes
-- jsonb — accurate to the app, but unreadable in the dashboard: nothing about
-- "what IP does this camera have" was a real column. This migration promotes
-- every field to a real, named column, split across per-family detail tables
-- (mirroring the customers -> customer_addresses/customer_support pattern) so
-- "go to this table, use this field" is literally true for every device field.
--
-- What's genuinely shared across all three families stays on `devices` itself.
-- What's family-specific moves to camera_details / sign_details / sensor_details
-- (one row per device, 1:1). What's naturally a *list* per device becomes its
-- own child table instead of a jsonb array: camera_streams, camera_traffic_destinations,
-- sign_display_levels, sign_inserts (+ sign_insert_levels), sensor_units, device_photos.
--
-- Two fields stay outside the FK graph on purpose, with a plain (non-FK) uuid
-- column instead: a camera's traffic-flow target zone and a sign's display
-- level/zone selections can point at a *zone polygon* — geometry that lives
-- inside levels.config jsonb (see 0008's comment), not a row in any table.
-- Selections that target a real zone-LEVEL entity (from the zones table) do
-- get a real FK.

-- ---------------------------------------------------------------------------
-- devices: promote the fields common to every family onto the row itself.
-- ---------------------------------------------------------------------------
alter table devices
  add column friendly_name text,
  add column mdf_idf_location_id uuid references mdf_idf_locations(id) on delete set null,
  -- Legacy free-text server name from Excel imports, before a server had a row
  -- of its own to link to (servers.id via server_id already existed).
  add column server_name text,
  add column dhcp boolean not null default false,
  add column disabled boolean not null default false,
  add column disabled_reason text,
  add column placement_reason text,
  add column pending_placement boolean not null default false,
  add column icon_size integer;

update devices set
  friendly_name = attributes->>'friendlyName',
  mdf_idf_location_id = nullif(attributes->>'mdfIdfLocationId', '')::uuid,
  server_name = attributes->>'server',
  dhcp = coalesce((attributes->>'dhcp')::boolean, false),
  disabled = coalesce((attributes->>'disabled')::boolean, false),
  disabled_reason = attributes->>'disabledReason',
  placement_reason = attributes->>'placementReason',
  pending_placement = coalesce((attributes->>'pendingPlacement')::boolean, false),
  icon_size = nullif(attributes->>'iconSize', '')::integer
where attributes is not null and attributes <> '{}'::jsonb;

create index idx_devices_mdf_idf_location on devices(mdf_idf_location_id);

-- ---------------------------------------------------------------------------
-- Cameras
-- ---------------------------------------------------------------------------
create table camera_details (
  device_id uuid primary key references devices(id) on delete cascade,
  hardware_type text not null default 'bullet',
  color text,
  cone_size integer,
  -- Excel-import-only fields (no UI control yet) — round-tripped for the
  -- one-way "Export to Sheets" feature.
  resolution text,
  is_entry_exit_camera boolean not null default true,
  dependent_camera_name text,
  -- Traffic flow: primary direction/target.
  traffic_direction text,
  traffic_level_id uuid references levels(id) on delete set null,
  -- Not a FK: the target can be a drawn zone polygon, which lives inside the
  -- target floor's levels.config jsonb (canvas geometry), not a table row.
  traffic_zone_polygon_id uuid,
  traffic_multi_level boolean not null default false,
  traffic_coming_from text
);

create table camera_streams (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices(id) on delete cascade,
  stream_number smallint not null check (stream_number in (1, 2)),
  ip_address text,
  port text,
  external_url text,
  stream_type text,
  rotation numeric,
  cone_size integer,
  color text,
  unique (device_id, stream_number)
);

create table camera_traffic_destinations (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices(id) on delete cascade,
  target_level_id uuid not null references levels(id) on delete cascade,
  target_zone_polygon_id uuid
);

create index idx_camera_streams_device on camera_streams(device_id);
create index idx_camera_traffic_destinations_device on camera_traffic_destinations(device_id);

-- ---------------------------------------------------------------------------
-- Signs
-- ---------------------------------------------------------------------------
create table sign_details (
  device_id uuid primary key references devices(id) on delete cascade,
  controller_name text,
  visible_name text,
  display_protocol text,
  hardware_type text,
  display_group_id uuid references display_groups(id) on delete set null,
  display_garage_id uuid references garages(id) on delete set null,
  display_level_all boolean not null default false,
  position_name text,
  display_map text,
  keep_level_counts_separate boolean not null default false,
  -- Only meaningful when the sign has no inserts — inserts carry their own.
  serial_address text,
  ip_address text,
  port text,
  mac_address text,
  sided text not null default 'single',
  bold_sides text[] not null default '{}',
  -- Stable identity used to match this sign across saves/reloads/imports —
  -- required, not cosmetic (see src/lib/deviceCountUtils.js).
  logical_key text
);

-- One row per (level or zone) this sign displays on, when it has no inserts
-- and display_level_all is false. garage.levels in the app mixes real floors
-- and zone-level entities, so a selection can land in either table.
create table sign_display_levels (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices(id) on delete cascade,
  level_id uuid references levels(id) on delete cascade,
  zone_id uuid references zones(id) on delete cascade,
  check (num_nonnulls(level_id, zone_id) = 1)
);

-- Monument signs: one physical enclosure, multiple inserts sharing an IP.
create table sign_inserts (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices(id) on delete cascade,
  position integer not null default 0,
  display_name text,
  serial_address text,
  has_ethernet boolean not null default false
);

create table sign_insert_levels (
  id uuid primary key default gen_random_uuid(),
  insert_id uuid not null references sign_inserts(id) on delete cascade,
  level_id uuid references levels(id) on delete cascade,
  zone_id uuid references zones(id) on delete cascade,
  check (num_nonnulls(level_id, zone_id) = 1)
);

create index idx_sign_display_levels_device on sign_display_levels(device_id);
create index idx_sign_inserts_device on sign_inserts(device_id);
create index idx_sign_insert_levels_insert on sign_insert_levels(insert_id);

-- ---------------------------------------------------------------------------
-- Sensors
-- ---------------------------------------------------------------------------
create table sensor_details (
  device_id uuid primary key references devices(id) on delete cascade,
  sensor_protocol text,
  config_sensor_group_id uuid references sensor_groups(id) on delete set null,
  sensor_count integer not null default 1,
  api_key text,
  -- Legacy single-unit fallback id (pre-multi-unit import format).
  sensor_id text
);

-- Legacy/import multi-unit devices (one device housing several physical
-- sensors). The app's own UI never creates more than the implicit single
-- unit, but imported data can, and it must round-trip.
create table sensor_units (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices(id) on delete cascade,
  position integer not null default 0,
  sensor_name text,
  sensor_id text
);

create index idx_sensor_units_device on sensor_units(device_id);

-- ---------------------------------------------------------------------------
-- Photos (camera view image, sign photos) — Storage object paths, not blobs.
-- ---------------------------------------------------------------------------
create table device_photos (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices(id) on delete cascade,
  position integer not null default 0,
  storage_path text not null
);

create index idx_device_photos_device on device_photos(device_id);

-- ---------------------------------------------------------------------------
-- Backfill from the old jsonb blob before dropping it.
-- ---------------------------------------------------------------------------

-- Cameras: scalar fields + stream1/2 (which may be a legacy flat string).
insert into camera_details (
  device_id, hardware_type, color, cone_size, resolution, is_entry_exit_camera,
  dependent_camera_name, traffic_direction, traffic_level_id, traffic_zone_polygon_id,
  traffic_multi_level, traffic_coming_from
)
select
  id,
  coalesce(nullif(attributes->>'hardwareType', ''), 'bullet'),
  attributes->>'color',
  nullif(attributes->>'coneSize', '')::integer,
  attributes->>'resolution',
  coalesce((attributes->>'isEntryExitCamera')::boolean, true),
  attributes->>'dependentCameraName',
  attributes->'trafficFlow'->>'direction',
  nullif(attributes->'trafficFlow'->>'level', '')::uuid,
  nullif(attributes->'trafficFlow'->>'zone', '')::uuid,
  coalesce((attributes->'trafficFlow'->>'multiLevel')::boolean, false),
  attributes->'trafficFlow'->>'comingFrom'
from devices
where family = 'camera' and attributes is not null and attributes <> '{}'::jsonb;

insert into camera_streams (device_id, stream_number, ip_address, port, external_url, stream_type, rotation, cone_size, color)
select id, 1,
  case when jsonb_typeof(attributes->'stream1') = 'object' then attributes->'stream1'->>'ipAddress' else attributes->>'ipAddress' end,
  case when jsonb_typeof(attributes->'stream1') = 'object' then attributes->'stream1'->>'port' else attributes->>'port' end,
  case
    when jsonb_typeof(attributes->'stream1') = 'object' then attributes->'stream1'->>'externalUrl'
    when jsonb_typeof(attributes->'stream1') = 'string' then attributes->>'stream1'
    else attributes->>'rtspUrl'
  end,
  case when jsonb_typeof(attributes->'stream1') = 'object' then attributes->'stream1'->>'streamType' else type end,
  nullif(attributes->'stream1'->>'rotation', '')::numeric,
  nullif(attributes->'stream1'->>'coneSize', '')::integer,
  attributes->'stream1'->>'color'
from devices
where family = 'camera' and attributes ? 'stream1';

insert into camera_streams (device_id, stream_number, ip_address, port, external_url, stream_type, rotation, cone_size, color)
select id, 2,
  attributes->'stream2'->>'ipAddress', attributes->'stream2'->>'port', attributes->'stream2'->>'externalUrl',
  attributes->'stream2'->>'streamType',
  nullif(attributes->'stream2'->>'rotation', '')::numeric,
  nullif(attributes->'stream2'->>'coneSize', '')::integer,
  attributes->'stream2'->>'color'
from devices
where family = 'camera' and jsonb_typeof(attributes->'stream2') = 'object';

insert into camera_traffic_destinations (device_id, target_level_id, target_zone_polygon_id)
select d.id, split_part(dest, '::', 1)::uuid, nullif(split_part(dest, '::', 2), '')::uuid
from devices d, jsonb_array_elements_text(coalesce(d.attributes->'trafficFlow'->'destinations', '[]'::jsonb)) as dest
where d.family = 'camera';

-- Camera view photo (single) — carried over as whatever string it currently
-- holds (a legacy inline data-URL, most likely, since upload wasn't wired to
-- Storage yet). storage_path is descriptive of the go-forward shape; existing
-- rows get cleaned up naturally as each photo is re-uploaded through the app.
insert into device_photos (device_id, position, storage_path)
select id, 0, attributes->>'viewImage'
from devices
where family = 'camera' and coalesce(attributes->>'viewImage', '') <> '';

-- Signs
insert into sign_details (
  device_id, controller_name, visible_name, display_protocol, hardware_type,
  display_group_id, display_garage_id, display_level_all, position_name, display_map,
  keep_level_counts_separate, serial_address, ip_address, port, mac_address,
  sided, bold_sides, logical_key
)
select
  d.id,
  d.attributes->>'controllerName',
  d.attributes->>'visibleName',
  d.attributes->>'displayProtocol',
  d.attributes->>'hardwareType',
  nullif(d.attributes->>'displayGroupId', '')::uuid,
  nullif(d.attributes->>'displayGarageId', '')::uuid,
  coalesce((d.attributes->>'displayLevelAll')::boolean, false),
  d.attributes->>'positionName',
  d.attributes->>'displayMap',
  coalesce((d.attributes->>'keepLevelCountsSeparate')::boolean, false),
  d.attributes->>'serialAddress',
  d.attributes->>'ipAddress',
  d.attributes->>'port',
  d.attributes->>'macAddress',
  coalesce(nullif(d.attributes->>'sided', ''), 'single'),
  coalesce(ba.arr, '{}'),
  d.attributes->>'signLogicalKey'
from devices d
left join lateral (
  select array_agg(t.val) as arr
  from jsonb_array_elements_text(d.attributes->'boldSides') as t(val)
) ba on true
where d.family = 'sign' and d.attributes is not null and d.attributes <> '{}'::jsonb;

insert into sign_display_levels (device_id, level_id, zone_id)
select d.id, lv.id, z.id
from devices d,
     jsonb_array_elements_text(coalesce(d.attributes->'displayLevelIds', '[]'::jsonb)) as lvl(val)
     left join levels lv on lv.id = nullif(lvl.val, '')::uuid
     left join zones z on z.id = nullif(lvl.val, '')::uuid
where d.family = 'sign' and not (d.attributes ? 'inserts') and (lv.id is not null or z.id is not null);

-- Inserts: capture a stable new id per element (jsonb ids were "ins-..."
-- text, not uuids) so the second pass can attach each insert's levels/zones.
create temp table _insert_migration as
select gen_random_uuid() as id, d.id as device_id, (ordinality - 1)::integer as position, elem
from devices d, jsonb_array_elements(d.attributes->'inserts') with ordinality as t(elem, ordinality)
where d.family = 'sign' and d.attributes ? 'inserts';

insert into sign_inserts (id, device_id, position, display_name, serial_address, has_ethernet)
select id, device_id, position, elem->>'displayName', elem->>'serialAddress',
  coalesce((elem->>'hasEthernet')::boolean, false)
from _insert_migration;

insert into sign_insert_levels (insert_id, level_id, zone_id)
select m.id, lv.id, z.id
from _insert_migration m,
     jsonb_array_elements_text(coalesce(m.elem->'displayLevelIds', '[]'::jsonb)) as lvl(val)
     left join levels lv on lv.id = nullif(lvl.val, '')::uuid
     left join zones z on z.id = nullif(lvl.val, '')::uuid
where lv.id is not null or z.id is not null;

drop table _insert_migration;

insert into device_photos (device_id, position, storage_path)
select d.id, (ordinality - 1)::integer, photo
from devices d, jsonb_array_elements_text(coalesce(d.attributes->'signImages', '[]'::jsonb)) with ordinality as t(photo, ordinality)
where d.family = 'sign';

-- Sensors
insert into sensor_details (device_id, sensor_protocol, config_sensor_group_id, sensor_count, api_key, sensor_id)
select
  id,
  coalesce(nullif(attributes->>'sensorGroup', ''), type),
  nullif(attributes->>'configSensorGroupId', '')::uuid,
  coalesce(nullif(attributes->>'sensorCount', '')::integer, 1),
  attributes->>'apiKey',
  attributes->>'sensorId'
from devices
where family = 'sensor' and attributes is not null and attributes <> '{}'::jsonb;

insert into sensor_units (device_id, position, sensor_name, sensor_id)
select d.id, (ordinality - 1)::integer, elem->>'sensorName', elem->>'sensorId'
from devices d, jsonb_array_elements(coalesce(d.attributes->'sensors', '[]'::jsonb)) with ordinality as t(elem, ordinality)
where d.family = 'sensor';

alter table devices drop column attributes;

-- ---------------------------------------------------------------------------
-- RLS — same flat "any signed-in Ensight staff can do anything" policy as
-- every other table (see 0002_storage_and_rls.sql). Grants are automatic:
-- 0004_grants.sql's `alter default privileges` already covers future tables.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'camera_details', 'camera_streams', 'camera_traffic_destinations',
    'sign_details', 'sign_display_levels', 'sign_inserts', 'sign_insert_levels',
    'sensor_details', 'sensor_units', 'device_photos'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for all using (is_ensight_staff()) with check (is_ensight_staff())',
      'ensight staff can do anything with ' || t, t
    );
  end loop;
end $$;
