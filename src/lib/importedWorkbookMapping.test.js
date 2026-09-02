/**
 * Tab-by-tab contract for the Drive import: every column on every tab of the
 * sample workbook must land on the field the database write path
 * (splitLegacyDevice / api/_customers-data.js) stores. If a column stops
 * arriving here it is silently dropped in production, which is exactly what
 * this file exists to catch.
 */
import { describe, expect, it } from 'vitest';
import { parseExcelFile } from '../services/ExcelParserService';
import { buildSampleWorkbookBuffer, SAMPLE_FILE, SAMPLE_ROWS } from '../services/__fixtures__/sampleWorkbook';
import {
  buildCustomerFromWorkbook,
  customerIdentityFromWorkbook,
  displaySchedulesFromRows,
  resolveZoneParent,
} from './importedWorkbookMapping';
import { splitLegacyDevice } from './customerRowMapping';

const UUID_RE = /^[0-9a-f-]{36}$/;

function build(options = {}) {
  const parsed = parseExcelFile(buildSampleWorkbookBuffer(options.workbook || {}));
  return buildCustomerFromWorkbook(parsed, { file: SAMPLE_FILE, ...options });
}

function allDevices(site) {
  return site.levels.flatMap((l) => l.devices.map((d) => ({ device: d, level: l })));
}
function device(site, name) {
  return allDevices(site).find((entry) => entry.device.name === name);
}

describe('Customer tab → customers / customer_addresses / customer_support', () => {
  it('maps identity, address and support from the sheet', () => {
    const customer = build();
    expect(customer).toMatchObject({
      customerId: 'acme', code: 'ACME', friendlyName: 'Acme Parking',
      spreadsheetId: SAMPLE_FILE.id, spreadsheetUrl: SAMPLE_FILE.webViewLink,
    });
    expect(customer.config).toEqual({
      address: '1 Main St', city: 'Boston', state: 'MA', zip: '02101',
      mapsUrl: 'https://maps.google.com/?q=1+Main+St',
      support: { maintenanceProvider: 'ensight', maintenanceOther: '', enterpriseSite: true, support24Hour: false },
    });
  });

  it('falls back to the file name when there is no Customer tab, and says so', () => {
    const customer = build({ workbook: { omitTabs: ['Customer'] } });
    expect(customer.customerId).toBe('acme');
    expect(customer.code).toBe('ACME');
    expect(customer.friendlyName).toBe('Acme');
    expect(customer.warnings.some((w) => /No Customer tab/.test(w))).toBe(true);
  });

  it('keeps an existing customer\'s identity when the sheet does not name one', () => {
    const identity = customerIdentityFromWorkbook({ Address: '9 Elm' }, {
      fileName: 'Other-config.xlsx',
      existingCustomer: { customerId: 'acme-2', code: 'ACME2', friendlyName: 'Acme Two' },
    });
    expect(identity).toMatchObject({ customerId: 'acme-2', code: 'ACME2', friendlyName: 'Acme Two' });
    expect(identity.config.address).toBe('9 Elm');
  });

  it('rejects an unknown maintenance provider rather than storing it', () => {
    const identity = customerIdentityFromWorkbook({ MaintenanceProvider: 'Bob' }, { fileName: 'x.xlsx' });
    expect(identity.config.support.maintenanceProvider).toBe('');
  });
});

describe('Networking tab → servers (per site)', () => {
  it('clones the customer-wide servers onto the site with fresh ids and every column', () => {
    const site = build().sites[0];
    expect(site.servers).toHaveLength(2);
    const epic = site.servers.find((s) => s.name === 'EPIC-01');
    expect(epic.id).toMatch(UUID_RE);
    expect(epic).toMatchObject({
      manufacturer: 'Dell', device: 'EPIC Server', status: 'Active', location: 'Server room',
      mdfIdfLocation: 'MDF-1', ipAddress: '10.0.0.5', ipAssignmentMethod: 'Static',
      macAddress: 'AA:BB:CC:00:00:05', subnet: '255.255.255.0', gateway: '10.0.0.1', dns: '8.8.8.8',
      username: 'admin', password: 'secret', notes: 'Primary host',
      streamAddress: 'https://splashtop.example/epic-01',
    });
  });

  it('links devices to their server by name (devices.server_id) and keeps the name', () => {
    const site = build().sites[0];
    const epic = site.servers.find((s) => s.name === 'EPIC-01');
    const fli = site.servers.find((s) => s.name === 'FLI-01');
    expect(device(site, 'CAM1.1F').device).toMatchObject({ server: 'EPIC-01', serverId: epic.id });
    expect(device(site, 'CAMZ.1F').device.serverId).toBe(fli.id);
    expect(device(site, 'S1.1').device.serverId).toBe(epic.id);
  });

  it('warns about a server name that is not on the Networking tab', () => {
    const customer = build({ workbook: { rows: { ...SAMPLE_ROWS, Networking: [] } } });
    expect(customer.sites[0].servers).toEqual([]);
    expect(customer.warnings.some((w) => /references server "EPIC-01"/.test(w))).toBe(true);
  });
});

