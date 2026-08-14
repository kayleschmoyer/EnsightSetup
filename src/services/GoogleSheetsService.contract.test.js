/**
 * Contract tests for GoogleSheetsService against a fake Sheets server that
 * reproduces Google's real semantics. These cover the read/write behaviors
 * that silently corrupt config tabs in production.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSheets } from './__fixtures__/fakeSheets';

const h = vi.hoisted(() => ({ fake: null }));

vi.mock('./GoogleDriveService', () => ({
  fetchWithTimeout: (...args) => h.fake.fetchWithTimeout(...args),
  getAccessToken: () => 'test-token',
  isSignedIn: () => true,
  hadGoogleSession: () => true,
  refreshAccessTokenSilently: async () => 'test-token',
  invalidateGoogleAccessToken: () => {},
  getFileMetadata: async () => ({
    id: 'file-1',
    mimeType: 'application/vnd.google-apps.spreadsheet',
  }),
  SPREADSHEET_MIME: 'application/vnd.google-apps.spreadsheet',
}));

const { readTabValues, writeTabValues, replaceTabValues } = await import('./GoogleSheetsService');

const CAMERA_HEADER = [
  'Name', 'VisibleCameraName', 'IPAddress', 'Port', 'DetectionType', 'Server',
  'RTSPURL', 'Status', 'Resolution',
];

const CAM_A = ['A1F', 'Entry A', '10.0.0.1', '554', 'FLI', 'srv1', 'rtsp://a', 'enabled', '640x480'];
const CAM_C = ['C1F', 'Entry C', '10.0.0.3', '554', 'FLI', 'srv1', 'rtsp://c', 'enabled', '1920x1080'];
// A camera whose optional columns are blank — Sheets trims these on read.
const CAM_B = ['B1F', '', '', '', '', '', '', '', ''];

let sheetId;

beforeEach(() => {
  h.fake = createFakeSheets();
  const ss = h.fake.createSpreadsheet({ title: 'Acme-config', tabs: ['Cameras'] });
  sheetId = ss.id;
});

describe('readTabValues', () => {
  it('returns rectangular rows even though Sheets trims trailing blanks', async () => {
    await writeTabValues(sheetId, 'Cameras', [CAMERA_HEADER, CAM_A, CAM_B], {
      valueInputOption: 'RAW',
    });

    const rows = await readTabValues(sheetId, 'Cameras');

    // Sheets itself returns ['B1F'] for the blank-tailed row. Every consumer in
    // ConfigSheetSyncService indexes by column, so the service must normalize.
    const widths = new Set(rows.map((row) => row.length));
    expect(widths.size).toBe(1);
    expect(rows[2]).toEqual(CAM_B);
  });
});

describe('writeTabValues value fidelity', () => {
  it('round-trips values Sheets would otherwise reinterpret', async () => {
    // Every one of these appears in real config tabs:
    //   '04:00'  GarageLevels.AutoResetCountTime
    //   '007'    Sensors.SensorId with a leading zero
    //   '+lens'  a camera name that Sheets reads as a formula
    //   '-1F'    a level name that Sheets reads as a formula
    //   '=Front' a position name that Sheets reads as a formula
    const values = [
      ['AutoResetCountTime', 'SensorId', 'CameraName', 'LevelName', 'PositionName'],
      ['04:00', '007', '+lens', '-1F', '=Front'],
    ];

    await writeTabValues(sheetId, 'Cameras', values);
    const rows = await readTabValues(sheetId, 'Cameras');

    expect(rows[1]).toEqual(['04:00', '007', '+lens', '-1F', '=Front']);
  });

  it('pads a ragged payload so a short row cannot inherit stale cells', async () => {
    await writeTabValues(sheetId, 'Cameras', [CAMERA_HEADER, CAM_A], {
      valueInputOption: 'RAW',
    });
    // Row 2 is rewritten with a single cell. The other eight columns of that
    // row must be cleared, not left holding CAM_A's values.
    await writeTabValues(sheetId, 'Cameras', [CAMERA_HEADER, ['B1F']], {
      valueInputOption: 'RAW',
    });

    const grid = h.fake.dumpTab(sheetId, 'Cameras');
    expect(grid[1].slice(0, 9)).toEqual(['B1F', '', '', '', '', '', '', '', '']);
  });

  it('keeps numbers numeric and strings literal under RAW', async () => {
    await writeTabValues(sheetId, 'Cameras', [['MaximumOccupancy'], [250], ['0250']]);
    const grid = h.fake.dumpTab(sheetId, 'Cameras');
    // A JS number stays a Sheets number so humans can still sort/sum the
    // column; a string stays exactly the string we sent.
    expect(grid[1][0]).toBe('250');
    expect(grid[2][0]).toBe('0250');
  });
});

describe('replaceTabValues', () => {
  it('leaves no cells behind when a row is removed and later rows shift up', async () => {
    await replaceTabValues(sheetId, 'Cameras', [CAMERA_HEADER, CAM_A, CAM_B, CAM_C], {
      valueInputOption: 'RAW',
    });

    // Exactly what upsertRowsByKey/deleteRowsByKeys do: read the tab, drop a
    // row, write what is left back from A1.
    const rows = await readTabValues(sheetId, 'Cameras');
    const kept = rows.slice(1).filter((row) => row[0] !== 'A1F');
    await replaceTabValues(sheetId, 'Cameras', [rows[0], ...kept], {
      previousRowCount: rows.length,
      valueInputOption: 'RAW',
    });

    const grid = h.fake.dumpTab(sheetId, 'Cameras');
    // B1F shifted into the row A1F used to occupy. Its blank columns must be
    // blank — not A1F's IP address, RTSP URL and resolution.
    expect(grid[1].slice(0, 9)).toEqual(CAM_B);
    expect(grid[2].slice(0, 9)).toEqual(CAM_C);
    expect(grid.filter((row) => row.some((cell) => cell !== ''))).toHaveLength(3);
  });

  it('clears columns to the right when the new payload is narrower', async () => {
    await replaceTabValues(sheetId, 'Cameras', [CAMERA_HEADER, CAM_A], {
      valueInputOption: 'RAW',
    });

    await replaceTabValues(sheetId, 'Cameras', [['Name'], ['A1F']], {
      previousRowCount: 2,
      valueInputOption: 'RAW',
    });

    const grid = h.fake.dumpTab(sheetId, 'Cameras');
    expect(grid[0].slice(0, 9)).toEqual(['Name', '', '', '', '', '', '', '', '']);
    expect(grid[1].slice(0, 9)).toEqual(['A1F', '', '', '', '', '', '', '', '']);
  });

  it('clears trailing rows when the new payload is shorter', async () => {
    await replaceTabValues(sheetId, 'Cameras', [CAMERA_HEADER, CAM_A, CAM_C], {
      valueInputOption: 'RAW',
    });
    await replaceTabValues(sheetId, 'Cameras', [CAMERA_HEADER, CAM_A], {
      previousRowCount: 3,
      valueInputOption: 'RAW',
    });

    const rows = await readTabValues(sheetId, 'Cameras');
    expect(rows).toHaveLength(2);
    expect(rows[1][0]).toBe('A1F');
  });
});
