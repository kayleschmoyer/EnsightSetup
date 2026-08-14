/**
 * A save rewrites every config tab row the app owns, so a value mangled by an
 * older build is corrected by the next camera move rather than needing someone
 * to find and re-edit that exact device.
 *
 * Rows the app does not know about are left alone: the sheet is the record of
 * truth, so a row typed straight into it is not the app's to delete. Deletions
 * do not rely on this pass — removing a device runs an explicit row removal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSheets } from './__fixtures__/fakeSheets';
import { CONFIG_TAB_HEADERS } from '../lib/configSheetSchema';

const h = vi.hoisted(() => ({ fake: null }));

vi.mock('./GoogleDriveService', () => ({
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

const { syncAllConfigTabsForCustomer, RESYNCED_CONFIG_TABS } = await import('./ConfigSheetSyncService');
const { writeTabValues, readTabValues } = await import('./GoogleSheetsService');
const { buildTabView } = await import('../lib/sheetTabView');

let spreadsheetId;
let customer;

const GARAGES = [{
  id: 1,
  name: 'North',
  internalName: 'North',
  displayGroups: [],
  sensorGroups: [],
  servers: [],
  levels: [{
    id: 10,
    name: 'Level 1',
    internalName: 'Level 1',
    totalSpots: 120,
    config: { autoResetCountTime: '04:00', levelType: 'FLI' },
    devices: [
      {
        id: 'cam-1',
        type: 'cam-fli',
        name: '1.1F',
        visibleName: 'North Entry',
        ipAddress: '10.0.0.7',
        port: '554',
        resolution: '1920x1080',
      },
    ],
  }],
}];

async function readView(tabName) {
  return buildTabView(tabName, await readTabValues(spreadsheetId, tabName));
}

beforeEach(() => {
  h.fake = createFakeSheets();
  spreadsheetId = h.fake.createSpreadsheet({
    title: 'Acme-config',
    tabs: [...RESYNCED_CONFIG_TABS],
  }).id;
  customer = { spreadsheetId, customerId: 'acme' };
});

describe('a save with damaged rows on the sheet', () => {
  beforeEach(async () => {
    // Exactly the damage the old code produced: a camera row whose trailing
    // cells belong to a different record, and a level whose AutoResetCountTime
    // was reinterpreted by Sheets as a time.
    await writeTabValues(spreadsheetId, 'Cameras', [
      CONFIG_TAB_HEADERS.Cameras,
      ['1.1F', 'WRONG NAME', '9.9.9.9', '1', 'LPR', '', '', 'disabled', '1x1'],
    ], { valueInputOption: 'RAW' });
    await writeTabValues(spreadsheetId, 'GarageLevels', [
      CONFIG_TAB_HEADERS.GarageLevels,
      ['North', 'Level 1', 'Level 1', '', 'FLI', 'TRUE', 4, 'FALSE', 0, '4:00:00'],
    ], { valueInputOption: 'RAW' });
  });

  it('repairs the camera row from current state', async () => {
    await syncAllConfigTabsForCustomer({ customer, garages: GARAGES });

    const view = await readView('Cameras');
    const row = view.dataRows.find((r) => view.key(r, 'Name') === '1.1f');
    expect(view.get(row, 'VisibleCameraName')).toBe('North Entry');
    expect(view.get(row, 'IPAddress')).toBe('10.0.0.7');
    expect(view.get(row, 'DetectionType')).toBe('FLI');
    expect(view.get(row, 'Resolution')).toBe('1920x1080');
    expect(view.get(row, 'Status')).toBe('enabled');
  });

  it('repairs a value Sheets had reinterpreted', async () => {
    await syncAllConfigTabsForCustomer({ customer, garages: GARAGES });

    const view = await readView('GarageLevels');
    const row = view.dataRows[0];
    expect(view.get(row, 'AutoResetCountTime')).toBe('04:00');
    expect(String(view.get(row, 'MaximumOccupancy'))).toBe('120');
  });

  it('writes the derived type tab too', async () => {
    await syncAllConfigTabsForCustomer({ customer, garages: GARAGES });

    const view = await readView('FLICameras');
    const row = view.dataRows.find((r) => view.key(r, 'CameraName') === '1.1f');
    expect(view.get(row, 'Garage')).toBe('North');
    expect(view.get(row, 'Level')).toBe('Level 1');
  });
});

describe('rows the app no longer has', () => {
  it('removes a camera row the app does not have, so the two cannot disagree', async () => {
    // The usual source is a ghost: a device deleted or renamed while its sheet
    // write failed. Left alone, the sheet showed a camera the app never would.
    await writeTabValues(spreadsheetId, 'Cameras', [
      CONFIG_TAB_HEADERS.Cameras,
      ['99.9F', 'Ghost', '10.0.0.99', '554', 'FLI', 'srv', 'rtsp://ghost', 'enabled', '640x480'],
    ], { valueInputOption: 'RAW' });

    await syncAllConfigTabsForCustomer({ customer, garages: GARAGES });

    const view = await readView('Cameras');
    expect(view.dataRows.some((r) => view.key(r, 'Name') === '99.9f')).toBe(false);
    expect(view.dataRows.filter((r) => view.key(r, 'Name'))).toHaveLength(1);
    expect(view.dataRows.some((r) => view.key(r, 'Name') === '1.1f')).toBe(true);
  });

  it('removes levels for a site the app no longer has', async () => {
    await writeTabValues(spreadsheetId, 'GarageLevels', [
      CONFIG_TAB_HEADERS.GarageLevels,
      ['South', 'Level 3', 'Level 3', '', 'FLI', 'TRUE', 80],
    ], { valueInputOption: 'RAW' });

    await syncAllConfigTabsForCustomer({ customer, garages: GARAGES });

    const view = await readView('GarageLevels');
    expect(view.dataRows.some((r) => view.key(r, 'Garage') === 'south')).toBe(false);
    expect(view.dataRows.some((r) => view.key(r, 'Garage') === 'north')).toBe(true);
  });

  it('still keeps a hand-added column on the rows that survive', async () => {
    await writeTabValues(spreadsheetId, 'Cameras', [
      [...CONFIG_TAB_HEADERS.Cameras, 'Notes'],
      ['1.1F', 'x', '1.1.1.1', '1', 'LPR', '', '', 'disabled', '1x1', 'lens replaced'],
    ], { valueInputOption: 'RAW' });

    await syncAllConfigTabsForCustomer({ customer, garages: GARAGES });

    const view = await readView('Cameras');
    const row = view.dataRows.find((r) => view.key(r, 'Name') === '1.1f');
    expect(view.get(row, 'Notes')).toBe('lens replaced');
    expect(view.get(row, 'IPAddress')).toBe('10.0.0.7');
  });
});

describe('cost of a save when nothing drifted', () => {
  it('reads once and writes nothing the second time', async () => {
    await syncAllConfigTabsForCustomer({ customer, garages: GARAGES });

    h.fake.requests.length = 0;
    const result = await syncAllConfigTabsForCustomer({ customer, garages: GARAGES });

    expect(result.changedTabs).toEqual([]);
    expect(h.fake.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
    // A single batchGet covers all ten tabs.
    expect(h.fake.requests.filter((r) => r.method === 'GET')).toHaveLength(1);
    expect(h.fake.requests[0].path).toContain('values:batchGet');
  });

  it('reports which tabs it corrected', async () => {
    await writeTabValues(spreadsheetId, 'Cameras', [
      CONFIG_TAB_HEADERS.Cameras,
      ['1.1F', 'WRONG', '9.9.9.9', '1', 'LPR', '', '', 'disabled', '1x1'],
    ], { valueInputOption: 'RAW' });

    const result = await syncAllConfigTabsForCustomer({ customer, garages: GARAGES });
    expect(result.changedTabs).toContain('Cameras');
  });
});

describe('the app has far more devices than the sheet', () => {
  /** 80 cameras across 4 levels, as the app holds them. */
  const BIG_GARAGE = [{
    id: 1,
    name: 'North',
    internalName: 'North',
    displayGroups: [],
    sensorGroups: [],
    servers: [],
    levels: Array.from({ length: 4 }, (_, l) => ({
      id: l + 1,
      name: `Level ${l + 1}`,
      internalName: `Level ${l + 1}`,
      totalSpots: 100,
      config: {},
      devices: Array.from({ length: 20 }, (_, i) => ({
        id: `cam-${l}-${i}`,
        type: 'cam-fli',
        name: `${l + 1}.${i + 1}F`,
        visibleName: `Cam ${l + 1}.${i + 1}`,
        ipAddress: `10.0.${l}.${i + 1}`,
        port: '554',
        resolution: '1920x1080',
      })),
    })),
  }];

  it('pushes every missing camera to the sheet', async () => {
    // The sheet only knows about 10 of them.
    const known = BIG_GARAGE[0].levels[0].devices.slice(0, 10);
    await writeTabValues(spreadsheetId, 'Cameras', [
      CONFIG_TAB_HEADERS.Cameras,
      ...known.map((d) => [
        d.name, 'stale name', '1.1.1.1', '1', 'LPR', '', '', 'disabled', '1x1',
      ]),
    ], { valueInputOption: 'RAW' });

    await syncAllConfigTabsForCustomer({ customer, garages: BIG_GARAGE });

    const view = await readView('Cameras');
    const rows = view.dataRows.filter((r) => view.key(r, 'Name'));
    expect(rows).toHaveLength(80);

    // The 70 that were missing are now present and correct...
    const added = view.dataRows.find((r) => view.key(r, 'Name') === '4.20f');
    expect(view.get(added, 'VisibleCameraName')).toBe('Cam 4.20');
    expect(view.get(added, 'IPAddress')).toBe('10.0.3.20');

    // ...and the 10 that existed were corrected, not duplicated.
    const corrected = view.dataRows.filter((r) => view.key(r, 'Name') === '1.1f');
    expect(corrected).toHaveLength(1);
    expect(view.get(corrected[0], 'VisibleCameraName')).toBe('Cam 1.1');
    expect(view.get(corrected[0], 'DetectionType')).toBe('FLI');
  });

  it('fills the derived type tab for all of them too', async () => {
    await syncAllConfigTabsForCustomer({ customer, garages: BIG_GARAGE });

    const view = await readView('FLICameras');
    expect(view.dataRows.filter((r) => view.key(r, 'CameraName'))).toHaveLength(80);
  });

  it('writes all four levels to GarageLevels', async () => {
    await syncAllConfigTabsForCustomer({ customer, garages: BIG_GARAGE });

    const view = await readView('GarageLevels');
    expect(view.dataRows.filter((r) => view.key(r, 'Garage') === 'north')).toHaveLength(4);
  });
});

