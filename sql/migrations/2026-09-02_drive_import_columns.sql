-- =============================================================================
-- Drive site-config import — columns for sheet fields that had no home.
-- Apply once against the RDS database; sql/schema.sql already includes these
-- for fresh installs. All additive and nullable, safe on a live database.
--
--   Garages.Stage                          -> sites.stage
--   DisplaySchedules.DisplayName           -> display_schedules.display_name
--   Sensors.ParkingType                    -> sensor_units.parking_type
--   Sensors.TempParkingTimeInMinutes       -> sensor_units.temp_parking_time_minutes
-- =============================================================================

ALTER TABLE sites
  ADD COLUMN stage VARCHAR(255) NULL AFTER internal_name;

ALTER TABLE display_schedules
  ADD COLUMN display_name VARCHAR(255) NULL AFTER customer_id;

ALTER TABLE sensor_units
  ADD COLUMN parking_type VARCHAR(255) NULL AFTER sensor_id,
  ADD COLUMN temp_parking_time_minutes INT NULL AFTER parking_type;
