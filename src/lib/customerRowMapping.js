/**
 * Pure mapping between Postgres rows (snake_case, see supabase/migrations/0001_schema.sql
 * and 0009_device_field_normalization.sql) and the legacy in-memory customer shape
 * (`customer.sites[].levels[].devices[]`) the app and the Sheets export both expect.
 *
 * Deliberately dependency-free (no Supabase client, no Vite/browser globals) so it can be
 * imported from both browser code (CustomerRepository.js) and a plain Node serverless
 * function (api/export-to-sheets.js). This is also why the traffic-flow target-key
 * join/split helpers below are small local copies of src/lib/trafficFlowUtils.js's
 * logic rather than an import — the separator (':') must stay in sync with that file.
 */

const DEVICE_FAMILY_BY_PREFIX = [
  ['cam-', 'camera'],
  ['sign-', 'sign'],
  ['sensor-', 'sensor'],
];

export function familyForDeviceType(type) {
  const match = DEVICE_FAMILY_BY_PREFIX.find(([prefix]) => String(type || '').startsWith(prefix));
  if (!match) throw new Error(`Unknown device type "${type}" — cannot determine its family.`);
  return match[1];
}

const TRAFFIC_KEY_SEPARATOR = ':';

function joinTrafficKey(levelId, zoneId) {
  if (levelId == null || levelId === '') return '';
  return zoneId ? `${levelId}${TRAFFIC_KEY_SEPARATOR}${zoneId}` : String(levelId);
}

function splitTrafficKey(key) {
  const raw = String(key ?? '');
  if (!raw) return { levelId: '', zoneId: '' };
  const i = raw.indexOf(TRAFFIC_KEY_SEPARATOR);
  if (i < 0) return { levelId: raw, zoneId: '' };
  return { levelId: raw.slice(0, i), zoneId: raw.slice(i + 1) };
}

/**
 * customer_addresses/customer_support/camera_details/sign_details/sensor_details
 * are all 1:1 with their parent (unique FK) — PostgREST embeds those as a single
 * object, not an array, but these helpers tolerate either shape defensively.
 */
function oneToOne(embedded) {
  if (Array.isArray(embedded)) return embedded[0] || null;
  return embedded || null;
}

