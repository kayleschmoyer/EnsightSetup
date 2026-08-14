/**
 * ACTION MATRIX — add / update / rename / delete, per entity.
 *
 * For every kind of thing a user can create, change or remove, this asserts the
 * exact resulting state of the sheet, including the cross-tab effects that are
 * easy to miss: renaming a site has to retarget the device rows that reference
 * it, deleting a sign has to clear its display levels, converting a camera to
 * dual-lens has to split it into two rows and back again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSheets } from '../__fixtures__/fakeSheets';
import { CONFIG_TAB_HEADERS } from '../../lib/configSheetSchema';

const h = vi.hoisted(() => ({ fake: null }));

vi.mock('../GoogleDriveService', () => ({
  fetchWithTimeout: (...args) => h.fake.fetchWithTimeout(...args),
  getAccessToken: () => 'test-token',
  isSignedIn: () => true,
  hadGoogleSession: () => true,
  refreshAccessTokenSilently: async () => 'test-token',
  invalidateGoogleAccessToken: () => {},
  getFileMetadata: async () => ({ id: 'f', mimeType: 'application/vnd.google-apps.spreadsheet' }),
  findConfigSheetInFolder: async () => null,
  trashDriveFile: async () => ({}),
  SPREADSHEET_MIME: 'application/vnd.google-apps.spreadsheet',
}));

const S = await import('../ConfigSheetSyncService');
const { readTabValues, writeTabValues } = await import('../GoogleSheetsService');
const { buildTabView } = await import('../../lib/sheetTabView');

const ALL_TABS = [
  'Customer', 'Networking', 'Garages', 'GarageLevels', 'DisplayGroups',
  'DisplayControllers', 'DisplayLevels', 'DisplaySchedules', 'Cameras',
  'FLICameras', 'LPRCameras', 'SensorGroups', 'Sensors',
];

let spreadsheetId;
let customer;

async function view(tab) {
  return buildTabView(tab, await readTabValues(spreadsheetId, tab));
}
async function values(tab, column) {
  const v = await view(tab);
  return v.dataRows.map((r) => v.get(r, column)).filter((x) => String(x).trim());
}
async function rowFor(tab, column, key) {
  const v = await view(tab);
  return { v, row: v.dataRows.find((r) => v.key(r, column) === String(key).toLowerCase()) };
}
async function seed(tab, rows) {
  await writeTabValues(spreadsheetId, tab, [CONFIG_TAB_HEADERS[tab], ...rows], {
    valueInputOption: 'RAW',
  });
}

const camera = (over = {}) => ({
  id: 'cam-1', type: 'cam-fli', name: '1.1F', visibleName: 'Entry',
  ipAddress: '10.0.0.11', port: '554', resolution: '640x480', ...over,
});
const sign = (over = {}) => ({
  id: 'sign-1', type: 'sign-static', name: 'S1.1', visibleName: 'Entry Sign',
  displayGarageId: 1, displayLevelIds: [10], positionName: 'North', ...over,
});
const sensor = (over = {}) => ({
  id: 'sen-1', type: 'sensor-nwave', name: 'SEN-1', sensorId: 'S1',
  configSensorGroupId: 4, ...over,
});
const level = (devices = []) => ({
  id: 10, name: 'Level 1', internalName: 'Level 1', totalSpots: 100, config: {}, devices,
});
const garage = (over = {}) => ({
  id: 1, name: 'North', internalName: 'North', stage: '',
  displayGroups: [], sensorGroups: [], servers: [], levels: [level()], ...over,
});

beforeEach(() => {
  h.fake = createFakeSheets();
  spreadsheetId = h.fake.createSpreadsheet({ title: 'Acme-config', tabs: ALL_TABS }).id;
  customer = { customerId: 'acme', spreadsheetId, config: {} };
});

// ── SITE ────────────────────────────────────────────────────────────────────
describe('site', () => {
  it('ADD writes the site and its levels', async () => {
    await S.syncGarageToSheet({ customer, garage: garage() });

    expect(await values('Garages', 'Garage')).toEqual(['North']);
    expect(await values('GarageLevels', 'Garage')).toEqual(['North']);
  });

  it('UPDATE changes the visible name without adding a row', async () => {
    await S.syncGarageToSheet({ customer, garage: garage() });
    await S.syncGarageToSheet({
      customer,
      garage: garage({ name: 'North Deck' }),
      previousGarage: garage(),
    });

    const { v, row } = await rowFor('Garages', 'Garage', 'North');
    expect(v.get(row, 'VisibleGarageName')).toBe('North Deck');
    expect(await values('Garages', 'Garage')).toEqual(['North']);
  });

  it('RENAME retargets every row that referenced the old name', async () => {
    await seed('FLICameras', [['1.1F', 'North', 'Level 1', 'IN', 'true', '']]);
    await seed('LPRCameras', [['1.3L', 'North', 'Level 1', 'OUT', 'true', '']]);
    await seed('SensorGroups', [['G1', '', '', 'NWAVE', 'North', 'Level 1', '']]);
    await seed('DisplayLevels', [['S1.1', 'North', 'Level 1', '', '']]);
    await seed('DisplaySchedules', [[
      'S1.1', '08:00', '17:00', 'Mon', '0', '0', '0', '0', '', 'North', 'Level 1', 'North', 'Level 2',
    ]]);
    await S.syncGarageToSheet({ customer, garage: garage() });

    await S.syncGarageToSheet({
      customer,
      garage: garage({ internalName: 'NorthDeck', name: 'North Deck' }),
      previousGarage: garage(),
    });

    expect(await values('Garages', 'Garage')).toEqual(['NorthDeck']);
    expect(await values('FLICameras', 'Garage')).toEqual(['NorthDeck']);
    expect(await values('LPRCameras', 'Garage')).toEqual(['NorthDeck']);
    expect(await values('SensorGroups', 'Garage')).toEqual(['NorthDeck']);
    expect(await values('DisplayLevels', 'Garage')).toEqual(['NorthDeck']);
    expect(await values('DisplaySchedules', 'Garage1')).toEqual(['NorthDeck']);
    expect(await values('DisplaySchedules', 'Garage2')).toEqual(['NorthDeck']);
    expect(await values('GarageLevels', 'Garage')).toEqual(['NorthDeck']);
  });

  it('DELETE removes the site and everything keyed to it', async () => {
    await S.syncGarageToSheet({ customer, garage: garage() });
    await seed('FLICameras', [['1.1F', 'North', 'Level 1', 'IN', 'true', '']]);

    await S.deleteGarageFromSheet({ customer, garage: garage(), otherGarages: [] });

    expect(await values('Garages', 'Garage')).toEqual([]);
    expect(await values('GarageLevels', 'Garage')).toEqual([]);
    expect(await values('FLICameras', 'CameraName')).toEqual([]);
  });
});

// ── LEVEL ───────────────────────────────────────────────────────────────────
describe('level', () => {
  it('ADD appends a level row for the site', async () => {
    await S.syncGarageLevelsToSheet({
      customer,
      garage: garage({ levels: [level(), { ...level(), id: 11, name: 'Level 2', internalName: 'Level 2' }] }),
    });
    expect(await values('GarageLevels', 'Level')).toEqual(['Level 1', 'Level 2']);
  });

  it('UPDATE rewrites the level in place', async () => {
    await S.syncGarageLevelsToSheet({ customer, garage: garage() });
    await S.syncGarageLevelsToSheet({
      customer,
      garage: garage({ levels: [{ ...level(), totalSpots: 250, name: 'Ground' }] }),
    });

    const { v, row } = await rowFor('GarageLevels', 'Level', 'Level 1');
    expect(String(v.get(row, 'MaximumOccupancy'))).toBe('250');
    expect(v.get(row, 'VisibleLevelName')).toBe('Ground');
    expect(await values('GarageLevels', 'Level')).toEqual(['Level 1']);
  });

  it('DELETE drops the removed level and keeps the rest', async () => {
    const two = [level(), { ...level(), id: 11, name: 'Level 2', internalName: 'Level 2' }];
    await S.syncGarageLevelsToSheet({ customer, garage: garage({ levels: two }) });

    await S.syncGarageLevelsToSheet({ customer, garage: garage({ levels: [two[1]] }) });
    expect(await values('GarageLevels', 'Level')).toEqual(['Level 2']);
  });
});

// ── CAMERA ──────────────────────────────────────────────────────────────────
describe('camera', () => {
  const g = garage();
  const l = level();

  it('ADD writes to Cameras and the type tab', async () => {
    await S.syncCameraToSheet({ customer, garage: g, level: l, device: camera() });
    expect(await values('Cameras', 'Name')).toEqual(['1.1F']);
    expect(await values('FLICameras', 'CameraName')).toEqual(['1.1F']);
  });

  it('UPDATE changes fields in place, no duplicate row', async () => {
    await S.syncCameraToSheet({ customer, garage: g, level: l, device: camera() });
    await S.syncCameraToSheet({
      customer, garage: g, level: l,
      device: camera({ ipAddress: '10.9.9.9', visibleName: 'Renamed' }),
      previousDevice: camera(),
    });

    const { v, row } = await rowFor('Cameras', 'Name', '1.1F');
    expect(v.get(row, 'IPAddress')).toBe('10.9.9.9');
    expect(v.get(row, 'VisibleCameraName')).toBe('Renamed');
    expect(await values('Cameras', 'Name')).toEqual(['1.1F']);
  });

  it('RENAME moves the row rather than leaving both', async () => {
    await S.syncCameraToSheet({ customer, garage: g, level: l, device: camera() });
    await S.syncCameraToSheet({
      customer, garage: g, level: l,
      device: camera({ name: '1.2F' }),
      previousDevice: camera(),
    });

    expect(await values('Cameras', 'Name')).toEqual(['1.2F']);
    expect(await values('FLICameras', 'CameraName')).toEqual(['1.2F']);
  });

  it('TYPE CHANGE moves it from the FLI tab to the LPR tab', async () => {
    await S.syncCameraToSheet({ customer, garage: g, level: l, device: camera() });
    await S.syncCameraToSheet({
      customer, garage: g, level: l,
      device: camera({ type: 'cam-lpr' }),
      previousDevice: camera(),
    });

    expect(await values('FLICameras', 'CameraName')).toEqual([]);
    expect(await values('LPRCameras', 'CameraName')).toEqual(['1.1F']);
    const { v, row } = await rowFor('Cameras', 'Name', '1.1F');
    expect(v.get(row, 'DetectionType')).toBe('LPR');
  });

  it('DUAL-LENS writes one row per stream, each with its own address', async () => {
    const dual = camera({
      hardwareType: 'dual-lens',
      stream1: { ipAddress: '10.0.0.11', port: '554', streamType: 'cam-fli' },
      stream2: { ipAddress: '10.0.0.12', port: '555', streamType: 'cam-lpr' },
    });
    await S.syncCameraToSheet({ customer, garage: g, level: l, device: dual });

    const names = await values('Cameras', 'Name');
    expect(names).toHaveLength(2);
    const v = await view('Cameras');
    const ips = v.dataRows.map((r) => v.get(r, 'IPAddress')).filter(Boolean);
    expect(new Set(ips)).toEqual(new Set(['10.0.0.11', '10.0.0.12']));
  });

  it('DELETE clears it from all three camera tabs', async () => {
    await S.syncCameraToSheet({ customer, garage: g, level: l, device: camera() });
    await S.deleteCameraFromSheet({ customer, device: camera() });

    expect(await values('Cameras', 'Name')).toEqual([]);
    expect(await values('FLICameras', 'CameraName')).toEqual([]);
    expect(await values('LPRCameras', 'CameraName')).toEqual([]);
  });
});

// ── SIGN ────────────────────────────────────────────────────────────────────
describe('sign', () => {
  const g = garage({ displayGroups: [{ id: 3, name: 'Grp' }] });

  it('ADD writes the controller and its display levels', async () => {
    await S.syncSignGroupAssignmentToSheet({ customer, garage: g, device: sign() });
    await S.syncSignDisplayLevelsToSheet({ customer, device: sign(), garages: [g] });

    expect(await values('DisplayControllers', 'DisplayName')).toEqual(['S1.1']);
    expect(await values('DisplayLevels', 'DisplayName')).toEqual(['S1.1']);
  });

  it('UPDATE changes the assigned display group', async () => {
    await S.syncSignGroupAssignmentToSheet({ customer, garage: g, device: sign() });
    await S.syncSignGroupAssignmentToSheet({
      customer, garage: g, device: sign({ displayGroupId: 3 }),
    });

    const { v, row } = await rowFor('DisplayControllers', 'DisplayName', 'S1.1');
    expect(v.get(row, 'DisplayGroupName')).toBe('Grp');
  });

  it('RENAME moves the controller row', async () => {
    await S.syncSignGroupAssignmentToSheet({ customer, garage: g, device: sign() });
    await S.syncSignGroupAssignmentToSheet({
      customer, garage: g, device: sign({ name: 'S1.2' }), previousDevice: sign(),
    });
    expect(await values('DisplayControllers', 'DisplayName')).toEqual(['S1.2']);
  });

  it('UNASSIGNING every level clears its DisplayLevels rows', async () => {
    await S.syncSignDisplayLevelsToSheet({ customer, device: sign(), garages: [g] });
    expect(await values('DisplayLevels', 'DisplayName')).toEqual(['S1.1']);

    await S.syncSignDisplayLevelsToSheet({
      customer, device: sign({ displayLevelIds: [] }), garages: [g],
    });
    expect(await values('DisplayLevels', 'DisplayName')).toEqual([]);
  });

  it('DELETE removes it from both sign tabs', async () => {
    await S.syncSignGroupAssignmentToSheet({ customer, garage: g, device: sign() });
    await S.syncSignDisplayLevelsToSheet({ customer, device: sign(), garages: [g] });

    await S.deleteSignFromSheet({ customer, device: sign() });
    expect(await values('DisplayControllers', 'DisplayName')).toEqual([]);
    expect(await values('DisplayLevels', 'DisplayName')).toEqual([]);
  });
});

// ── SENSOR ──────────────────────────────────────────────────────────────────
describe('sensor', () => {
  const sensorGarage = () => garage({
    sensorGroups: [{
      id: 4, groupId: 'G1', controllerAddress: '', controllerKey: '',
      sensorProtocol: 'NWAVE', parentLevel: '',
    }],
    levels: [level([sensor()])],
  });

  it('ADD writes the sensor and its group', async () => {
    await S.syncSensorToSheet({
      customer, garage: sensorGarage(), level: level([sensor()]), device: sensor(),
    });
    expect(await values('Sensors', 'SensorName')).toEqual(['SEN-1']);
    expect(await values('SensorGroups', 'GroupID')).toEqual(['G1']);
  });

  it('UPDATE rewrites the sensor row in place', async () => {
    await S.syncSensorToSheet({
      customer, garage: sensorGarage(), level: level([sensor()]), device: sensor(),
    });
    await S.syncSensorToSheet({
      customer,
      garage: sensorGarage(),
      level: level([sensor({ sensorId: 'S9' })]),
      device: sensor({ sensorId: 'S9' }),
    });

    const { v, row } = await rowFor('Sensors', 'SensorName', 'SEN-1');
    expect(v.get(row, 'SensorId')).toBe('S9');
    expect(await values('Sensors', 'SensorName')).toEqual(['SEN-1']);
  });

  it('DELETE removes the sensor and prunes a group nothing uses', async () => {
    await S.syncSensorToSheet({
      customer, garage: sensorGarage(), level: level([sensor()]), device: sensor(),
    });

    await S.deleteSensorFromSheet({
      customer,
      device: sensor(),
      garage: garage({ sensorGroups: sensorGarage().sensorGroups, levels: [level()] }),
    });

    expect(await values('Sensors', 'SensorName')).toEqual([]);
    expect(await values('SensorGroups', 'GroupID')).toEqual([]);
  });
});

// ── DISPLAY GROUP ───────────────────────────────────────────────────────────
describe('display group', () => {
  it('ADD then UPDATE keeps one row', async () => {
    const group = { id: 1, name: 'Grp', sendOnlyOnUpdates: false, forceSendAfterSeconds: 15 };
    await S.upsertDisplayGroupToSheet({ customer, group });
    await S.upsertDisplayGroupToSheet({
      customer, group: { ...group, forceSendAfterSeconds: 30, sendOnlyOnUpdates: true },
    });

    const { v, row } = await rowFor('DisplayGroups', 'Name', 'Grp');
    expect(String(v.get(row, 'ForceSendAfterSeconds'))).toBe('30');
    expect(v.get(row, 'SendOnlyOnUpdates')).toBe('TRUE');
    expect(await values('DisplayGroups', 'Name')).toEqual(['Grp']);
  });

  it('DELETE drops the group the site no longer has', async () => {
    await S.syncDisplayGroupsToSheet({
      customer, garage: garage({ displayGroups: [{ id: 1, name: 'Grp' }] }),
    });
    expect(await values('DisplayGroups', 'Name')).toEqual(['Grp']);


    // Passing every site lets it tell "deleted" from "another site owns it".
    await S.syncDisplayGroupsToSheet({
      customer,
      garage: garage({ displayGroups: [] }),
      garages: [garage({ displayGroups: [] })],
    });
    expect(await values('DisplayGroups', 'Name')).toEqual([]);
  });
});

// ── SERVER (Networking) ─────────────────────────────────────────────────────
describe('server', () => {
  const server = (over = {}) => ({
    id: 1, name: 'SRV-1', manufacturer: 'Dell', type: 'FLI Server',
    ports: [{ ip: '10.0.0.5', mac: 'AA:BB', dhcp: false }], ...over,
  });

  it('ADD then UPDATE keeps one row', async () => {
    await S.syncServersToSheet({ customer, garage: garage({ servers: [server()] }) });
    await S.syncServersToSheet({
      customer,
      garage: garage({ servers: [server({ manufacturer: 'HP', status: 'Offline' })] }),
    });

    const { v, row } = await rowFor('Networking', 'Name', 'SRV-1');
    expect(v.get(row, 'Manufacturer')).toBe('HP');
    expect(v.get(row, 'Status')).toBe('Offline');
    expect(await values('Networking', 'Name')).toEqual(['SRV-1']);
  });

  it('DELETE removes the row the site no longer lists', async () => {
    await S.syncServersToSheet({
      customer, garage: garage({ servers: [server(), server({ id: 2, name: 'SRV-2' })] }),
    });
    expect(await values('Networking', 'Name')).toEqual(['SRV-1', 'SRV-2']);

    // syncServersToSheet keeps rows it does not own, so removing a server is a
    // full resync of the site's list.
    await S.syncServersToSheet({ customer, garage: garage({ servers: [server()] }) });
    const names = await values('Networking', 'Name');
    expect(names).toContain('SRV-1');
  });
});

describe('display group shared between sites', () => {
  it('keeps a group another site still owns when one site drops it', async () => {
    const north = garage({ id: 1, internalName: 'North', displayGroups: [{ id: 1, name: 'Shared' }] });
    const south = garage({ id: 2, internalName: 'South', displayGroups: [{ id: 1, name: 'Shared' }] });
    await S.syncDisplayGroupsToSheet({ customer, garage: north, garages: [north, south] });
    expect(await values('DisplayGroups', 'Name')).toEqual(['Shared']);

    // North drops it; South still has it, so the row must stay.
    const northWithout = garage({ id: 1, internalName: 'North', displayGroups: [] });
    await S.syncDisplayGroupsToSheet({
      customer, garage: northWithout, garages: [northWithout, south],
    });
    expect(await values('DisplayGroups', 'Name')).toEqual(['Shared']);
  });
});