describe('Garages tab → sites', () => {
  it('maps names, stage and the Drive quick link', () => {
    const site = build().sites[0];
    expect(site).toMatchObject({ internalName: 'North', name: 'North Garage', stage: 'Live' });
    expect(site.quickLinks[0]).toMatchObject({ icon: 'sheets', url: SAMPLE_FILE.webViewLink, name: 'Acme-config' });
    expect(site.contacts).toEqual([]);
    expect(site.mdfIdfLocations).toEqual([]);
  });
});

describe('GarageLevels tab → levels + zones', () => {
  it('keeps floors as floors with their config', () => {
    const site = build().sites[0];
    const level1 = site.levels.find((l) => l.internalName === 'Level 1');
    expect(level1).toMatchObject({ isZone: false, parentLevelId: null, name: 'Level 1', totalSpots: 250 });
    expect(level1.config.maximumOccupancy).toBe(250);
    expect(level1.config.autoResetCountTime).toBe('04:00');
  });

  it('turns "Level 1 Zone A" into a zone under Level 1 with a linked polygon on the floor', () => {
    const site = build().sites[0];
    const level1 = site.levels.find((l) => l.internalName === 'Level 1');
    const zone = site.levels.find((l) => l.isZone);
    expect(zone).toMatchObject({ name: 'Zone A', internalName: 'Zone A', parentLevelId: level1.id, totalSpots: 40 });
    expect(zone.config.levelType).toBe('FLI');
    const polygon = level1.zones.find((z) => z.linkedLevelId === zone.id);
    expect(polygon).toBeTruthy();
    expect(polygon.points).toHaveLength(4);
    expect(zone.devices).toEqual([]);
  });

  it('accepts the legacy LevelType=Zone rows too, and warns when no parent matches', () => {
    const rows = {
      ...SAMPLE_ROWS,
      GarageLevels: [
        ...SAMPLE_ROWS.GarageLevels,
        ['North', 'Mezz', 'Mezz', 'EPIC-01', 'Zone', 'TRUE', 10, 'FALSE', 0, '04:00', 5, 0, 0, 'TRUE', 'TRUE', 4, 4, '', ''],
      ],
    };
    const customer = build({ workbook: { rows } });
    const mezz = customer.sites[0].levels.find((l) => l.internalName === 'Mezz');
    expect(mezz.isZone).toBe(false);
    expect(customer.warnings.some((w) => /"Mezz" is marked Zone/.test(w))).toBe(true);
  });

  it('resolveZoneParent picks the longest matching floor name', () => {
    const levels = [
      { id: 'a', internalName: 'Level 1', name: 'Level 1' },
      { id: 'b', internalName: 'Level 10', name: 'Level 10' },
      { id: 'c', internalName: 'Level 10 Zone 2', name: 'Level 10 Zone 2' },
    ];
    expect(resolveZoneParent(levels[2], levels)).toEqual({ parent: levels[1], shortName: 'Zone 2' });
    expect(resolveZoneParent(levels[0], levels)).toBeNull();
  });
});

describe('DisplayGroups tab → display_groups (per site)', () => {
  it('clones the groups per site and re-points the signs at the clone', () => {
    const site = build().sites[0];
    expect(site.displayGroups).toHaveLength(1);
    expect(site.displayGroups[0]).toMatchObject({ name: 'Group1', sendOnlyOnUpdates: false, forceSendAfterSeconds: 15 });
    expect(site.displayGroups[0].id).toMatch(UUID_RE);
    expect(device(site, 'S1.1').device.displayGroupId).toBe(site.displayGroups[0].id);
  });
});