function byPosition(rows) {
  return (rows || []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

// ---------------------------------------------------------------------------
// Devices: read side — assemble the legacy device object from a devices row
// plus every nested table PostgREST embedded under it (see
// DEVICE_NESTED_SELECT below for exactly what's embedded).
// ---------------------------------------------------------------------------

function cameraFieldsFromRow(row) {
  const details = oneToOne(row.camera_details) || {};
  const streams = row.camera_streams || [];
  const stream1Row = streams.find((s) => s.stream_number === 1);
  const stream2Row = streams.find((s) => s.stream_number === 2);
  const toStream = (s) => (s ? {
    ipAddress: s.ip_address ?? '',
    port: s.port ?? '',
    externalUrl: s.external_url ?? '',
    streamType: s.stream_type || row.type,
    ...(s.rotation != null ? { rotation: Number(s.rotation) } : {}),
    ...(s.cone_size != null ? { coneSize: s.cone_size } : {}),
    ...(s.color ? { color: s.color } : {}),
  } : undefined);
  const stream1 = toStream(stream1Row);
  const stream2 = toStream(stream2Row);
  const photos = byPosition(row.device_photos);
  const destinations = (row.camera_traffic_destinations || [])
    .map((d) => joinTrafficKey(d.target_level_id, d.target_zone_polygon_id))
    .filter(Boolean);

  return {
    hardwareType: details.hardware_type || 'bullet',
    ...(details.color ? { color: details.color } : {}),
    ...(details.cone_size != null ? { coneSize: details.cone_size } : {}),
    ...(details.resolution ? { resolution: details.resolution } : {}),
    isEntryExitCamera: details.is_entry_exit_camera ?? true,
    ...(details.dependent_camera_name ? { dependentCameraName: details.dependent_camera_name } : {}),
    ...(stream1 ? { stream1 } : {}),
    ...(stream2 ? { stream2 } : {}),
    // Legacy flat mirrors of stream1 — several read paths (getDeviceIp,
    // getDeviceRtsp, ExcelParserService-imported devices) fall back to these.
    ipAddress: stream1?.ipAddress ?? '',
    port: stream1?.port ?? '',
    rtspUrl: stream1?.externalUrl ?? '',
    trafficFlow: {
      direction: details.traffic_direction || '',
      level: details.traffic_level_id || '',
      zone: details.traffic_zone_polygon_id || '',
      multiLevel: Boolean(details.traffic_multi_level),
      destinations,
      comingFrom: details.traffic_coming_from || '',
    },
    ...(photos[0] ? { viewImage: photos[0].storage_path } : {}),
  };
}

function signFieldsFromRow(row) {
  const details = oneToOne(row.sign_details) || {};
  const photos = byPosition(row.device_photos);
  const displayLevelIds = (row.sign_display_levels || []).map((l) => l.level_id ?? l.zone_id).filter(Boolean);

  const fields = {
    controllerName: details.controller_name || '',
    visibleName: details.visible_name || '',
    displayProtocol: details.display_protocol || '',
    ...(details.hardware_type ? { hardwareType: details.hardware_type } : {}),
    displayGroupId: details.display_group_id ?? null,
    displaySiteId: details.display_site_id ?? null,
    displayLevelAll: Boolean(details.display_level_all),
    displayLevelIds,
    ...(details.position_name ? { positionName: details.position_name } : {}),
    ...(details.display_map ? { displayMap: details.display_map } : {}),
    keepLevelCountsSeparate: Boolean(details.keep_level_counts_separate),
    ...(details.serial_address ? { serialAddress: details.serial_address } : {}),
    ipAddress: details.ip_address || '',
    port: details.port || '',
    ...(details.mac_address ? { macAddress: details.mac_address } : {}),
    sided: details.sided || 'single',
    ...(details.bold_sides?.length ? { boldSides: details.bold_sides } : {}),
    ...(details.logical_key ? { signLogicalKey: details.logical_key } : {}),
    signImages: photos.map((p) => p.storage_path),
  };

  if (details.uses_inserts) {
    fields.inserts = byPosition(row.sign_inserts).map((ins) => ({
      id: ins.id,
      displayName: ins.display_name || '',
      serialAddress: ins.serial_address || '',
      hasEthernet: Boolean(ins.has_ethernet),
      displayLevelAll: Boolean(ins.display_level_all),
      displayLevelIds: (ins.sign_insert_levels || []).map((l) => l.level_id ?? l.zone_id).filter(Boolean),
    }));
  }

  return fields;
}

function sensorFieldsFromRow(row) {
  const details = oneToOne(row.sensor_details) || {};
  const units = byPosition(row.sensor_units);
  return {
    sensorGroup: details.sensor_protocol || row.type,
    configSensorGroupId: details.config_sensor_group_id ?? null,
    sensorCount: details.sensor_count ?? 1,
    ...(details.api_key ? { apiKey: details.api_key } : {}),
    ...(details.sensor_id ? { sensorId: details.sensor_id } : {}),
    ...(units.length ? {
      sensors: units.map((u) => ({ sensorName: u.sensor_name || '', sensorId: u.sensor_id || '' })),
    } : {}),
  };
}

export function dbDeviceToLegacy(row) {
  const base = {
    id: row.id,
    type: row.type,
    name: row.name ?? '',
    x: row.x ?? 0,
    y: row.y ?? 0,
    rotation: row.rotation ?? 0,
    serverId: row.server_id ?? null,
    mdfIdfLocationId: row.mdf_idf_location_id ?? null,
    friendlyName: row.friendly_name || '',
    dhcp: Boolean(row.dhcp),
    disabled: Boolean(row.disabled),
    disabledReason: row.disabled_reason || '',
    placementReason: row.placement_reason || '',
    pendingPlacement: Boolean(row.pending_placement),
    iconSize: row.icon_size ?? undefined,
    ...(row.server_name ? { server: row.server_name } : {}),
  };

  if (row.family === 'camera') return { ...base, ...cameraFieldsFromRow(row) };
  if (row.family === 'sign') return { ...base, ...signFieldsFromRow(row) };
  if (row.family === 'sensor') return { ...base, ...sensorFieldsFromRow(row) };
  return base;
}

// ---------------------------------------------------------------------------
// Devices: write side — split one legacy device object into rows for every
// table it now spans. `zoneIdSet` is the set of zone-entity ids in this
// site's in-memory levels tree (level.isZone) — needed because a level-or-zone
// selection (sign display levels, insert levels) can point at either the
// levels table or the zones table, and this pure function has no DB access
// of its own to tell them apart.
// ---------------------------------------------------------------------------

function levelOrZoneColumns(id, zoneIdSet) {
  if (id == null || id === '') return null;
  return zoneIdSet.has(String(id))
    ? { level_id: null, zone_id: id }
    : { level_id: id, zone_id: null };
}

function normalizeStream(raw, deviceType) {
  if (raw == null) return null;
  const obj = typeof raw === 'object' ? raw : { externalUrl: typeof raw === 'string' ? raw : '' };
  return {
    ip_address: obj.ipAddress ?? null,
    port: obj.port ?? null,
    external_url: obj.externalUrl ?? null,
    stream_type: obj.streamType || deviceType,
    rotation: obj.rotation ?? null,
    cone_size: obj.coneSize ?? null,
    color: obj.color ?? null,
  };
}

export function splitLegacyDevice(device, levelId, zoneIdSet) {
  const family = familyForDeviceType(device.type);
  const result = {
    device: {
      id: device.id,
      level_id: levelId,
      family,
      type: device.type,
      name: device.name ?? null,
      x: device.x ?? null,
      y: device.y ?? null,
      rotation: device.rotation ?? null,
      server_id: device.serverId ?? null,
      mdf_idf_location_id: device.mdfIdfLocationId ?? null,
      friendly_name: device.friendlyName ?? null,
      server_name: device.server ?? null,
      dhcp: Boolean(device.dhcp),
      disabled: Boolean(device.disabled),
      disabled_reason: device.disabledReason ?? null,
      placement_reason: device.placementReason ?? null,
      pending_placement: Boolean(device.pendingPlacement),
      icon_size: device.iconSize ?? null,
    },
    cameraDetails: null,
    streams: [],
    trafficDestinations: [],
    signDetails: null,
    signDisplayLevels: [],
    signInserts: [],
    sensorDetails: null,
    sensorUnits: [],
    photos: [],
  };

  if (family === 'camera') {
    const flow = device.trafficFlow || {};
    result.cameraDetails = {
      device_id: device.id,
      hardware_type: device.hardwareType || 'bullet',
      color: device.color ?? null,
      cone_size: device.coneSize ?? null,
      resolution: device.resolution ?? null,
      is_entry_exit_camera: device.isEntryExitCamera ?? true,
      dependent_camera_name: device.dependentCameraName ?? null,
      traffic_direction: flow.direction || null,
      traffic_level_id: flow.level || null,
      traffic_zone_polygon_id: flow.zone || null,
      traffic_multi_level: Boolean(flow.multiLevel),
      traffic_coming_from: flow.comingFrom ?? null,
    };

    // Fall back to legacy flat fields only if stream1 was never structured
    // (pre-dates the object shape) — everything app-created has stream1.
    const stream1Source = device.stream1 ?? (
      (device.ipAddress || device.port || device.rtspUrl)
        ? { ipAddress: device.ipAddress, port: device.port, externalUrl: device.rtspUrl, streamType: device.type }
        : null
    );
    const stream1 = normalizeStream(stream1Source, device.type);
    if (stream1) result.streams.push({ id: crypto.randomUUID(), device_id: device.id, stream_number: 1, ...stream1 });

    if (typeof device.stream2 === 'object' && device.stream2 !== null) {
      const stream2 = normalizeStream(device.stream2, device.type);
      result.streams.push({ id: crypto.randomUUID(), device_id: device.id, stream_number: 2, ...stream2 });
    }

    const destinations = Array.isArray(flow.destinations) ? flow.destinations : [];
    result.trafficDestinations = destinations
      .map((key) => splitTrafficKey(key))
      .filter((t) => t.levelId)
      .map((t) => ({
        id: crypto.randomUUID(),
        device_id: device.id,
        target_level_id: t.levelId,
        target_zone_polygon_id: t.zoneId || null,
      }));

    if (device.viewImage) {
      result.photos.push({ id: crypto.randomUUID(), device_id: device.id, position: 0, storage_path: device.viewImage });
    }
  } else if (family === 'sign') {
    result.signDetails = {
      device_id: device.id,
      controller_name: device.controllerName ?? null,
      visible_name: device.visibleName ?? null,
      display_protocol: device.displayProtocol ?? null,
      hardware_type: device.hardwareType ?? null,
      display_group_id: device.displayGroupId ?? null,
      display_site_id: device.displaySiteId ?? null,
      display_level_all: Boolean(device.displayLevelAll),
      position_name: device.positionName ?? null,
      display_map: device.displayMap ?? null,
      keep_level_counts_separate: Boolean(device.keepLevelCountsSeparate),
      serial_address: device.serialAddress ?? null,
      ip_address: device.ipAddress ?? null,
      port: device.port ?? null,
      mac_address: device.macAddress ?? null,
      sided: device.sided || 'single',
      bold_sides: Array.isArray(device.boldSides) ? device.boldSides : [],
      logical_key: device.signLogicalKey ?? null,
      uses_inserts: Array.isArray(device.inserts),
    };

    // Once a sign uses inserts, each insert owns its own display levels
    // (sign_insert_levels below) — the device-level displayLevelIds becomes
    // unused dead weight (nothing reads it: buildSignDisplayLevelSheetRows,
    // buildDisplayControllerSheetRows, and the inspector UI all switch to
    // per-insert fields once signUsesInserts() is true). Writing it anyway
    // just leaves a stale sign_display_levels row behind.
    const levelIds = Array.isArray(device.inserts) ? [] : (
      Array.isArray(device.displayLevelIds) ? device.displayLevelIds : []
    );
    result.signDisplayLevels = levelIds
      .map((id) => levelOrZoneColumns(id, zoneIdSet))
      .filter(Boolean)
      .map((cols) => ({ id: crypto.randomUUID(), device_id: device.id, ...cols }));

    if (Array.isArray(device.inserts)) {
      result.signInserts = device.inserts.map((ins, idx) => ({
        row: {
          id: ins.id,
          device_id: device.id,
          position: idx,
          display_name: ins.displayName ?? null,
          serial_address: ins.serialAddress ?? null,
          has_ethernet: Boolean(ins.hasEthernet),
          display_level_all: Boolean(ins.displayLevelAll),
        },
        levels: (Array.isArray(ins.displayLevelIds) ? ins.displayLevelIds : [])
          .map((id) => levelOrZoneColumns(id, zoneIdSet))
          .filter(Boolean)
          .map((cols) => ({ id: crypto.randomUUID(), insert_id: ins.id, ...cols })),
      }));
    }

    (device.signImages || []).forEach((path, idx) => {
      if (path) result.photos.push({ id: crypto.randomUUID(), device_id: device.id, position: idx, storage_path: path });
    });
  } else if (family === 'sensor') {
    result.sensorDetails = {
      device_id: device.id,
      sensor_protocol: device.sensorGroup || device.type,
      config_sensor_group_id: device.configSensorGroupId ?? null,
      sensor_count: device.sensorCount ?? 1,
      api_key: device.apiKey ?? null,
      sensor_id: device.sensorId ?? null,
    };
    if (Array.isArray(device.sensors)) {
      result.sensorUnits = device.sensors.map((s, idx) => ({
        id: crypto.randomUUID(),
        device_id: device.id,
        position: idx,
        sensor_name: s.sensorName ?? s.name ?? null,
        sensor_id: s.sensorId ?? null,
      }));
    }
  }

  return result;
}

export function dbServerToLegacy(row) {
  const portCount = Math.min(4, Math.max(1, row.port_count ?? 1));
  const ports = Array.from({ length: portCount }, (_, i) => {
    const n = i + 1;
    return {
      mac: row[`port${n}_mac`] ?? '',
      ip: row[`port${n}_ip`] ?? '',
      dhcp: Boolean(row[`port${n}_dhcp`]),
    };
  });
  return {
    id: row.id,
    manufacturer: row.manufacturer ?? '',
    device: row.device_type ?? '',
    name: row.name ?? '',
    status: row.status ?? '',
    location: row.location ?? '',
    mdfIdfLocation: row.mdf_idf_location ?? '',
    ipAddress: row.ip ?? '',
    macAddress: row.mac ?? '',
    ipAssignmentMethod: row.ip_assignment_method ?? '',
    subnet: row.subnet ?? '',
    gateway: row.gateway ?? '',
    dns: row.dns ?? '',
    username: row.username ?? '',
    password: row.password ?? '',
    notes: row.notes ?? '',
    streamAddress: row.stream_address ?? '',
    // LevelSelector's Servers tab fields (see 0013/0014_servers_*.sql) —
    // distinct from the legacy Networking-sheet fields above. port1-4_*
    // columns reassemble into the array shape the UI works with.
    type: row.type ?? '',
    os: row.os ?? '',
    model: row.model ?? '',
    ports,
    splashtopUser: row.splashtop_user ?? '',
    splashtopPassword: row.splashtop_password ?? '',
    splashtopUrl: row.splashtop_url ?? '',
  };
}

export function dbLevelToLegacy(row) {
  return {
    id: row.id,
    name: row.name,
    internalName: row.internal_name ?? row.name,
    totalSpots: row.total_spots ?? 0,
    evSpots: row.ev_spots ?? 0,
    handicapSpots: row.handicap_spots ?? 0,
    bgImage: row.bg_image_path ?? null,
    isZone: false,
    parentLevelId: null,
    // Zone polygon/shape data (level.zones) is canvas geometry with no
    // cross-table references — it rides inside levels.config jsonb under a
    // "zones" key, mirrored back out to the top-level `zones` field the app's
    // UI code expects. (Zone *entities* live in the zones table.)
    zones: row.config?.zones || [],
    config: row.config || {},
    devices: (row.devices || []).map(dbDeviceToLegacy),
  };
}

/**
 * Zones are level-shaped in app memory (they show in the level list with spot
 * counts) but live in their own `zones` table — see 0008_zones_table.sql.
 */
export function dbZoneToLegacy(row) {
  return {
    id: row.id,
    name: row.name,
    internalName: row.internal_name ?? row.name,
    totalSpots: row.total_spots ?? 0,
    evSpots: row.ev_spots ?? 0,
    handicapSpots: row.handicap_spots ?? 0,
    bgImage: null,
    isZone: true,
    parentLevelId: row.parent_level_id,
    zones: row.config?.zones || [],
    config: row.config || {},
    devices: [],
  };
}

/**
 * Drop zone polygons whose linked zone-level no longer exists. Orphans came
 * from zone rows deleted without their parent-floor outline being cleaned
 * (possible before 0008 made the link a real FK) — a ghost polygon renders on
 * the canvas and produces duplicate entries in the traffic-flow pickers.
 * Polygons with no link (plain drawings) are left alone.
 */
function pruneOrphanZonePolygons(levels) {
  const levelIds = new Set(levels.map((l) => String(l.id)));
  return levels.map((level) => {
    const zones = level.zones || [];
    const kept = zones.filter((z) => z?.linkedLevelId == null || levelIds.has(String(z.linkedLevelId)));
    return kept.length === zones.length ? level : { ...level, zones: kept };
  });
}

export function dbSiteToLegacy(row) {
  return {
    id: row.id,
    name: row.name,
    internalName: row.internal_name ?? row.name,
    address: row.address ?? '',
    city: row.city ?? '',
    state: row.state ?? '',
    zip: row.zip ?? '',
    mapsUrl: row.maps_url ?? '',
    image: row.image_path ?? '',
    quickLinks: row.quick_links || [],
    contacts: row.contacts || [],
    servers: (row.servers || []).map(dbServerToLegacy),
    displayGroups: (row.display_groups || []).map((g) => ({
      id: g.id,
      name: g.name,
      sendOnlyOnUpdates: g.send_only_on_updates,
      forceSendAfterSeconds: g.force_send_after_seconds,
    })),
    sensorGroups: (row.sensor_groups || []).map((g) => ({
      id: g.id,
      groupId: g.group_id,
      controllerAddress: g.controller_address,
      controllerKey: g.controller_key,
      sensorProtocol: g.sensor_protocol,
      // garage/g.garage_name are a 1:1 mirror of the legacy Sheets "Garage"
      // column (see configSheetSchema.js) — intentionally not renamed.
      garage: g.garage_name,
      level: g.level_name,
      parentLevel: g.parent_level,
    })),
    mdfIdfLocations: (row.mdf_idf_locations || []).map((m) => ({ id: m.id, name: m.name })),
    // Floors then zones — the UI splits them with floorLevels()/zoneLevels(),
    // so relative order between the groups doesn't matter.
    levels: pruneOrphanZonePolygons([
      ...(row.levels || []).map(dbLevelToLegacy),
      ...(row.zones || []).map(dbZoneToLegacy),
    ]),
  };
}

/**
 * customer_addresses/customer_support are 1:1 with customers (unique customer_id
 * FK) — PostgREST embeds a unique-FK relationship as a single object, not an
 * array, but these helpers tolerate either shape defensively.
 */
export function dbCustomerConfigToLegacy(row) {
  const addr = oneToOne(row.customer_addresses) || {};
  const support = oneToOne(row.customer_support) || {};
  return {
    address: addr.address ?? '',
    city: addr.city ?? '',
    state: addr.state ?? '',
    zip: addr.zip ?? '',
    mapsUrl: addr.maps_url ?? '',
    support: {
      maintenanceProvider: support.maintenance_provider ?? '',
      maintenanceOther: support.maintenance_other ?? '',
      enterpriseSite: support.enterprise_site ?? false,
      support24Hour: support.support_24_hour ?? false,
    },
  };
}

/** Reshape a customers-table nested-select row into the full legacy customer object. */
export function dbCustomerToLegacy(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    code: row.code,
    friendlyName: row.friendly_name,
    configSheetName: row.config_sheet_name,
    config: dbCustomerConfigToLegacy(row),
    sites: (row.sites || []).map(dbSiteToLegacy),
    displaySchedules: (row.display_schedules || []).map((s) => ({
      id: s.id,
      StartTime: s.start_time,
      EndTime: s.end_time,
      Day: s.day,
      CountPosition: s.count_position,
      FilePath: s.file_path,
      Garage1: s.garage1,
      Level1: s.level1,
      Garage2: s.garage2,
      Level2: s.level2,
    })),
    lastSetupSavedAt: row.updated_at,
  };
}

/** Every table a device can span — see 0009_device_field_normalization.sql. */
const DEVICE_NESTED_SELECT = `
  *,
  camera_details(*),
  camera_streams(*),
  camera_traffic_destinations(*),
  sign_details(*),
  sign_display_levels(*),
  sign_inserts(*, sign_insert_levels(*)),
  sensor_details(*),
  sensor_units(*),
  device_photos(*)
`;

/** The nested-select clause both CustomerRepository and the export endpoint query. */
export const CUSTOMER_FULL_TREE_SELECT = `
  *,
  display_schedules(*),
  customer_addresses(*),
  customer_support(*),
  sites(
    *,
    servers(*),
    display_groups(*),
    sensor_groups(*),
    mdf_idf_locations(*),
    levels(*, devices(${DEVICE_NESTED_SELECT})),
    zones(*)
  )
`;
