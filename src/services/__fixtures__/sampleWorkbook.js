/**
 * sampleWorkbook — an in-memory 13-tab site-config workbook in the Ensight
 * template shape (CONFIG_TAB_HEADERS), for the parser / import mapper tests.
 * Every tab has at least one row and every column is filled, so a test can
 * assert that each cell reaches its database field. Built with the same xlsx
 * library the parser reads with, so it exercises the real header handling
 * (including the "IP Address  " column with its two trailing spaces).
 */
import * as XLSX from 'xlsx';
import { CONFIG_TAB_HEADERS } from '../../lib/configSheetSchema';

export const SAMPLE_ROWS = Object.freeze({
  Customer: [
    ['Acme Parking', 'acme', 'ACME', '1 Main St', 'Boston', 'MA', '02101',
      'https://maps.google.com/?q=1+Main+St', 'Ensight', '', 'TRUE', 'FALSE'],
  ],
  Networking: [
    ['Dell', 'EPIC Server', 'EPIC-01', 'Active', 'Server room', 'MDF-1',
      '10.0.0.5', 'Static', 'AA:BB:CC:00:00:05', '255.255.255.0', '10.0.0.1', '8.8.8.8',
      'admin', 'secret', 'Primary host', 'https://splashtop.example/epic-01'],
    ['', 'FLI', 'FLI-01', 'Active', 'Level 1 IDF', 'IDF-1',
      '10.0.0.6', 'DHCP', 'AA:BB:CC:00:00:06', '', '', '',
      '', '', '', ''],
  ],
  Garages: [
    ['North', 'North Garage', 'Live'],
  ],
  GarageLevels: [
    ['North', 'Level 1', 'Level 1', 'EPIC-01', 'FLI', 'TRUE', 250, 'FALSE', 0, '04:00', 5, 0, 0, 'TRUE', 'TRUE', 1, 1, '', ''],
    ['North', 'Level 1 Zone A', 'Level 1 Zone A', 'EPIC-01', 'FLI', 'TRUE', 40, 'FALSE', 0, '04:00', 5, 0, 0, 'TRUE', 'TRUE', 2, 2, '', ''],
    ['North', 'Level 2', 'Level 2', 'EPIC-01', 'FLI', 'FALSE', 200, 'TRUE', 10, '03:30', 7, 2, 30, 'FALSE', 'FALSE', 3, 3, 'Grid', 'Staff'],
  ],
  DisplayGroups: [
    ['Group1', 'FALSE', 15],
  ],
  DisplayControllers: [
    ['S1.1', 'CTRL-1', 'Entrance Sign', 'Group1', 'EPIC-01', '10.0.0.50', '5000', '1', 'SIGNALTECHDISPLAY', 'MAP1', 'LED', 'FALSE'],
    ['M1-A', 'MON-1', 'Monument A', 'Group1', 'EPIC-01', '10.0.0.60', '5000', '1', 'Daktronics', '', 'STATIC', 'TRUE'],
    ['M1-B', 'MON-1', 'Monument B', 'Group1', 'EPIC-01', '10.0.0.60', '5000', '2', 'Daktronics', '', 'STATIC', 'TRUE'],
  ],
  DisplayLevels: [
    ['S1.1', 'North', 'Level 1', 'Pos A', 'Level 1'],
    ['M1-A', 'North', 'Level 1', 'Lobby', ''],
    ['M1-B', 'North', 'All', 'Lobby', ''],
  ],
  DisplaySchedules: [
    ['S1.1', '06:00', '22:00', 'Mon', 10, 20, 100, 50, '/media/full.png', 'North', 'Level 1', 'North', 'Level 2'],
  ],
  Cameras: [
    ['CAM1.1F', 'Entrance Cam', '10.0.0.101', '554', 'FLI', 'EPIC-01', 'rtsp://10.0.0.101/live', 'Active', '1080p'],
    ['CAM2.1L', 'Exit LPR', '10.0.0.102', '554', 'LPR', 'EPIC-01', 'rtsp://10.0.0.102/live', 'Disabled', '4K'],
    ['CAMZ.1F', 'Zone Cam', '10.0.0.103', '554', 'FLI', 'FLI-01', 'rtsp://10.0.0.103/live', 'Active', '720p'],
  ],
  FLICameras: [
    ['CAM1.1F', 'North', 'Level 1', 'IN', 'TRUE', ''],
    ['CAMZ.1F', 'North', 'Level 1 Zone A', 'OUT', 'FALSE', 'CAM1.1F'],
  ],
  LPRCameras: [
    ['CAM2.1L', 'North', 'Level 2', 'OUT', 'TRUE', ''],
  ],
  SensorGroups: [
    ['G1', 'http://controller.local', 'key-1', 'NWAVE', 'North', 'Level 2', 'Level 2'],
  ],
  Sensors: [
    ['SENS-1', 'id-1', 'G1', 'Standard', 30],
    ['SENS-2', 'id-2', 'G1', 'Temp', ''],
  ],
});

/**
 * @param {{ rows?: object, omitTabs?: string[] }} [options]
 * @returns {ArrayBuffer}
 */
export function buildSampleWorkbookBuffer({ rows = SAMPLE_ROWS, omitTabs = [] } = {}) {
  const workbook = XLSX.utils.book_new();
  for (const [tab, headers] of Object.entries(CONFIG_TAB_HEADERS)) {
    if (omitTabs.includes(tab)) continue;
    const sheet = XLSX.utils.aoa_to_sheet([headers, ...(rows[tab] || [])]);
    XLSX.utils.book_append_sheet(workbook, sheet, tab);
  }
  const out = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  return out instanceof ArrayBuffer ? out : new Uint8Array(out).buffer;
}

export const SAMPLE_FILE = Object.freeze({
  id: 'drive-file-acme',
  name: 'Acme-config',
  mimeType: 'application/vnd.google-apps.spreadsheet',
  webViewLink: 'https://docs.google.com/spreadsheets/d/drive-file-acme/edit',
});
