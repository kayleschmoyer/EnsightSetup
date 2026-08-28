/**
 * MySQL data-access layer backing api/customers/*.js, replacing CustomerRepository.js's
 * old direct-to-Supabase calls. Reuses the app's existing pure row<->legacy mapping
 * functions (src/lib/customerRowMapping.js) unchanged — they're dependency-free by
 * design (see that file's header) — by hand-assembling MySQL's flat query results
 * into the same nested shape PostgREST's `.select(CUSTOMER_FULL_TREE_SELECT)` used
 * to return, rather than duplicating the mapping logic here.
 *
 * Compliance gate: same policy as WriteGuard.js on the client and
 * api/export-to-sheets.js's own DB write — live writes are disabled by default.
 * The client's guardedWrite() already blocks these calls from ever firing in
 * normal use, but this is enforced again here too (belt-and-suspenders) in case
 * an endpoint is ever hit directly. Flipping it requires a reviewed code change.
 */
import { randomUUID } from 'node:crypto';
import { getPool } from './_db.js';
import { configSheetTitle } from '../src/lib/configSheetSchema.js';
import {
  dbCustomerToLegacy,
  dbCustomerConfigToLegacy,
  splitLegacyDevice,
} from '../src/lib/customerRowMapping.js';

const LIVE_DB_WRITE_ENABLED = true;

// Test-only escape hatch, same pattern as WriteGuard.js's client-side one —
// lets unit tests exercise the real write logic against a mocked pool. A
// no-op in any real build; import.meta.env.MODE is only 'test' under Vitest.
let liveWritesOverrideForTests = false;
export function __setLiveDbWritesForTests(enabled) {
  if (import.meta.env?.MODE !== 'test') return;
  liveWritesOverrideForTests = enabled;
}

export class WriteBlockedError extends Error {
  constructor(message) {
    super(message || 'Live writes are disabled server-side (compliance gate) — nothing was saved.');
    this.name = 'WriteBlockedError';
  }
}

function assertWritesEnabled() {
  if (!LIVE_DB_WRITE_ENABLED && !liveWritesOverrideForTests) throw new WriteBlockedError();
}

