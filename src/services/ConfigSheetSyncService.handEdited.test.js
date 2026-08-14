/**
 * The config tabs are hand-edited by people and read by downstream software,
 * so a sync must survive a sheet whose columns are not exactly the schema.
 *
 * Previously the sync helpers read and wrote fixed indices (row[0], row[4],
 * row[9], row[11]) while building row content in CONFIG_TAB_HEADERS order. One
 * inserted column and every later write landed one column off — silently,
 * because the header row itself was written back untouched.
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

const { syncCameraToSheet, syncGarageToSheet, deleteCameraFromSheet } = await import('./ConfigSheetSyncService');
const { writeTabValues, readTabValues } = await import('./GoogleSheetsService');
const { buildTabView } = await import('../lib/sheetTabView');

let spreadsheetId;
let customer;

const GARAGE = { id: 1, name: 'North', internalName: 'North' };
const LEVEL = { id: 10, name: 'Level 1', internalName: 'Level 1', devices: [] };

function camera(overrides = {}) {
  return {
    id: 'cam-1',
    type: 'cam-fli',
    name: '1.1F',
    visibleName: 'North Entry',
    ipAddress: '10.0.0.7',
    port: '554',
    resolution: '1920x1080',
    ...overrides,
  };
}

/** Read a tab back as {header, rows} addressed by name. */
async function readView(tabName) {
  const rows = await readTabValues(spreadsheetId, tabName);
  return buildTabView(tabName, rows);
}

beforeEach(() => {
  h.fake = createFakeSheets();
  spreadsheetId = h.fake.createSpreadsheet({
    title: 'Acme-config',
    tabs: ['Garages', 'GarageLevels', 'Cameras', 'FLICameras', 'LPRCameras', 'DisplaySchedules'],
  }).id;
  customer = { spreadsheetId, customerId: 'acme' };
});

describe('a Cameras tab with a hand-added column', () => {
  const SHEET_HEADER = [
    'Name', 'Notes', 'VisibleCameraName', 'IPAddress', 'Port', 'DetectionType',
    'Server', 'RTSPURL', 'Status', 'Resolution',
  ];

  beforeEach(async () => {
    await writeTabValues(spreadsheetId, 'Cameras', [
      SHEET_HEADER,
      ['1.1F', 'lens replaced 2025-03', 'Old Name', '1.1.1.1', '1', 'LPR', '', '', 'disabled', '1x1'],
      ['2.1F', 'do not touch', 'Second', '10.0.0.8', '554', 'FLI', '', '', 'enabled', '640x480'],
    ]);
  });

  it('writes each value under its own header, not by position', async () => {
    await syncCameraToSheet({ customer, garage: GARAGE, level: LEVEL, device: camera() });

    const view = await readView('Cameras');
    const row = view.dataRows.find((r) => view.key(r, 'Name') === '1.1f');

    expect(view.get(row, 'VisibleCameraName')).toBe('North Entry');
    expect(view.get(row, 'IPAddress')).toBe('10.0.0.7');
    expect(view.get(row, 'Port')).toBe('554');
    expect(view.get(row, 'DetectionType')).toBe('FLI');
    expect(view.get(row, 'Resolution')).toBe('1920x1080');
    expect(view.get(row, 'Status')).toBe('enabled');
  });

  it('preserves the hand-added column on the row it rewrites', async () => {
    await syncCameraToSheet({ customer, garage: GARAGE, level: LEVEL, device: camera() });

    const view = await readView('Cameras');
    const row = view.dataRows.find((r) => view.key(r, 'Name') === '1.1f');
    expect(view.get(row, 'Notes')).toBe('lens replaced 2025-03');
  });

  it('leaves other rows and the header exactly as the team wrote them', async () => {
    await syncCameraToSheet({ customer, garage: GARAGE, level: LEVEL, device: camera() });

    const view = await readView('Cameras');
    expect(view.header).toEqual(SHEET_HEADER);

    const other = view.dataRows.find((r) => view.key(r, 'Name') === '2.1f');
    expect(view.get(other, 'Notes')).toBe('do not touch');
    expect(view.get(other, 'IPAddress')).toBe('10.0.0.8');
    expect(view.get(other, 'Resolution')).toBe('640x480');
  });

  it('keeps the column intact when a row is deleted and the rest shift up', async () => {
    await deleteCameraFromSheet({ customer, device: camera({ name: '1.1F' }) });

    const view = await readView('Cameras');
    expect(view.dataRows.filter((r) => view.key(r, 'Name'))).toHaveLength(1);
    const remaining = view.dataRows.find((r) => view.key(r, 'Name') === '2.1f');
    expect(view.get(remaining, 'Notes')).toBe('do not touch');
    expect(view.get(remaining, 'Resolution')).toBe('640x480');
  });
});