describe('DisplaySchedules stays out of the write-side mirror', () => {
  it('never rewrites the tab, so hand-edited schedules survive a save', async () => {
    // Nothing in the app edits schedules, so the copy carried in a snapshot
    // goes stale the moment anyone edits the tab. Writing it back would undo
    // their edit; the tab is read on load instead.
    const scheduleRow = [
      'S1.1', '08:00', '17:00', 'Mon', '0', '0', '0', '0', 'a.png',
      'North', 'Level 1', '', '',
    ];
    h.fake.createSpreadsheet({ title: 'x', tabs: [] });
    const { ensureSpreadsheetTab } = await import('./GoogleSheetsService');
    await ensureSpreadsheetTab(spreadsheetId, 'DisplaySchedules');
    await writeTabValues(spreadsheetId, 'DisplaySchedules', [
      CONFIG_TAB_HEADERS.DisplaySchedules, scheduleRow,
    ], { valueInputOption: 'RAW' });

    await syncAllConfigTabsForCustomer({ customer, garages: GARAGES });

    const view = await readView('DisplaySchedules');
    expect(view.dataRows).toHaveLength(1);
    expect(view.get(view.dataRows[0], 'StartTime')).toBe('08:00');
    expect(view.get(view.dataRows[0], 'FilePath')).toBe('a.png');
  });
});