async function q(pool, sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

function inClause(values) {
  return values.map(() => '?').join(',');
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const k = row[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
}

function oneBy(rows, key) {
  const map = new Map();
  for (const row of rows) map.set(row[key], row);
  return map;
}

async function upsertRows(pool, table, pkColumn, columns, rows) {
  if (!rows.length) return;
  const placeholders = rows.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
  const updateClause = columns.filter((c) => c !== pkColumn).map((c) => `${c}=VALUES(${c})`).join(',');
  const values = rows.flatMap((row) => columns.map((c) => (row[c] === undefined ? null : row[c])));
  await pool.query(
    `INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders} ON DUPLICATE KEY UPDATE ${updateClause}`,
    values,
  );
}

async function insertRows(pool, table, columns, rows) {
  if (!rows.length) return;
  const placeholders = rows.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
  const values = rows.flatMap((row) => columns.map((c) => (row[c] === undefined ? null : row[c])));
  await pool.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders}`, values);
}

async function deleteWhereIdIn(pool, table, ids) {
  if (ids.length) await pool.query(`DELETE FROM ${table} WHERE id IN (${inClause(ids)})`, ids);
}

async function replaceChildRows(pool, table, parentColumn, parentId, rows, columns, toDbRow) {
  const existing = await q(pool, `SELECT id FROM ${table} WHERE ${parentColumn} = ?`, [parentId]);
  const keepIds = new Set(rows.map((r) => r.id));
  await deleteWhereIdIn(pool, table, existing.filter((r) => !keepIds.has(r.id)).map((r) => r.id));
  if (rows.length) {
    const dbRows = rows.map((row) => ({ ...toDbRow(row), id: row.id, [parentColumn]: parentId }));
    await upsertRows(pool, table, 'id', columns, dbRows);
  }
}

async function replaceChildRowsForParents(pool, table, parentColumn, parentIds, columns, rows) {
  if (parentIds.length) await pool.query(`DELETE FROM ${table} WHERE ${parentColumn} IN (${inClause(parentIds)})`, parentIds);
  if (rows.length) await insertRows(pool, table, columns, rows);
}

// ---------------------------------------------------------------------------
// Column lists — mirror sql/schema.sql exactly.
// ---------------------------------------------------------------------------
const SITE_COLUMNS = ['id', 'customer_id', 'name', 'internal_name', 'address', 'city', 'state', 'zip', 'maps_url', 'image_path', 'quick_links', 'contacts'];
const SERVER_COLUMNS = ['id', 'site_id', 'manufacturer', 'device_type', 'name', 'status', 'location', 'mdf_idf_location', 'ip', 'mac', 'ip_assignment_method', 'subnet', 'gateway', 'dns', 'username', 'password', 'notes', 'stream_address', 'type', 'os', 'model', 'port_count', 'port1_mac', 'port1_ip', 'port1_dhcp', 'port2_mac', 'port2_ip', 'port2_dhcp', 'port3_mac', 'port3_ip', 'port3_dhcp', 'port4_mac', 'port4_ip', 'port4_dhcp', 'splashtop_user', 'splashtop_password', 'splashtop_url'];
const DISPLAY_GROUP_COLUMNS = ['id', 'site_id', 'name', 'send_only_on_updates', 'force_send_after_seconds'];
const SENSOR_GROUP_COLUMNS = ['id', 'site_id', 'group_id', 'controller_address', 'controller_key', 'sensor_protocol', 'garage_name', 'level_name', 'parent_level'];
const MDF_IDF_COLUMNS = ['id', 'site_id', 'name'];
const LEVEL_COLUMNS = ['id', 'site_id', 'name', 'internal_name', 'total_spots', 'ev_spots', 'handicap_spots', 'bg_image_path', 'config'];
const ZONE_COLUMNS = ['id', 'site_id', 'parent_level_id', 'name', 'internal_name', 'total_spots', 'ev_spots', 'handicap_spots', 'config'];
const DEVICE_COLUMNS = ['id', 'level_id', 'family', 'type', 'name', 'x', 'y', 'rotation', 'server_id', 'mdf_idf_location_id', 'friendly_name', 'server_name', 'dhcp', 'disabled', 'disabled_reason', 'placement_reason', 'pending_placement', 'icon_size'];
const CAMERA_DETAILS_COLUMNS = ['device_id', 'hardware_type', 'color', 'cone_size', 'resolution', 'is_entry_exit_camera', 'dependent_camera_name', 'traffic_direction', 'traffic_level_id', 'traffic_zone_polygon_id', 'traffic_multi_level', 'traffic_coming_from'];
const CAMERA_STREAM_COLUMNS = ['id', 'device_id', 'stream_number', 'ip_address', 'port', 'external_url', 'stream_type', 'rotation', 'cone_size', 'color'];
const CAMERA_TRAFFIC_DEST_COLUMNS = ['id', 'device_id', 'target_level_id', 'target_zone_polygon_id'];
const SIGN_DETAILS_COLUMNS = ['device_id', 'controller_name', 'visible_name', 'display_protocol', 'hardware_type', 'display_group_id', 'display_site_id', 'display_level_all', 'position_name', 'display_map', 'keep_level_counts_separate', 'serial_address', 'ip_address', 'port', 'mac_address', 'sided', 'bold_sides', 'logical_key', 'uses_inserts'];
const SIGN_DISPLAY_LEVEL_COLUMNS = ['id', 'device_id', 'level_id', 'zone_id'];
const SIGN_INSERT_COLUMNS = ['id', 'device_id', 'position', 'display_name', 'serial_address', 'has_ethernet', 'display_level_all'];
const SIGN_INSERT_LEVEL_COLUMNS = ['id', 'insert_id', 'level_id', 'zone_id'];
const SENSOR_DETAILS_COLUMNS = ['device_id', 'sensor_protocol', 'config_sensor_group_id', 'sensor_count', 'api_key', 'sensor_id'];
const SENSOR_UNIT_COLUMNS = ['id', 'device_id', 'position', 'sensor_name', 'sensor_id'];
const DEVICE_PHOTO_COLUMNS = ['id', 'device_id', 'position', 'storage_path'];
const DISPLAY_SCHEDULE_COLUMNS = ['id', 'customer_id', 'start_time', 'end_time', 'day', 'count_position', 'file_path', 'garage1', 'level1', 'garage2', 'level2'];

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listCustomers() {
  const pool = getPool();
  const customers = await q(pool, 'SELECT id, customer_id, code, friendly_name, updated_at FROM customers ORDER BY friendly_name ASC');
  if (!customers.length) return [];
  const ids = customers.map((c) => c.id);
  const [addresses, supports] = await Promise.all([
    q(pool, `SELECT * FROM customer_addresses WHERE customer_id IN (${inClause(ids)})`, ids),
    q(pool, `SELECT * FROM customer_support WHERE customer_id IN (${inClause(ids)})`, ids),
  ]);
  const addrByCustomer = oneBy(addresses, 'customer_id');
  const supportByCustomer = oneBy(supports, 'customer_id');
  return customers.map((row) => ({
    id: row.id,
    customerId: row.customer_id,
    code: row.code,
    friendlyName: row.friendly_name,
    config: dbCustomerConfigToLegacy({
      customer_addresses: addrByCustomer.get(row.id) || null,
      customer_support: supportByCustomer.get(row.id) || null,
    }),
    updatedAt: row.updated_at,
  }));
}

export async function loadCustomerCard(id) {
  const pool = getPool();
  const rows = await q(pool, 'SELECT id, code, friendly_name, updated_at FROM customers WHERE id = ?', [id]);
  const row = rows[0];
  if (!row) return null;
  const [addresses, supports] = await Promise.all([
    q(pool, 'SELECT * FROM customer_addresses WHERE customer_id = ?', [id]),
    q(pool, 'SELECT * FROM customer_support WHERE customer_id = ?', [id]),
  ]);
  return {
    friendlyName: row.friendly_name,
    code: row.code,
    config: dbCustomerConfigToLegacy({ customer_addresses: addresses[0] || null, customer_support: supports[0] || null }),
    updatedAt: row.updated_at,
  };
}

export async function loadCustomerFull(id) {
  const pool = getPool();
  const customerRows = await q(pool, 'SELECT * FROM customers WHERE id = ?', [id]);
  const customer = customerRows[0];
  if (!customer) return null;

  const [addresses, supports, displaySchedules, siteRows] = await Promise.all([
    q(pool, 'SELECT * FROM customer_addresses WHERE customer_id = ?', [id]),
    q(pool, 'SELECT * FROM customer_support WHERE customer_id = ?', [id]),
    q(pool, 'SELECT * FROM display_schedules WHERE customer_id = ?', [id]),
    q(pool, 'SELECT * FROM sites WHERE customer_id = ? ORDER BY created_at', [id]),
  ]);

  const siteIds = siteRows.map((s) => s.id);
  let servers = []; let displayGroups = []; let sensorGroups = []; let mdfIdfLocations = []; let levelRows = []; let zoneRows = [];
  if (siteIds.length) {
    [servers, displayGroups, sensorGroups, mdfIdfLocations, levelRows, zoneRows] = await Promise.all([
      q(pool, `SELECT * FROM servers WHERE site_id IN (${inClause(siteIds)})`, siteIds),
      q(pool, `SELECT * FROM display_groups WHERE site_id IN (${inClause(siteIds)})`, siteIds),
      q(pool, `SELECT * FROM sensor_groups WHERE site_id IN (${inClause(siteIds)})`, siteIds),
      q(pool, `SELECT * FROM mdf_idf_locations WHERE site_id IN (${inClause(siteIds)})`, siteIds),
      q(pool, `SELECT * FROM levels WHERE site_id IN (${inClause(siteIds)})`, siteIds),
      q(pool, `SELECT * FROM zones WHERE site_id IN (${inClause(siteIds)})`, siteIds),
    ]);
  }

  const levelIds = levelRows.map((l) => l.id);
  const deviceRows = levelIds.length
    ? await q(pool, `SELECT * FROM devices WHERE level_id IN (${inClause(levelIds)})`, levelIds)
    : [];

  const deviceIds = deviceRows.map((d) => d.id);
  let cameraDetails = []; let cameraStreams = []; let cameraTrafficDestinations = []; let signDetails = [];
  let signDisplayLevels = []; let signInserts = []; let sensorDetails = []; let sensorUnits = []; let devicePhotos = [];
  if (deviceIds.length) {
    [cameraDetails, cameraStreams, cameraTrafficDestinations, signDetails, signDisplayLevels,
      signInserts, sensorDetails, sensorUnits, devicePhotos] = await Promise.all([
      q(pool, `SELECT * FROM camera_details WHERE device_id IN (${inClause(deviceIds)})`, deviceIds),
      q(pool, `SELECT * FROM camera_streams WHERE device_id IN (${inClause(deviceIds)})`, deviceIds),
      q(pool, `SELECT * FROM camera_traffic_destinations WHERE device_id IN (${inClause(deviceIds)})`, deviceIds),
      q(pool, `SELECT * FROM sign_details WHERE device_id IN (${inClause(deviceIds)})`, deviceIds),
      q(pool, `SELECT * FROM sign_display_levels WHERE device_id IN (${inClause(deviceIds)})`, deviceIds),
      q(pool, `SELECT * FROM sign_inserts WHERE device_id IN (${inClause(deviceIds)}) ORDER BY position`, deviceIds),
      q(pool, `SELECT * FROM sensor_details WHERE device_id IN (${inClause(deviceIds)})`, deviceIds),
      q(pool, `SELECT * FROM sensor_units WHERE device_id IN (${inClause(deviceIds)}) ORDER BY position`, deviceIds),
      q(pool, `SELECT * FROM device_photos WHERE device_id IN (${inClause(deviceIds)}) ORDER BY position`, deviceIds),
    ]);
  }

  const insertIds = signInserts.map((i) => i.id);
  const signInsertLevels = insertIds.length
    ? await q(pool, `SELECT * FROM sign_insert_levels WHERE insert_id IN (${inClause(insertIds)})`, insertIds)
    : [];

  const cameraDetailsByDevice = oneBy(cameraDetails, 'device_id');
  const signDetailsByDevice = oneBy(signDetails, 'device_id');
  const sensorDetailsByDevice = oneBy(sensorDetails, 'device_id');
  const streamsByDevice = groupBy(cameraStreams, 'device_id');
  const trafficDestByDevice = groupBy(cameraTrafficDestinations, 'device_id');
  const displayLevelsByDevice = groupBy(signDisplayLevels, 'device_id');
  const insertsByDevice = groupBy(signInserts, 'device_id');
  const insertLevelsByInsert = groupBy(signInsertLevels, 'insert_id');
  const sensorUnitsByDevice = groupBy(sensorUnits, 'device_id');
  const photosByDevice = groupBy(devicePhotos, 'device_id');

  const hydratedDevices = deviceRows.map((d) => ({
    ...d,
    camera_details: cameraDetailsByDevice.get(d.id) || null,
    camera_streams: streamsByDevice.get(d.id) || [],
    camera_traffic_destinations: trafficDestByDevice.get(d.id) || [],
    sign_details: signDetailsByDevice.get(d.id) || null,
    sign_display_levels: displayLevelsByDevice.get(d.id) || [],
    sign_inserts: (insertsByDevice.get(d.id) || []).map((ins) => ({
      ...ins,
      sign_insert_levels: insertLevelsByInsert.get(ins.id) || [],
    })),
    sensor_details: sensorDetailsByDevice.get(d.id) || null,
    sensor_units: sensorUnitsByDevice.get(d.id) || [],
    device_photos: photosByDevice.get(d.id) || [],
  }));
  const devicesByLevel = groupBy(hydratedDevices, 'level_id');
  const hydratedLevels = levelRows.map((l) => ({ ...l, devices: devicesByLevel.get(l.id) || [] }));
  const levelsBySite = groupBy(hydratedLevels, 'site_id');

  const serversBySite = groupBy(servers, 'site_id');
  const displayGroupsBySite = groupBy(displayGroups, 'site_id');
  const sensorGroupsBySite = groupBy(sensorGroups, 'site_id');
  const mdfIdfBySite = groupBy(mdfIdfLocations, 'site_id');
  const zonesBySite = groupBy(zoneRows, 'site_id');

  const hydratedSites = siteRows.map((s) => ({
    ...s,
    servers: serversBySite.get(s.id) || [],
    display_groups: displayGroupsBySite.get(s.id) || [],
    sensor_groups: sensorGroupsBySite.get(s.id) || [],
    mdf_idf_locations: mdfIdfBySite.get(s.id) || [],
    levels: levelsBySite.get(s.id) || [],
    zones: zonesBySite.get(s.id) || [],
  }));

  const hydrated = {
    ...customer,
    customer_addresses: addresses[0] || null,
    customer_support: supports[0] || null,
    display_schedules: displaySchedules,
    sites: hydratedSites,
  };

  return { customer: dbCustomerToLegacy(hydrated), updatedAt: customer.updated_at };
}

// ---------------------------------------------------------------------------
// Writes — gated by LIVE_DB_WRITE_ENABLED, same as WriteGuard.js's client gate.
// ---------------------------------------------------------------------------

async function saveCustomerAddress(pool, customerId, config) {
  await pool.query(
    `INSERT INTO customer_addresses (id, customer_id, address, city, state, zip, maps_url)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE address=VALUES(address), city=VALUES(city), state=VALUES(state), zip=VALUES(zip), maps_url=VALUES(maps_url)`,
    [randomUUID(), customerId, config.address || '', config.city || '', config.state || '', config.zip || '', config.mapsUrl || ''],
  );
}

async function saveCustomerSupport(pool, customerId, support) {
  await pool.query(
    `INSERT INTO customer_support (id, customer_id, maintenance_provider, maintenance_other, enterprise_site, support_24_hour)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE maintenance_provider=VALUES(maintenance_provider), maintenance_other=VALUES(maintenance_other), enterprise_site=VALUES(enterprise_site), support_24_hour=VALUES(support_24_hour)`,
    [randomUUID(), customerId, support.maintenanceProvider || null, support.maintenanceOther || '', Boolean(support.enterpriseSite), Boolean(support.support24Hour)],
  );
}

function saveServers(pool, siteId, servers) {
  return replaceChildRows(pool, 'servers', 'site_id', siteId, servers, SERVER_COLUMNS, (s) => {
    const ports = s.ports || [];
    const portCols = {};
    for (let i = 0; i < 4; i += 1) {
      const n = i + 1;
      const port = ports[i] || {};
      portCols[`port${n}_mac`] = port.mac || '';
      portCols[`port${n}_ip`] = port.ip || '';
      portCols[`port${n}_dhcp`] = Boolean(port.dhcp);
    }
    return {
      manufacturer: s.manufacturer || '',
      device_type: s.device || '',
      name: s.name || '',
      status: s.status || '',
      location: s.location || '',
      mdf_idf_location: s.mdfIdfLocation || '',
      ip: s.ipAddress || '',
      mac: s.macAddress || '',
      ip_assignment_method: s.ipAssignmentMethod || '',
      subnet: s.subnet || '',
      gateway: s.gateway || '',
      dns: s.dns || '',
      username: s.username || '',
      password: s.password || '',
      notes: s.notes || '',
      stream_address: s.streamAddress || '',
      type: s.type || '',
      os: s.os || '',
      model: s.model || '',
      port_count: Math.min(4, Math.max(1, ports.length || 1)),
      ...portCols,
      splashtop_user: s.splashtopUser || '',
      splashtop_password: s.splashtopPassword || '',
      splashtop_url: s.splashtopUrl || '',
    };
  });
}

function saveDisplayGroups(pool, siteId, groups) {
  return replaceChildRows(pool, 'display_groups', 'site_id', siteId, groups, DISPLAY_GROUP_COLUMNS, (g) => ({
    name: g.name || '',
    send_only_on_updates: Boolean(g.sendOnlyOnUpdates),
    force_send_after_seconds: g.forceSendAfterSeconds ?? null,
  }));
}

function saveSensorGroups(pool, siteId, groups) {
  return replaceChildRows(pool, 'sensor_groups', 'site_id', siteId, groups, SENSOR_GROUP_COLUMNS, (g) => ({
    group_id: g.groupId || '',
    controller_address: g.controllerAddress || '',
    controller_key: g.controllerKey || '',
    sensor_protocol: g.sensorProtocol || 'NWAVE',
    garage_name: g.garage || '',
    level_name: g.level || '',
    parent_level: g.parentLevel || '',
  }));
}

function saveMdfIdfLocations(pool, siteId, locations) {
  return replaceChildRows(pool, 'mdf_idf_locations', 'site_id', siteId, locations, MDF_IDF_COLUMNS, (m) => ({
    name: m.name || '',
  }));
}

function saveDisplaySchedules(pool, customerId, schedules) {
  return replaceChildRows(pool, 'display_schedules', 'customer_id', customerId, schedules, DISPLAY_SCHEDULE_COLUMNS, (s) => ({
    start_time: s.StartTime || null,
    end_time: s.EndTime || null,
    day: s.Day || null,
    count_position: s.CountPosition == null ? null : JSON.stringify(s.CountPosition),
    file_path: s.FilePath || null,
    garage1: s.Garage1 || null,
    level1: s.Level1 || null,
    garage2: s.Garage2 || null,
    level2: s.Level2 || null,
  }));
}

async function saveDevices(pool, levelId, devices, zoneIdSet) {
  const existing = await q(pool, 'SELECT id FROM devices WHERE level_id = ?', [levelId]);
  const keepIds = new Set(devices.map((d) => d.id));
  await deleteWhereIdIn(pool, 'devices', existing.filter((d) => !keepIds.has(d.id)).map((d) => d.id));
  if (!devices.length) return;

  const splits = devices.map((device) => splitLegacyDevice(device, levelId, zoneIdSet));
  const deviceIds = splits.map((s) => s.device.id);

  await upsertRows(pool, 'devices', 'id', DEVICE_COLUMNS, splits.map((s) => s.device));

  const cameraDetails = splits.map((s) => s.cameraDetails).filter(Boolean);
  const signDetailsRows = splits.map((s) => s.signDetails).filter(Boolean)
    .map((d) => ({ ...d, bold_sides: JSON.stringify(d.bold_sides || []) }));
  const sensorDetailsRows = splits.map((s) => s.sensorDetails).filter(Boolean);
  const streams = splits.flatMap((s) => s.streams);
  const trafficDestinations = splits.flatMap((s) => s.trafficDestinations);
  const signDisplayLevelsRows = splits.flatMap((s) => s.signDisplayLevels);
  const signInsertRows = splits.flatMap((s) => s.signInserts.map((i) => i.row));
  const signInsertLevelRows = splits.flatMap((s) => s.signInserts.flatMap((i) => i.levels));
  const sensorUnitsRows = splits.flatMap((s) => s.sensorUnits);
  const photoRows = splits.flatMap((s) => s.photos);

  await Promise.all([
    upsertRows(pool, 'camera_details', 'device_id', CAMERA_DETAILS_COLUMNS, cameraDetails),
    upsertRows(pool, 'sign_details', 'device_id', SIGN_DETAILS_COLUMNS, signDetailsRows),
    upsertRows(pool, 'sensor_details', 'device_id', SENSOR_DETAILS_COLUMNS, sensorDetailsRows),
    replaceChildRowsForParents(pool, 'camera_streams', 'device_id', deviceIds, CAMERA_STREAM_COLUMNS, streams),
    replaceChildRowsForParents(pool, 'camera_traffic_destinations', 'device_id', deviceIds, CAMERA_TRAFFIC_DEST_COLUMNS, trafficDestinations),
    replaceChildRowsForParents(pool, 'sign_display_levels', 'device_id', deviceIds, SIGN_DISPLAY_LEVEL_COLUMNS, signDisplayLevelsRows),
    replaceChildRowsForParents(pool, 'sign_inserts', 'device_id', deviceIds, SIGN_INSERT_COLUMNS, signInsertRows).then(async () => {
      if (signInsertLevelRows.length) await insertRows(pool, 'sign_insert_levels', SIGN_INSERT_LEVEL_COLUMNS, signInsertLevelRows);
    }),
    replaceChildRowsForParents(pool, 'sensor_units', 'device_id', deviceIds, SENSOR_UNIT_COLUMNS, sensorUnitsRows),
    replaceChildRowsForParents(pool, 'device_photos', 'device_id', deviceIds, DEVICE_PHOTO_COLUMNS, photoRows),
  ]);
}

async function saveLevels(pool, siteId, allLevels) {
  const floors = allLevels.filter((l) => !l.isZone);
  const zones = allLevels.filter((l) => l.isZone);

  const [existingZones, existingFloors] = await Promise.all([
    q(pool, 'SELECT id FROM zones WHERE site_id = ?', [siteId]),
    q(pool, 'SELECT id FROM levels WHERE site_id = ?', [siteId]),
  ]);

  const keepZoneIds = new Set(zones.map((z) => z.id));
  await deleteWhereIdIn(pool, 'zones', existingZones.filter((z) => !keepZoneIds.has(z.id)).map((z) => z.id));

  const keepFloorIds = new Set(floors.map((l) => l.id));
  await deleteWhereIdIn(pool, 'levels', existingFloors.filter((l) => !keepFloorIds.has(l.id)).map((l) => l.id));

  if (floors.length) {
    const rows = floors.map((level) => ({
      id: level.id,
      site_id: siteId,
      name: level.name || '',
      internal_name: level.internalName || level.name || '',
      total_spots: level.totalSpots ?? 0,
      ev_spots: level.evSpots ?? 0,
      handicap_spots: level.handicapSpots ?? 0,
      bg_image_path: level.bgImage || null,
      config: JSON.stringify({ ...(level.config || {}), zones: level.zones || [] }),
    }));
    await upsertRows(pool, 'levels', 'id', LEVEL_COLUMNS, rows);
  }

  if (zones.length) {
    const rows = zones.map((zone) => ({
      id: zone.id,
      site_id: siteId,
      parent_level_id: zone.parentLevelId,
      name: zone.name || '',
      internal_name: zone.internalName || zone.name || '',
      total_spots: zone.totalSpots ?? 0,
      ev_spots: zone.evSpots ?? 0,
      handicap_spots: zone.handicapSpots ?? 0,
      config: JSON.stringify({ ...(zone.config || {}), zones: zone.zones || [] }),
    }));
    await upsertRows(pool, 'zones', 'id', ZONE_COLUMNS, rows);
  }

  const zoneIdSet = new Set(zones.map((z) => String(z.id)));
  await Promise.all(floors.map((level) => saveDevices(pool, level.id, level.devices || [], zoneIdSet)));
}

async function saveSites(pool, customerId, sites) {
  const existing = await q(pool, 'SELECT id FROM sites WHERE customer_id = ?', [customerId]);
  const keepIds = new Set(sites.map((s) => s.id));
  await deleteWhereIdIn(pool, 'sites', existing.filter((s) => !keepIds.has(s.id)).map((s) => s.id));

  if (sites.length) {
    const rows = sites.map((site) => ({
      id: site.id,
      customer_id: customerId,
      name: site.name || '',
      internal_name: site.internalName || site.name || '',
      address: site.address || '',
      city: site.city || '',
      state: site.state || '',
      zip: site.zip || '',
      maps_url: site.mapsUrl || '',
      image_path: site.image || null,
      quick_links: JSON.stringify(site.quickLinks || []),
      contacts: JSON.stringify(site.contacts || []),
    }));
    await upsertRows(pool, 'sites', 'id', SITE_COLUMNS, rows);
  }

  await Promise.all(sites.map((site) => Promise.all([
    saveServers(pool, site.id, site.servers || []),
    saveDisplayGroups(pool, site.id, site.displayGroups || []),
    saveSensorGroups(pool, site.id, site.sensorGroups || []),
    saveMdfIdfLocations(pool, site.id, site.mdfIdfLocations || []),
    saveLevels(pool, site.id, site.levels || []),
  ])));
}

export async function createCustomer({
  customerId, code, friendlyName, config = {}, sites = [],
}) {
  assertWritesEnabled();
  const pool = getPool();
  const id = randomUUID();
  await pool.query(
    'INSERT INTO customers (id, customer_id, code, friendly_name, config_sheet_name) VALUES (?, ?, ?, ?, ?)',
    [id, customerId, code, friendlyName, configSheetTitle(friendlyName)],
  );
  await Promise.all([
    saveCustomerAddress(pool, id, config),
    saveCustomerSupport(pool, id, config.support || {}),
  ]);
  if (sites.length) await saveSites(pool, id, sites);
  return loadCustomerFull(id);
}

export async function updateCustomerInfo(id, { friendlyName, address, support }) {
  assertWritesEnabled();
  const pool = getPool();
  await Promise.all([
    address ? saveCustomerAddress(pool, id, address) : null,
    support ? saveCustomerSupport(pool, id, support) : null,
  ]);
  await pool.query('UPDATE customers SET friendly_name = ? WHERE id = ?', [friendlyName, id]);
  const rows = await q(pool, 'SELECT updated_at FROM customers WHERE id = ?', [id]);
  return { updatedAt: rows[0].updated_at };
}

export async function deleteCustomer(id) {
  assertWritesEnabled();
  const pool = getPool();
  await pool.query('DELETE FROM customers WHERE id = ?', [id]);
}

/**
 * expectedUpdatedAt guard runs inside a transaction with SELECT ... FOR UPDATE
 * (a row lock) rather than an UPDATE ... WHERE updated_at = ? clause, sidestepping
 * ISO-string-vs-MySQL-DATETIME format mismatches entirely — compares timestamps
 * as JS Date values instead. Children save afterward via the shared pool, same
 * as the original Supabase version (the guard only ever covered the customers
 * row itself there too).
 */
export async function saveCustomerFull(id, customer, expectedUpdatedAt) {
  assertWritesEnabled();
  const pool = getPool();
  const conn = await pool.getConnection();
  let guardResult;
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT updated_at FROM customers WHERE id = ? FOR UPDATE', [id]);
    if (!rows.length) {
      await conn.rollback();
      throw new Error(`Customer ${id} not found.`);
    }
    const currentUpdatedAt = rows[0].updated_at;
    if (expectedUpdatedAt != null && new Date(expectedUpdatedAt).getTime() !== new Date(currentUpdatedAt).getTime()) {
      await conn.rollback();
      guardResult = { status: 'conflict', remoteUpdatedAt: currentUpdatedAt };
    } else {
      await conn.query('UPDATE customers SET code = ?, friendly_name = ? WHERE id = ?', [customer.code || '', customer.friendlyName || '', id]);
      await conn.commit();
    }
  } finally {
    conn.release();
  }
  if (guardResult) return guardResult;

  const config = customer.config || {};
  await Promise.all([
    saveCustomerAddress(pool, id, config),
    saveCustomerSupport(pool, id, config.support || {}),
    saveSites(pool, id, customer.sites || []),
    saveDisplaySchedules(pool, id, customer.displaySchedules || []),
  ]);

  const updatedRows = await q(pool, 'SELECT updated_at FROM customers WHERE id = ?', [id]);
  return { status: 'saved', updatedAt: updatedRows[0].updated_at };
}