describe('a Cameras tab missing a schema column', () => {
  it('appends the column instead of shifting the existing data', async () => {
    await writeTabValues(spreadsheetId, 'Cameras', [
      ['Name', 'IPAddress', 'DetectionType'],
      ['9.1F', '10.0.0.9', 'FLI'],
    ]);

    await syncCameraToSheet({ customer, garage: GARAGE, level: LEVEL, device: camera() });

    const view = await readView('Cameras');
    const existing = view.dataRows.find((r) => view.key(r, 'Name') === '9.1f');
    expect(view.get(existing, 'IPAddress')).toBe('10.0.0.9');
    expect(view.get(existing, 'DetectionType')).toBe('FLI');

    const added = view.dataRows.find((r) => view.key(r, 'Name') === '1.1f');
    expect(view.get(added, 'Resolution')).toBe('1920x1080');
  });
});

describe('a generated RTSP URL', () => {
  beforeEach(async () => {
    await writeTabValues(spreadsheetId, 'Cameras', [CONFIG_TAB_HEADERS.Cameras]);
  });

  it('does not overwrite a URL already on the sheet', async () => {
    // The generated fallback embeds the current year, so re-syncing an
    // untouched camera in a new year used to rewrite this silently.
    const typedByHand = 'rtsp://operator:secret@10.0.0.7/stream1';
    await writeTabValues(spreadsheetId, 'Cameras', [
      CONFIG_TAB_HEADERS.Cameras,
      ['1.1F', 'North Entry', '10.0.0.7', '554', 'FLI', '', typedByHand, 'enabled', '1920x1080'],
    ]);

    await syncCameraToSheet({ customer, garage: GARAGE, level: LEVEL, device: camera() });

    const view = await readView('Cameras');
    const row = view.dataRows.find((r) => view.key(r, 'Name') === '1.1f');
    expect(view.get(row, 'RTSPURL')).toBe(typedByHand);
  });

  it('still writes a default for a camera that has none', async () => {
    await syncCameraToSheet({ customer, garage: GARAGE, level: LEVEL, device: camera() });

    const view = await readView('Cameras');
    const row = view.dataRows.find((r) => view.key(r, 'Name') === '1.1f');
    expect(view.get(row, 'RTSPURL')).toContain('rtsp://');
    expect(view.get(row, 'RTSPURL')).toContain('10.0.0.7');
  });

  it('writes an explicitly configured URL over whatever is there', async () => {
    await writeTabValues(spreadsheetId, 'Cameras', [
      CONFIG_TAB_HEADERS.Cameras,
      ['1.1F', 'x', '1.1.1.1', '1', 'FLI', '', 'rtsp://stale/old', 'enabled', '1x1'],
    ]);

    await syncCameraToSheet({
      customer,
      garage: GARAGE,
      level: LEVEL,
      device: camera({ rtspUrl: 'rtsp://configured/new' }),
    });

    const view = await readView('Cameras');
    const row = view.dataRows.find((r) => view.key(r, 'Name') === '1.1f');
    expect(view.get(row, 'RTSPURL')).toBe('rtsp://configured/new');
  });
});

describe('DisplaySchedules garage columns', () => {
  it('follows Garage1/Garage2 by name when a column was inserted before them', async () => {
    const shiftedHeader = ['Site', ...CONFIG_TAB_HEADERS.DisplaySchedules];
    const scheduleRow = [
      'ops', 'S1.1', '08:00', '17:00', 'Mon', '0', '0', '0', '0', 'a.png',
      'North', 'Level 1', 'North', 'Level 2',
    ];
    await writeTabValues(spreadsheetId, 'DisplaySchedules', [shiftedHeader, scheduleRow]);
    await writeTabValues(spreadsheetId, 'Garages', [
      CONFIG_TAB_HEADERS.Garages, ['North', 'North', ''],
    ]);

    // Rename the garage: schedules must be retargeted via the named columns.
    await syncGarageToSheet({
      customer,
      garage: { ...GARAGE, name: 'North Deck', internalName: 'NorthDeck', levels: [] },
      previousGarage: GARAGE,
    });

    const view = await readView('DisplaySchedules');
    const row = view.dataRows[0];
    expect(view.get(row, 'Garage1')).toBe('NorthDeck');
    expect(view.get(row, 'Garage2')).toBe('NorthDeck');
    // The hand-added leading column and the untouched fields survive.
    expect(row[0]).toBe('ops');
    expect(view.get(row, 'DisplayName')).toBe('S1.1');
    expect(view.get(row, 'Level1')).toBe('Level 1');
    expect(view.get(row, 'FilePath')).toBe('a.png');
  });
});