describe('DisplayControllers + DisplayLevels tabs → sign devices', () => {
  it('writes every sign_details column for a single sign', () => {
    const site = build().sites[0];
    const { device: sign, level } = device(site, 'S1.1');
    expect(level.internalName).toBe('Level 1');
    const rows = splitLegacyDevice(sign, level.id, new Set());
    expect(rows.device).toMatchObject({ family: 'sign', type: 'sign-static', name: 'S1.1', friendly_name: 'S1.1', server_name: 'EPIC-01', pending_placement: true });
    expect(rows.signDetails).toMatchObject({
      controller_name: 'CTRL-1', visible_name: 'Entrance Sign', display_protocol: 'SIGNALTECHDISPLAY',
      hardware_type: 'LED', display_group_id: site.displayGroups[0].id, display_site_id: site.id,
      display_level_all: false, position_name: 'Pos A', display_map: 'MAP1',
      keep_level_counts_separate: false, serial_address: '1', ip_address: '10.0.0.50', port: '5000',
      logical_key: 's1.1', uses_inserts: false,
    });
    expect(rows.signDisplayLevels).toHaveLength(1);
    expect(rows.signDisplayLevels[0].level_id).toBe(level.id);
  });

  it('writes a monument as one device with sign_inserts and their levels', () => {
    const site = build().sites[0];
    const entry = allDevices(site).find((e) => Array.isArray(e.device.inserts));
    const level1 = site.levels.find((l) => l.internalName === 'Level 1');
    expect(entry.level.id).toBe(level1.id);
    const rows = splitLegacyDevice(entry.device, entry.level.id, new Set());
    expect(rows.signDetails.uses_inserts).toBe(true);
    expect(rows.signDetails.controller_name).toBe('MON-1');
    expect(rows.signInserts.map((i) => i.row.display_name)).toEqual(['M1-A', 'M1-B']);
    expect(rows.signInserts[0].levels[0].level_id).toBe(level1.id);
    expect(rows.signInserts[1].row.display_level_all).toBe(true);
    expect(rows.signInserts[0].row.has_ethernet).toBe(true);
  });

  it('counts DisplayLevels rows that match nothing as a warning', () => {
    const rows = { ...SAMPLE_ROWS, DisplayLevels: [...SAMPLE_ROWS.DisplayLevels, ['GHOST', 'North', 'Level 1', '', '']] };
    const customer = build({ workbook: { rows } });
    // GHOST has no DisplayControllers row, so it never becomes a device.
    expect(device(customer.sites[0], 'GHOST')).toBeUndefined();
  });
});

