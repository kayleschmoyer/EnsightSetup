-- Sample data for local dev only (supabase db reset replays this).
-- No real customer data — per the "start fresh" migration decision, real
-- historical data migration from Google Sheets is a separate, later step.

with cust as (
  insert into customers (customer_id, code, friendly_name, config_sheet_name)
  values ('SAMPLE01', 'SMP', 'Sample Parking Co.', 'Sample Parking Co.-config')
  returning id
),
cust_address as (
  insert into customer_addresses (customer_id, address, city, state, zip)
  select id, '123 Main St', 'Springfield', 'IL', '62704' from cust
),
cust_support as (
  insert into customer_support (customer_id, enterprise_site, support_24_hour)
  select id, false, false from cust
),
garage as (
  insert into garages (customer_id, name, internal_name, address, city, state, zip)
  select id, 'Downtown Garage', 'Downtown Garage', '123 Main St', 'Springfield', 'IL', '62704'
  from cust
  returning id, customer_id
),
level1 as (
  insert into levels (garage_id, name, internal_name, total_spots, ev_spots, handicap_spots, is_zone, config)
  select id, 'Level 1', 'Level 1', 120, 4, 6, false,
    '{"levelType":"FLI","visibleOnPortal":true,"maximumOccupancy":120,"autoResetCounts":{"Enabled":false,"Value":0,"Time":"04:00"},"forceFullVacancyThreshold":5,"vehicleTransitThreshold":0,"showFullMessage":true,"showFullMessageRed":true,"portalDisplayOrdinal":1,"signDisplayOrdinal":1}'::jsonb
  from garage
  returning id, garage_id
),
level2 as (
  insert into levels (garage_id, name, internal_name, total_spots, ev_spots, handicap_spots, is_zone, config)
  select id, 'Level 2', 'Level 2', 100, 2, 4, false,
    '{"levelType":"FLI","visibleOnPortal":true,"maximumOccupancy":100,"autoResetCounts":{"Enabled":false,"Value":0,"Time":"04:00"},"forceFullVacancyThreshold":5,"vehicleTransitThreshold":0,"showFullMessage":true,"showFullMessageRed":true,"portalDisplayOrdinal":2,"signDisplayOrdinal":2}'::jsonb
  from garage
  returning id, garage_id
)
insert into devices (level_id, family, type, name, x, y, rotation, attributes)
select level1.id, 'camera'::device_family, 'cam-fli', 'CAM-L1-01', 120, 240, 0,
  '{"visibleName":"Entrance Camera","hardwareType":"bullet","resolution":"1080p","disabled":false,"isEntryExitCamera":true,"stream1":{"ipAddress":"10.0.1.10","port":554,"streamType":"RTSP"}}'::jsonb
from level1
union all
select level1.id, 'sign'::device_family, 'sign-led', 'SIGN-L1-01', 300, 120, 0,
  '{"visibleName":"Level 1 Count Sign","hardwareType":"LED","displayProtocol":"NovaController","photoPaths":[]}'::jsonb
from level1
union all
select level2.id, 'sensor'::device_family, 'sensor-parksol', 'SEN-L2-01', 80, 80, 0,
  '{"sensorId":"S-2001","parkingType":"standard"}'::jsonb
from level2;
