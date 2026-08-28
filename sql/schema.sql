-- =============================================================================
-- garage-layout-editor — MySQL 8.0+ schema
-- Translated from the live Supabase/Postgres schema (14 migrations, traced by
-- hand from supabase/migrations/0001..0014, not auto-dumped) as of 2026-08-19.
--
-- Translation notes (read before running):
--   - uuid            -> CHAR(36), default (UUID()). The app already generates
--                        its own UUIDs client-side (crypto.randomUUID()) for
--                        every row on insert, so the DEFAULT here is just a
--                        safety net for direct SQL inserts, not load-bearing.
--   - text            -> VARCHAR(255) for short/label fields, TEXT for the
--                        handful of genuinely free-text/URL fields, so normal
--                        DEFAULT '' works everywhere without hitting MySQL's
--                        historical TEXT-column-default restrictions.
--   - jsonb           -> JSON (native since MySQL 5.7/8.0).
--   - text[]           -> JSON (MySQL has no array type at all — this is the
--                        one real "not a copy-paste" schema change; only
--                        sign_details.bold_sides uses it).
--   - timestamptz      -> TIMESTAMP. updated_at columns use MySQL's native
--                        ON UPDATE CURRENT_TIMESTAMP instead of a trigger —
--                        Postgres needed a trigger for this, MySQL doesn't.
--   - enum types       -> native MySQL ENUM(...).
--   - Postgres RLS,
--     is_ensight_staff(),
--     Storage buckets,
--     Realtime publication -> all omitted. There is no MySQL equivalent to
--     row-level security; per the "overkill" call already made, authorization
--     moves into the API layer (Lambda/whatever) instead of the database.
--   - CHECK constraints -> kept; MySQL enforces these as of 8.0.16. If you're
--     on an older 8.0.x, they parse but are silently ignored — upgrade first.
--   - Every table is InnoDB (required for foreign keys) + utf8mb4 (full
--     Unicode — the app has real data with emoji/special characters in names).
-- =============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------------
-- customers
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  id                 CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  customer_id        VARCHAR(255) NOT NULL UNIQUE,
  code               VARCHAR(255) NOT NULL DEFAULT '',
  friendly_name      VARCHAR(255) NOT NULL,
  config_sheet_name  VARCHAR(255) NOT NULL,
  spreadsheet_id     VARCHAR(255) NULL,
  spreadsheet_url    TEXT         NULL,
  last_exported_at   TIMESTAMP    NULL,
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- customer_addresses (1:1 with customers)
-- ---------------------------------------------------------------------------
CREATE TABLE customer_addresses (
  id           CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  customer_id  CHAR(36)     NOT NULL UNIQUE,
  address      VARCHAR(255) NOT NULL DEFAULT '',
  city         VARCHAR(255) NOT NULL DEFAULT '',
  state        VARCHAR(255) NOT NULL DEFAULT '',
  zip          VARCHAR(255) NOT NULL DEFAULT '',
  maps_url     TEXT         NOT NULL DEFAULT (''),
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_customer_addresses_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- customer_support (1:1 with customers)
-- ---------------------------------------------------------------------------
CREATE TABLE customer_support (
  id                    CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  customer_id           CHAR(36) NOT NULL UNIQUE,
  maintenance_provider  ENUM('ensight','aps','other') NULL,
  maintenance_other     VARCHAR(255) NOT NULL DEFAULT '',
  enterprise_site       BOOLEAN NOT NULL DEFAULT FALSE,
  support_24_hour       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_customer_support_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- display_schedules
-- ---------------------------------------------------------------------------
CREATE TABLE display_schedules (
  id              CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  customer_id     CHAR(36) NOT NULL,
  start_time      VARCHAR(255) NULL,
  end_time        VARCHAR(255) NULL,
  day             VARCHAR(255) NULL,
  count_position  JSON NULL,
  file_path       TEXT NULL,
  garage1         VARCHAR(255) NULL,
  level1          VARCHAR(255) NULL,
  garage2         VARCHAR(255) NULL,
  level2          VARCHAR(255) NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_display_schedules_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  INDEX idx_display_schedules_customer (customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- sites (was "garages" before the 2026-08-18 rename)
-- ---------------------------------------------------------------------------
CREATE TABLE sites (
  id             CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  customer_id    CHAR(36) NOT NULL,
  name           VARCHAR(255) NOT NULL,
  internal_name  VARCHAR(255) NULL,
  address        VARCHAR(255) NULL,
  city           VARCHAR(255) NULL,
  state          VARCHAR(255) NULL,
  zip            VARCHAR(255) NULL,
  maps_url       TEXT NULL,
  image_path     TEXT NULL,
  quick_links    JSON NOT NULL DEFAULT (JSON_ARRAY()),
  contacts       JSON NOT NULL DEFAULT (JSON_ARRAY()),
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_sites_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  INDEX idx_sites_customer (customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- servers (site-scoped; ports are 4 fixed flat slots, not an array)
-- ---------------------------------------------------------------------------
CREATE TABLE servers (
  id                     CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  site_id                CHAR(36) NOT NULL,
  manufacturer           VARCHAR(255) NULL,
  device_type            VARCHAR(255) NULL,
  name                   VARCHAR(255) NULL,
  status                 VARCHAR(255) NULL,
  location               VARCHAR(255) NULL,
  mdf_idf_location       VARCHAR(255) NULL,
  ip                     VARCHAR(255) NULL,
  mac                    VARCHAR(255) NULL,
  ip_assignment_method   VARCHAR(255) NULL,
  subnet                 VARCHAR(255) NULL,
  gateway                VARCHAR(255) NULL,
  dns                    VARCHAR(255) NULL,
  username               VARCHAR(255) NULL,
  password               VARCHAR(255) NULL,
  notes                  TEXT NULL,
  stream_address         TEXT NULL,
  type                   VARCHAR(255) NOT NULL DEFAULT '',
  os                     VARCHAR(255) NOT NULL DEFAULT '',
  model                  VARCHAR(255) NOT NULL DEFAULT '',
  port_count             SMALLINT NOT NULL DEFAULT 1,
  port1_mac              VARCHAR(255) NOT NULL DEFAULT '',
  port1_ip               VARCHAR(255) NOT NULL DEFAULT '',
  port1_dhcp             BOOLEAN NOT NULL DEFAULT FALSE,
  port2_mac              VARCHAR(255) NOT NULL DEFAULT '',
  port2_ip               VARCHAR(255) NOT NULL DEFAULT '',
  port2_dhcp             BOOLEAN NOT NULL DEFAULT FALSE,
  port3_mac              VARCHAR(255) NOT NULL DEFAULT '',
  port3_ip               VARCHAR(255) NOT NULL DEFAULT '',
  port3_dhcp             BOOLEAN NOT NULL DEFAULT FALSE,
  port4_mac              VARCHAR(255) NOT NULL DEFAULT '',
  port4_ip               VARCHAR(255) NOT NULL DEFAULT '',
  port4_dhcp             BOOLEAN NOT NULL DEFAULT FALSE,
  splashtop_user         VARCHAR(255) NOT NULL DEFAULT '',
  splashtop_password     VARCHAR(255) NOT NULL DEFAULT '',
  splashtop_url          TEXT NOT NULL DEFAULT (''),
  created_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_servers_site FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
  INDEX idx_servers_site (site_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- display_groups
-- ---------------------------------------------------------------------------
CREATE TABLE display_groups (
  id                        CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  site_id                   CHAR(36) NOT NULL,
  name                      VARCHAR(255) NOT NULL,
  send_only_on_updates      BOOLEAN NOT NULL DEFAULT FALSE,
  force_send_after_seconds  INT NULL,
  CONSTRAINT fk_display_groups_site FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
  INDEX idx_display_groups_site (site_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- sensor_groups
-- garage_name/level_name are intentional 1:1 mirrors of legacy Google Sheets
-- columns — kept exactly as-is, not renamed, same as in the live Postgres db.
-- ---------------------------------------------------------------------------
CREATE TABLE sensor_groups (
  id                   CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  site_id              CHAR(36) NOT NULL,
  group_id             VARCHAR(255) NOT NULL,
  controller_address   VARCHAR(255) NULL,
  controller_key       VARCHAR(255) NULL,
  sensor_protocol      VARCHAR(255) NULL DEFAULT 'NWAVE',
  garage_name          VARCHAR(255) NULL,
  level_name           VARCHAR(255) NULL,
  parent_level         VARCHAR(255) NULL,
  CONSTRAINT fk_sensor_groups_site FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
  INDEX idx_sensor_groups_site (site_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- mdf_idf_locations
-- ---------------------------------------------------------------------------
CREATE TABLE mdf_idf_locations (
  id       CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  site_id  CHAR(36) NOT NULL,
  name     VARCHAR(255) NOT NULL,
  CONSTRAINT fk_mdf_idf_locations_site FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
  INDEX idx_mdf_idf_locations_site (site_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- levels (floors only — zones are their own table below)
-- ---------------------------------------------------------------------------
CREATE TABLE levels (
  id              CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  site_id         CHAR(36) NOT NULL,
  name            VARCHAR(255) NOT NULL,
  internal_name   VARCHAR(255) NULL,
  total_spots     INT NULL DEFAULT 100,
  ev_spots        INT NULL DEFAULT 0,
  handicap_spots  INT NULL DEFAULT 0,
  bg_image_path   TEXT NULL,
  config          JSON NOT NULL DEFAULT (JSON_OBJECT()),
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_levels_site FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
  INDEX idx_levels_site (site_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- zones — first-class rows, but the drawn polygon geometry itself still lives
-- in the PARENT level's config JSON ("zones" key) — a zone row here is the
-- entity (spot counts, name), not the canvas shape.
-- ---------------------------------------------------------------------------
CREATE TABLE zones (
  id               CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  site_id          CHAR(36) NOT NULL,
  parent_level_id  CHAR(36) NOT NULL,
  name             VARCHAR(255) NOT NULL,
  internal_name    VARCHAR(255) NULL,
  total_spots      INT NULL DEFAULT 0,
  ev_spots         INT NULL DEFAULT 0,
  handicap_spots   INT NULL DEFAULT 0,
  config           JSON NOT NULL DEFAULT (JSON_OBJECT()),
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_zones_site FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
  CONSTRAINT fk_zones_parent_level FOREIGN KEY (parent_level_id) REFERENCES levels(id) ON DELETE CASCADE,
  INDEX idx_zones_site (site_id),
  INDEX idx_zones_parent_level (parent_level_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- devices — shared columns for every camera/sign/sensor; family-specific
-- fields live in the *_details / child tables below.
-- ---------------------------------------------------------------------------
CREATE TABLE devices (
  id                    CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  level_id              CHAR(36) NOT NULL,
  family                ENUM('camera','sign','sensor') NOT NULL,
  type                  VARCHAR(255) NOT NULL,
  name                  VARCHAR(255) NULL,
  x                     DOUBLE NULL,
  y                     DOUBLE NULL,
  rotation              DOUBLE NULL,
  server_id             CHAR(36) NULL,
  friendly_name         VARCHAR(255) NULL,
  mdf_idf_location_id   CHAR(36) NULL,
  server_name           VARCHAR(255) NULL,
  dhcp                  BOOLEAN NOT NULL DEFAULT FALSE,
  disabled              BOOLEAN NOT NULL DEFAULT FALSE,
  disabled_reason       TEXT NULL,
  placement_reason      TEXT NULL,
  pending_placement     BOOLEAN NOT NULL DEFAULT FALSE,
  icon_size             INT NULL,
  created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_devices_level FOREIGN KEY (level_id) REFERENCES levels(id) ON DELETE CASCADE,
  CONSTRAINT fk_devices_server FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL,
  CONSTRAINT fk_devices_mdf_idf_location FOREIGN KEY (mdf_idf_location_id) REFERENCES mdf_idf_locations(id) ON DELETE SET NULL,
  INDEX idx_devices_level (level_id),
  INDEX idx_devices_family_type (family, type),
  INDEX idx_devices_server (server_id),
  INDEX idx_devices_mdf_idf_location (mdf_idf_location_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- camera_details (1:1 with devices where family = 'camera')
-- ---------------------------------------------------------------------------
CREATE TABLE camera_details (
  device_id                CHAR(36) NOT NULL PRIMARY KEY,
  hardware_type            VARCHAR(255) NOT NULL DEFAULT 'bullet',
  color                    VARCHAR(255) NULL,
  cone_size                INT NULL,
  resolution               VARCHAR(255) NULL,
  is_entry_exit_camera     BOOLEAN NOT NULL DEFAULT TRUE,
  dependent_camera_name    VARCHAR(255) NULL,
  traffic_direction        VARCHAR(255) NULL,
  traffic_level_id         CHAR(36) NULL,
  -- Not a FK: can point at a drawn zone *polygon* id, which lives inside the
  -- target floor's levels.config JSON — canvas geometry, not a table row.
  traffic_zone_polygon_id  CHAR(36) NULL,
  traffic_multi_level      BOOLEAN NOT NULL DEFAULT FALSE,
  traffic_coming_from      VARCHAR(255) NULL,
  CONSTRAINT fk_camera_details_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  CONSTRAINT fk_camera_details_traffic_level FOREIGN KEY (traffic_level_id) REFERENCES levels(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- camera_streams (1 or 2 rows per camera — dual-lens cameras have both)
-- ---------------------------------------------------------------------------
CREATE TABLE camera_streams (
  id             CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  device_id      CHAR(36) NOT NULL,
  stream_number  SMALLINT NOT NULL,
  ip_address     VARCHAR(255) NULL,
  port           VARCHAR(255) NULL,
  external_url   TEXT NULL,
  stream_type    VARCHAR(255) NULL,
  rotation       DOUBLE NULL,
  cone_size      INT NULL,
  color          VARCHAR(255) NULL,
  CONSTRAINT fk_camera_streams_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  CONSTRAINT chk_camera_streams_number CHECK (stream_number IN (1, 2)),
  UNIQUE KEY uq_camera_streams_device_number (device_id, stream_number),
  INDEX idx_camera_streams_device (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- camera_traffic_destinations
-- ---------------------------------------------------------------------------
CREATE TABLE camera_traffic_destinations (
  id                       CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  device_id                CHAR(36) NOT NULL,
  target_level_id          CHAR(36) NOT NULL,
  target_zone_polygon_id   CHAR(36) NULL,
  CONSTRAINT fk_camera_traffic_destinations_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  CONSTRAINT fk_camera_traffic_destinations_level FOREIGN KEY (target_level_id) REFERENCES levels(id) ON DELETE CASCADE,
  INDEX idx_camera_traffic_destinations_device (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- sign_details (1:1 with devices where family = 'sign')
-- bold_sides was text[] in Postgres — MySQL has no array type, so it's JSON
-- here (e.g. '["top","bottom"]'). uses_inserts distinguishes "plain sign,
-- zero levels chosen yet" from "monument sign with zero inserts currently" —
-- row count alone can't tell those apart, hence the explicit flag.
-- ---------------------------------------------------------------------------
CREATE TABLE sign_details (
  device_id                     CHAR(36) NOT NULL PRIMARY KEY,
  controller_name               VARCHAR(255) NULL,
  visible_name                  VARCHAR(255) NULL,
  display_protocol              VARCHAR(255) NULL,
  hardware_type                 VARCHAR(255) NULL,
  display_group_id              CHAR(36) NULL,
  display_site_id               CHAR(36) NULL,
  display_level_all             BOOLEAN NOT NULL DEFAULT FALSE,
  position_name                 VARCHAR(255) NULL,
  display_map                   VARCHAR(255) NULL,
  keep_level_counts_separate    BOOLEAN NOT NULL DEFAULT FALSE,
  serial_address                VARCHAR(255) NULL,
  ip_address                    VARCHAR(255) NULL,
  port                          VARCHAR(255) NULL,
  mac_address                   VARCHAR(255) NULL,
  sided                         VARCHAR(255) NOT NULL DEFAULT 'single',
  bold_sides                    JSON NOT NULL DEFAULT (JSON_ARRAY()),
  logical_key                   VARCHAR(255) NULL,
  uses_inserts                  BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT fk_sign_details_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  CONSTRAINT fk_sign_details_display_group FOREIGN KEY (display_group_id) REFERENCES display_groups(id) ON DELETE SET NULL,
  CONSTRAINT fk_sign_details_display_site FOREIGN KEY (display_site_id) REFERENCES sites(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- sign_display_levels — one row per level/zone a non-insert sign displays on.
-- Exactly one of level_id/zone_id must be set (a "level" selection can be
-- either a real floor or a zone-level entity).
-- ---------------------------------------------------------------------------
CREATE TABLE sign_display_levels (
  id          CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  device_id   CHAR(36) NOT NULL,
  level_id    CHAR(36) NULL,
  zone_id     CHAR(36) NULL,
  CONSTRAINT fk_sign_display_levels_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  CONSTRAINT fk_sign_display_levels_level FOREIGN KEY (level_id) REFERENCES levels(id) ON DELETE CASCADE,
  CONSTRAINT fk_sign_display_levels_zone FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE,
  CONSTRAINT chk_sign_display_levels_one_target CHECK ((level_id IS NOT NULL) + (zone_id IS NOT NULL) = 1),
  INDEX idx_sign_display_levels_device (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- sign_inserts — monument signs: one physical enclosure, multiple inserts
-- sharing an IP. display_level_all is each insert's OWN "all levels" flag,
-- independent of sign_details.display_level_all (which only applies when the
-- sign has no inserts at all).
-- ---------------------------------------------------------------------------
CREATE TABLE sign_inserts (
  id                  CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  device_id           CHAR(36) NOT NULL,
  position             INT NOT NULL DEFAULT 0,
  display_name         VARCHAR(255) NULL,
  serial_address       VARCHAR(255) NULL,
  has_ethernet         BOOLEAN NOT NULL DEFAULT FALSE,
  display_level_all    BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT fk_sign_inserts_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  INDEX idx_sign_inserts_device (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- sign_insert_levels — same "exactly one of level/zone" shape as
-- sign_display_levels, but per insert instead of per sign.
-- ---------------------------------------------------------------------------
CREATE TABLE sign_insert_levels (
  id          CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  insert_id   CHAR(36) NOT NULL,
  level_id    CHAR(36) NULL,
  zone_id     CHAR(36) NULL,
  CONSTRAINT fk_sign_insert_levels_insert FOREIGN KEY (insert_id) REFERENCES sign_inserts(id) ON DELETE CASCADE,
  CONSTRAINT fk_sign_insert_levels_level FOREIGN KEY (level_id) REFERENCES levels(id) ON DELETE CASCADE,
  CONSTRAINT fk_sign_insert_levels_zone FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE,
  CONSTRAINT chk_sign_insert_levels_one_target CHECK ((level_id IS NOT NULL) + (zone_id IS NOT NULL) = 1),
  INDEX idx_sign_insert_levels_insert (insert_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- sensor_details (1:1 with devices where family = 'sensor')
-- ---------------------------------------------------------------------------
CREATE TABLE sensor_details (
  device_id                CHAR(36) NOT NULL PRIMARY KEY,
  sensor_protocol          VARCHAR(255) NULL,
  config_sensor_group_id   CHAR(36) NULL,
  sensor_count             INT NOT NULL DEFAULT 1,
  api_key                  VARCHAR(255) NULL,
  -- Legacy single-unit fallback id (pre-multi-unit import format).
  sensor_id                VARCHAR(255) NULL,
  CONSTRAINT fk_sensor_details_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  CONSTRAINT fk_sensor_details_group FOREIGN KEY (config_sensor_group_id) REFERENCES sensor_groups(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- sensor_units — legacy/import multi-unit devices (one device housing
-- several physical sensors). The app's own UI never creates more than one.
-- ---------------------------------------------------------------------------
CREATE TABLE sensor_units (
  id           CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  device_id    CHAR(36) NOT NULL,
  position     INT NOT NULL DEFAULT 0,
  sensor_name  VARCHAR(255) NULL,
  sensor_id    VARCHAR(255) NULL,
  CONSTRAINT fk_sensor_units_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  INDEX idx_sensor_units_device (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- device_photos — Storage object paths (S3 keys), not blobs. position 0 is
-- a camera's single view photo; signs can have up to 10 (app-enforced, not
-- a DB constraint here either — same as it was in Postgres).
-- ---------------------------------------------------------------------------
CREATE TABLE device_photos (
  id             CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  device_id      CHAR(36) NOT NULL,
  position       INT NOT NULL DEFAULT 0,
  storage_path   TEXT NOT NULL,
  CONSTRAINT fk_device_photos_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  INDEX idx_device_photos_device (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;