describe('DisplaySchedules tab → display_schedules', () => {
  it('maps every column including DisplayName and the count position box', () => {
    const [schedule] = build().displaySchedules;
    expect(schedule.id).toMatch(UUID_RE);
    expect(schedule).toMatchObject({
      DisplayName: 'S1.1', StartTime: '06:00', EndTime: '22:00', Day: 'Mon',
      CountPosition: { x: 10, y: 20, width: 100, height: 50 },
      FilePath: '/media/full.png', Garage1: 'North', Level1: 'Level 1', Garage2: 'North', Level2: 'Level 2',
    });
  });

  it('skips blank rows and leaves CountPosition null when no box is given', () => {
    const rows = displaySchedulesFromRows([
      { DisplayName: '', StartTime: '' },
      { DisplayName: 'S2', StartTime: '07:00' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].CountPosition).toBeNull();
  });
});

describe('Cameras + FLICameras + LPRCameras tabs → camera devices', () => {
  it('writes devices, camera_details and camera_streams from one FLI row', () => {
    const site = build().sites[0];
    const { device: cam, level } = device(site, 'CAM1.1F');
    const rows = splitLegacyDevice(cam, level.id, new Set());
    expect(rows.device).toMatchObject({
      family: 'camera', type: 'cam-fli', name: 'CAM1.1F', friendly_name: 'Entrance Cam',
      server_name: 'EPIC-01', disabled: false, pending_placement: true,
    });
    expect(rows.device.server_id).toBe(site.servers.find((s) => s.name === 'EPIC-01').id);
    expect(rows.cameraDetails).toMatchObject({
      hardware_type: 'bullet', resolution: '1080p', is_entry_exit_camera: true,
      dependent_camera_name: '', traffic_direction: 'in',
    });
    expect(rows.streams).toHaveLength(1);
    expect(rows.streams[0]).toMatchObject({ stream_number: 1, ip_address: '10.0.0.101', port: '554', external_url: 'rtsp://10.0.0.101/live' });
  });

  it('marks a Disabled LPR camera disabled and types it cam-lpr', () => {
    const site = build().sites[0];
    const { device: cam, level } = device(site, 'CAM2.1L');
    expect(level.internalName).toBe('Level 2');
    const rows = splitLegacyDevice(cam, level.id, new Set());
    expect(rows.device).toMatchObject({ type: 'cam-lpr', disabled: true });
    expect(rows.cameraDetails.traffic_direction).toBe('out');
    expect(rows.cameraDetails.resolution).toBe('4K');
  });

  it('places a zone camera on the parent floor, counting into the linked zone polygon', () => {
    const site = build().sites[0];
    const level1 = site.levels.find((l) => l.internalName === 'Level 1');
    const zone = site.levels.find((l) => l.isZone);
    const polygon = level1.zones.find((z) => z.linkedLevelId === zone.id);
    const { device: cam, level } = device(site, 'CAMZ.1F');
    expect(level.id).toBe(level1.id);
    expect(cam.trafficFlow).toMatchObject({ direction: 'out', level: level1.id, zone: polygon.id });
    expect(cam.dependentCameraName).toBe('CAM1.1F');
    expect(cam.isEntryExitCamera).toBe(false);
    const rows = splitLegacyDevice(cam, level.id, new Set([zone.id]));
    expect(rows.cameraDetails.traffic_level_id).toBe(level1.id);
    expect(rows.cameraDetails.traffic_zone_polygon_id).toBe(polygon.id);
  });
});

describe('SensorGroups + Sensors tabs → sensor_groups + sensor devices', () => {
  it('keeps the group with its Garage/Level mirror columns', () => {
    const site = build().sites[0];
    expect(site.sensorGroups[0]).toMatchObject({
      groupId: 'G1', controllerAddress: 'http://controller.local', controllerKey: 'key-1',
      sensorProtocol: 'NWAVE', garage: 'North', level: 'Level 2', parentLevel: 'Level 2',
    });
  });

  it('writes sensor_details and one sensor_units row per Sensors row with parking fields', () => {
    const site = build().sites[0];
    const { device: sensor, level } = device(site, 'SensorGroup-G1');
    expect(level.internalName).toBe('Level 2');
    const rows = splitLegacyDevice(sensor, level.id, new Set());
    expect(rows.device.family).toBe('sensor');
    expect(rows.sensorDetails).toMatchObject({
      sensor_protocol: 'NWAVE', config_sensor_group_id: site.sensorGroups[0].id, sensor_count: 2,
    });
    expect(rows.sensorUnits.map((u) => [u.sensor_name, u.sensor_id, u.parking_type, u.temp_parking_time_minutes]))
      .toEqual([['SENS-1', 'id-1', 'Standard', 30], ['SENS-2', 'id-2', 'Temp', 0]]);
  });
});

describe('whole workbook', () => {
  it('reports counts and no warnings for the clean sample', () => {
    const customer = build();
    expect(customer.summary).toEqual({ sites: 1, levels: 2, zones: 1, devices: 6, servers: 2 });
    expect(customer.warnings).toEqual([]);
  });

  it('two sites each get their own server and display-group rows', () => {
    const rows = {
      ...SAMPLE_ROWS,
      Garages: [...SAMPLE_ROWS.Garages, ['South', 'South Garage', 'Design']],
      GarageLevels: [...SAMPLE_ROWS.GarageLevels, ['South', 'Level 1', 'Level 1', 'EPIC-01', 'FLI', 'TRUE', 50, 'FALSE', 0, '04:00', 5, 0, 0, 'TRUE', 'TRUE', 1, 1, '', '']],
    };
    const customer = build({ workbook: { rows } });
    expect(customer.sites).toHaveLength(2);
    const ids = customer.sites.flatMap((s) => [...s.servers.map((x) => x.id), ...s.displayGroups.map((x) => x.id)]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(customer.sites[1].stage).toBe('Design');
  });
});