// ── A SHEET THAT DOES NOT HAVE ALL TEN TABS ─────────────────────────────────
/**
 * Real sheets predate the schema. Exxon-config, for instance, has no
 * `LPRCameras` tab and calls its sign tab `Displays` rather than
 * `DisplayControllers`.
 *
 * `values:batchGet` fails the WHOLE request with a 400 when any single range
 * names a sheet that does not exist — it does not skip the missing one. So one
 * absent tab took down the entire mirror, and because the caller logs the
 * failure rather than surfacing it, the config tabs silently never updated
 * again for that customer. Every other test seeded all ten tabs, which is
 * exactly why this went unnoticed.
 */
describe('a sheet missing some of the config tabs', () => {
  beforeEach(() => {
    h.fake = createFakeSheets();
    spreadsheetId = h.fake.createSpreadsheet({
      title: 'Exxon-config',
      // Exxon's real tab set: no LPRCameras, no DisplayControllers.
      tabs: RESYNCED_CONFIG_TABS.filter(
        (t) => t !== 'LPRCameras' && t !== 'DisplayControllers',
      ),
    }).id;
    customer = { spreadsheetId, customerId: 'exxon' };
  });

  it('still mirrors every tab that does exist', async () => {
    await syncAllConfigTabsForCustomer({ customer, garages: GARAGES });

    const view = await readView('Cameras');
    const row = view.dataRows.find((r) => view.key(r, 'Name') === '1.1f');
    expect(row).toBeTruthy();
    expect(view.get(row, 'IPAddress')).toBe('10.0.0.7');
  });

  it('writes the derived type tab too', async () => {
    await syncAllConfigTabsForCustomer({ customer, garages: GARAGES });

    const view = await readView('FLICameras');
    expect(view.dataRows.some((r) => view.key(r, 'CameraName') === '1.1f')).toBe(true);
  });

  it('does not report a tab it could not touch as changed', async () => {
    const { changedTabs } = await syncAllConfigTabsForCustomer({ customer, garages: GARAGES });

    expect(changedTabs).toContain('Cameras');
    expect(changedTabs).not.toContain('LPRCameras');
  });

  it('creates a missing tab when there is something to put in it', async () => {
    const withLpr = [{
      ...GARAGES[0],
      levels: [{
        ...GARAGES[0].levels[0],
        devices: [
          ...GARAGES[0].levels[0].devices,
          { id: 'cam-2', type: 'cam-lpr', name: '1.2L', ipAddress: '10.0.0.8', port: '554' },
        ],
      }],
    }];

    await syncAllConfigTabsForCustomer({ customer, garages: withLpr });

    // Otherwise the app holds an LPR camera the sheet can never show.
    const view = await readView('LPRCameras');
    expect(view.dataRows.some((r) => view.key(r, 'CameraName') === '1.2l')).toBe(true);
  });

  it('does not create a tab it has nothing to write', async () => {
    await syncAllConfigTabsForCustomer({ customer, garages: GARAGES });

    // No LPR cameras in state, so no empty tab littered onto the sheet.
    expect(h.fake.tabNames(spreadsheetId)).not.toContain('LPRCameras');
  });
});
