/**
 * Delete paths across the config tabs. These were rewritten from positional
 * column indices to header names, and nothing covered them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSheets } from './__fixtures__/fakeSheets';
import { CONFIG_TAB_HEADERS } from '../lib/configSheetSchema';

const h = vi.hoisted(() => ({ fake: null, sourceMime: 'application/vnd.google-apps.spreadsheet' }));

vi.mock('./GoogleDriveService', () => ({
  fetchWithTimeout: (...args) => h.fake.fetchWithTimeout(...args),
  getAccessToken: () => 'test-token',
  isSignedIn: () => true,
  hadGoogleSession: () => true,
  refreshAccessTokenSilently: async () => 'test-token',
  invalidateGoogleAccessToken: () => {},
  getFileMetadata: async () => ({ id: 'f', mimeType: h.sourceMime }),
  findConfigSheetInFolder: async () => null,
  trashDriveFile: async () => ({}),
  SPREADSHEET_MIME: 'application/vnd.google-apps.spreadsheet',
}));

const {
  deleteCameraFromSheet, deleteSignFromSheet, deleteSensorFromSheet, deleteGarageFromSheet,
  deleteDevicesFromSheet,
} = await import('./ConfigSheetSyncService');
const { writeTabValues, readTabValues } = await import('./GoogleSheetsService');
const { buildTabView } = await import('../lib/sheetTabView');

let spreadsheetId;
let customer;

const ALL_TABS = [
  'Garages', 'GarageLevels', 'Cameras', 'FLICameras', 'LPRCameras',
  'DisplayControllers', 'DisplayLevels', 'DisplaySchedules', 'SensorGroups', 'Sensors', 'DisplayGroups',
];

async function readView(tabName) {
  return buildTabView(tabName, await readTabValues(spreadsheetId, tabName));
}

async function seed(tabName, rows) {
  await writeTabValues(spreadsheetId, tabName, [CONFIG_TAB_HEADERS[tabName], ...rows], {
    valueInputOption: 'RAW',
  });
}

async function keysOf(tabName, column) {
  const view = await readView(tabName);
  return view.dataRows.map((r) => view.get(r, column)).filter(Boolean);
}

beforeEach(() => {
  h.fake = createFakeSheets();
  spreadsheetId = h.fake.createSpreadsheet({ title: 'Acme-config', tabs: ALL_TABS }).id;
  customer = { spreadsheetId, customerId: 'acme' };
});

describe('deleteCameraFromSheet', () => {
  beforeEach(async () => {
    await seed('Cameras', [
      ['1.1F', 'A', '10.0.0.1', '554', 'FLI', '', '', 'enabled', '640x480'],
      ['2.1F', 'B', '10.0.0.2', '554', 'FLI', '', '', 'enabled', '640x480'],
    ]);
    await seed('FLICameras', [
      ['1.1F', 'North', 'Level 1', 'IN', 'true', ''],
      ['2.1F', 'North', 'Level 1', 'IN', 'true', ''],
    ]);
  });

  it('removes only the target camera, from every tab it appears on', async () => {
    await deleteCameraFromSheet({
      customer,
      device: { id: 'c1', type: 'cam-fli', name: '1.1F' },
    });

    expect(await keysOf('Cameras', 'Name')).toEqual(['2.1F']);
    expect(await keysOf('FLICameras', 'CameraName')).toEqual(['2.1F']);
  });
});

describe('deleteSignFromSheet', () => {
  it('removes the sign from DisplayControllers and DisplayLevels', async () => {
    await seed('DisplayControllers', [
      ['S1.1', 'S1.1', 'North Entry', '', '', '', '', '', '', '', '', 'FALSE'],
      ['S1.2', 'S1.2', 'South Entry', '', '', '', '', '', '', '', '', 'FALSE'],
    ]);
    await seed('DisplayLevels', [
      ['S1.1', 'North', 'Level 1', '', ''],
      ['S1.2', 'North', 'Level 2', '', ''],
    ]);

    await deleteSignFromSheet({ customer, device: { type: 'sign-static', name: 'S1.1' } });

    expect(await keysOf('DisplayControllers', 'DisplayName')).toEqual(['S1.2']);
    expect(await keysOf('DisplayLevels', 'DisplayName')).toEqual(['S1.2']);
  });
});

describe('deleteSensorFromSheet', () => {
  it('removes the sensor rows and rebuilds the garage sensor groups', async () => {
    await seed('Sensors', [
      ['SEN-1', '1', 'Group1', '', ''],
      ['SEN-2', '2', 'Group1', '', ''],
    ]);
    await seed('SensorGroups', [
      ['Group1', '', '', 'NWAVE', 'North', 'Level 1', ''],
    ]);

    await deleteSensorFromSheet({
      customer,
      device: { type: 'sensor-nwave', name: 'SEN-1', sensorId: '1' },
      garage: { name: 'North', internalName: 'North', sensorGroups: [], levels: [] },
    });

    expect(await keysOf('Sensors', 'SensorName')).toEqual(['SEN-2']);
    // No device references the group any more, so its row goes too.
    expect(await keysOf('SensorGroups', 'GroupID')).toEqual([]);
  });
});

describe('deleteDevicesFromSheet', () => {
  it('removes cameras, signs, and sensors in one call', async () => {
    await seed('Cameras', [
      ['1.1F', 'A', '10.0.0.1', '554', 'FLI', '', '', 'enabled', '640x480'],
      ['2.1F', 'B', '10.0.0.2', '554', 'FLI', '', '', 'enabled', '640x480'],
    ]);
    await seed('FLICameras', [
      ['1.1F', 'North', 'Level 1', 'IN', 'true', ''],
      ['2.1F', 'North', 'Level 1', 'IN', 'true', ''],
    ]);
    await seed('DisplayControllers', [
      ['S1.1', 'S1.1', 'North Entry', '', '', '', '', '', '', '', '', 'FALSE'],
      ['S1.2', 'S1.2', 'South Entry', '', '', '', '', '', '', '', '', 'FALSE'],
    ]);
    await seed('DisplayLevels', [
      ['S1.1', 'North', 'Level 1', '', ''],
      ['S1.2', 'North', 'Level 2', '', ''],
    ]);
    await seed('Sensors', [
      ['SEN-1', '1', 'Group1', '', ''],
      ['SEN-2', '2', 'Group1', '', ''],
    ]);
    await seed('SensorGroups', [
      ['Group1', '', '', 'NWAVE', 'North', 'Level 1', ''],
    ]);

    await deleteDevicesFromSheet({
      customer,
      devices: [
        { id: 'c1', type: 'cam-fli', name: '1.1F' },
        { id: 's1', type: 'sign-static', name: 'S1.1' },
        { id: 'n1', type: 'sensor-nwave', name: 'SEN-1', sensorId: '1' },
      ],
      garage: { name: 'North', internalName: 'North', sensorGroups: [], levels: [] },
    });

    expect(await keysOf('Cameras', 'Name')).toEqual(['2.1F']);
    expect(await keysOf('FLICameras', 'CameraName')).toEqual(['2.1F']);
    expect(await keysOf('DisplayControllers', 'DisplayName')).toEqual(['S1.2']);
    expect(await keysOf('DisplayLevels', 'DisplayName')).toEqual(['S1.2']);
    expect(await keysOf('Sensors', 'SensorName')).toEqual(['SEN-2']);
    expect(await keysOf('SensorGroups', 'GroupID')).toEqual([]);
  });
});

describe('deleteGarageFromSheet', () => {
  beforeEach(async () => {
    await seed('Garages', [['North', 'North', ''], ['South', 'South', '']]);
    await seed('GarageLevels', [
      ['North', 'Level 1', 'Level 1', '', 'FLI', 'TRUE', 100],
      ['South', 'Level 1', 'Level 1', '', 'FLI', 'TRUE', 100],
    ]);
    await seed('FLICameras', [
      ['1.1F', 'North', 'Level 1', 'IN', 'true', ''],
      ['9.1F', 'South', 'Level 1', 'IN', 'true', ''],
    ]);
    await seed('Cameras', [
      ['1.1F', 'A', '10.0.0.1', '554', 'FLI', '', '', 'enabled', '640x480'],
      ['9.1F', 'S', '10.0.9.1', '554', 'FLI', '', '', 'enabled', '640x480'],
    ]);
    await seed('DisplayLevels', [
      ['S1.1', 'North', 'Level 1', '', ''],
      ['S9.1', 'South', 'Level 1', '', ''],
    ]);
    await seed('SensorGroups', [
      ['Group1', '', '', 'NWAVE', 'North', 'Level 1', ''],
      ['Group9', '', '', 'NWAVE', 'South', 'Level 1', ''],
    ]);
    await seed('DisplaySchedules', [
      ['S1.1', '08:00', '17:00', 'Mon', '0', '0', '0', '0', '', 'North', 'Level 1', '', ''],
      ['S9.1', '08:00', '17:00', 'Mon', '0', '0', '0', '0', '', 'South', 'Level 1', '', ''],
    ]);
  });

  const northGarage = {
    id: 1,
    name: 'North',
    internalName: 'North',
    displayGroups: [],
    levels: [{
      id: 1,
      name: 'Level 1',
      internalName: 'Level 1',
      devices: [
        { id: 'c1', type: 'cam-fli', name: '1.1F' },
        { id: 's1', type: 'sign-static', name: 'S1.1' },
      ],
    }],
  };

  it('removes every row for that site and leaves the other site intact', async () => {
    await deleteGarageFromSheet({ customer, garage: northGarage, otherGarages: [] });

    expect(await keysOf('Garages', 'Garage')).toEqual(['South']);
    expect(await keysOf('GarageLevels', 'Garage')).toEqual(['South']);
    expect(await keysOf('Cameras', 'Name')).toEqual(['9.1F']);
    expect(await keysOf('FLICameras', 'CameraName')).toEqual(['9.1F']);
    expect(await keysOf('DisplayLevels', 'DisplayName')).toEqual(['S9.1']);
    expect(await keysOf('SensorGroups', 'GroupID')).toEqual(['Group9']);
    expect(await keysOf('DisplaySchedules', 'DisplayName')).toEqual(['S9.1']);
  });

  it('keeps a display group another site still uses', async () => {
    await seed('DisplayGroups', [['Shared', 'FALSE', 15], ['NorthOnly', 'FALSE', 15]]);

    await deleteGarageFromSheet({
      customer,
      garage: { ...northGarage, displayGroups: [{ id: 1, name: 'Shared' }, { id: 2, name: 'NorthOnly' }] },
      otherGarages: [{ displayGroups: [{ id: 1, name: 'Shared' }] }],
    });

    expect(await keysOf('DisplayGroups', 'Name')).toEqual(['Shared']);
  });
});

describe('a customer with no Google Sheet to write to', () => {
  it('fails loudly when nothing at all is linked', async () => {
    await expect(deleteCameraFromSheet({
      customer: { customerId: 'acme' },
      device: { id: 'c', type: 'cam-fli', name: '1.1F' },
    })).rejects.toThrow(/no configuration sheet linked/i);
  });

  it('fails loudly when only an .xlsx is linked', async () => {
    // resolveSpreadsheetId returns null here rather than throwing, which is how
    // these writes used to report success while doing nothing — devices ended
    // up existing only in one browser.
    h.sourceMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const xlsxOnly = { customerId: 'acme', sourceFileId: 'file-1' };

    await expect(deleteCameraFromSheet({
      customer: xlsxOnly,
      device: { id: 'c', type: 'cam-fli', name: '1.1F' },
    })).rejects.toThrow(/not linked to a Google Sheet/i);

    await expect(deleteSignFromSheet({
      customer: xlsxOnly,
      device: { type: 'sign-static', name: 'S1.1' },
    })).rejects.toThrow(/not linked to a Google Sheet/i);

    h.sourceMime = 'application/vnd.google-apps.spreadsheet';
  });

  it('issues no write requests when it cannot reach a sheet', async () => {
    h.sourceMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    h.fake.requests.length = 0;
    await expect(deleteCameraFromSheet({
      customer: { customerId: 'acme', sourceFileId: 'file-1' },
      device: { id: 'c', type: 'cam-fli', name: '1.1F' },
    })).rejects.toThrow();
    expect(h.fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
    h.sourceMime = 'application/vnd.google-apps.spreadsheet';
  });
});
