import { describe, expect, it } from 'vitest';
import { buildTabView, normalizeHeaderName } from './sheetTabView';
import { CONFIG_TAB_HEADERS } from './configSheetSchema';

const CAMERA_ROW = [
  '1.1F', 'Entry', '10.0.0.1', '554', 'FLI', 'srv1', 'rtsp://a', 'enabled', '640x480',
];

describe('normalizeHeaderName', () => {
  it('ignores case and surrounding/collapsed whitespace', () => {
    // The Networking schema really does carry 'IP Address  ' with trailing
    // spaces, matching the Ensight xlsx template.
    expect(normalizeHeaderName('IP Address  ')).toBe('ip address');
    expect(normalizeHeaderName('  ip   ADDRESS ')).toBe('ip address');
  });
});

describe('buildTabView', () => {
  it('falls back to the schema header for an empty tab', () => {
    const view = buildTabView('Cameras', []);
    expect(view.header).toEqual(CONFIG_TAB_HEADERS.Cameras);
    expect(view.indexOf('DetectionType')).toBe(4);
  });

  it('resolves columns from the sheet, not the schema, when they differ', () => {
    // Someone inserted "Notes" as the second column by hand.
    const sheetHeader = [
      'Name', 'Notes', 'VisibleCameraName', 'IPAddress', 'Port', 'DetectionType',
      'Server', 'RTSPURL', 'Status', 'Resolution',
    ];
    const view = buildTabView('Cameras', [sheetHeader]);

    expect(view.indexOf('Name')).toBe(0);
    expect(view.indexOf('VisibleCameraName')).toBe(2);
    expect(view.indexOf('DetectionType')).toBe(5);
    expect(view.indexOf('Resolution')).toBe(9);
    expect(view.missingHeaders).toEqual([]);
  });

  it('writes schema values into the sheet layout and keeps unknown columns', () => {
    const sheetHeader = [
      'Name', 'Notes', 'VisibleCameraName', 'IPAddress', 'Port', 'DetectionType',
      'Server', 'RTSPURL', 'Status', 'Resolution',
    ];
    const existing = [
      '1.1F', 'replaced lens 2025-03', 'Old', '1.1.1.1', '1', 'LPR', 's', 'r', 'disabled', '1x1',
    ];
    const view = buildTabView('Cameras', [sheetHeader, existing]);

    const row = view.rowFromSchemaValues(CAMERA_ROW, view.dataRows[0]);

    // Schema values land under their own headers...
    expect(view.get(row, 'IPAddress')).toBe('10.0.0.1');
    expect(view.get(row, 'DetectionType')).toBe('FLI');
    expect(view.get(row, 'Resolution')).toBe('640x480');
    // ...and the hand-added column is untouched.
    expect(view.get(row, 'Notes')).toBe('replaced lens 2025-03');
  });

  it('appends schema columns the sheet is missing instead of shifting data', () => {
    const sheetHeader = ['Name', 'IPAddress', 'DetectionType'];
    const view = buildTabView('Cameras', [sheetHeader, ['1.1F', '10.0.0.1', 'FLI']]);

    expect(view.missingHeaders).toContain('Resolution');
    expect(view.indexOf('Name')).toBe(0);
    expect(view.indexOf('IPAddress')).toBe(1);
    // Existing data keeps its position; the new columns go on the end.
    expect(view.indexOf('Resolution')).toBeGreaterThanOrEqual(3);
    expect(view.get(view.dataRows[0], 'IPAddress')).toBe('10.0.0.1');
  });

  it('pads short rows so a column read never falls off the end', () => {
    const view = buildTabView('Cameras', [CONFIG_TAB_HEADERS.Cameras, ['1.1F']]);
    expect(view.dataRows[0]).toHaveLength(view.width);
    expect(view.get(view.dataRows[0], 'Resolution')).toBe('');
  });

  it('keys rows case- and whitespace-insensitively', () => {
    const view = buildTabView('Cameras', [CONFIG_TAB_HEADERS.Cameras, ['  1.1F  ']]);
    expect(view.key(view.dataRows[0], 'Name')).toBe('1.1f');
  });

  it('ignores a duplicated header rather than retargeting the column', () => {
    const sheetHeader = ['Name', 'Name', 'IPAddress'];
    const view = buildTabView('Cameras', [sheetHeader]);
    expect(view.indexOf('Name')).toBe(0);
  });

  it('round-trips through toValues at a stable width', () => {
    const view = buildTabView('Garages', [['Garage', 'VisibleGarageName', 'Stage', 'Owner']]);
    const row = view.rowFromSchemaValues(['North', 'North Deck', 'live']);
    const values = view.toValues([row]);

    expect(values[0]).toEqual(['Garage', 'VisibleGarageName', 'Stage', 'Owner']);
    expect(values[1]).toEqual(['North', 'North Deck', 'live', '']);
    expect(values.every((r) => r.length === view.width)).toBe(true);
  });

  it('locates DisplaySchedules garage columns by name, not index 9 and 11', () => {
    const view = buildTabView('DisplaySchedules', []);
    expect(view.indexOf('Garage1')).toBe(9);
    expect(view.indexOf('Garage2')).toBe(11);

    // Same tab after someone inserted a column at the front.
    const shifted = buildTabView('DisplaySchedules', [
      ['Site', ...CONFIG_TAB_HEADERS.DisplaySchedules],
    ]);
    expect(shifted.indexOf('Garage1')).toBe(10);
    expect(shifted.indexOf('Garage2')).toBe(12);
  });
});
