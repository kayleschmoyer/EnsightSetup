/**
 * FIELD MATRIX — every column of every config tab.
 *
 * One test per tab, asserting the exact value each column receives from a fully
 * populated app model. Every field is given a distinctive value, so a column
 * that is dropped, mapped to the wrong header, defaulted over, or reinterpreted
 * by Sheets fails here rather than in production.
 *
 * This is the layer that matters most for "the sheet and the app must match":
 * it pins down what every single field is supposed to write.
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

const {
  syncAllConfigTabsForCustomer,
  syncCustomerToSheet,
  syncServersToSheet,
  loadServersFromNetworkingTab,
} = await import('../ConfigSheetSyncService');
const { readTabValues } = await import('../GoogleSheetsService');
const { buildTabView } = await import('../../lib/sheetTabView');

const ALL_TABS = [
  'Customer', 'Networking', 'Garages', 'GarageLevels', 'DisplayGroups',
  'DisplayControllers', 'DisplayLevels', 'DisplaySchedules', 'Cameras',
  'FLICameras', 'LPRCameras', 'SensorGroups', 'Sensors',
];

let spreadsheetId;
let customer;

/** Every field set to something distinctive, so a dropped field is visible. */
const SERVER = {
  id: 7,
  name: 'SRV-NORTH-01',
  manufacturer: 'Dell',
  type: 'FLI Server',
  status: 'Online',
  location: 'Level 1 IDF',
  mdfIdfLocation: 'IDF-2',
  subnet: '255.255.255.0',
  gateway: '10.0.0.254',
  dns: '8.8.8.8',
  splashtopUser: 'ensight-admin',
  splashtopPassword: 'p@ss-0123',
  splashtopUrl: 'https://stream.example.test/north',
  notes: 'replaced NIC 2025-06',
  ports: [{ ip: '10.0.0.50', mac: 'AA:BB:CC:DD:EE:FF', dhcp: false }],
};

const DISPLAY_GROUP = {
  id: 3,
  name: 'North-Entry-Group',
  sendOnlyOnUpdates: true,
  forceSendAfterSeconds: 45,
};

const SENSOR_GROUP = {
  id: 4,
  groupId: 'NWAVE-NORTH',
  controllerAddress: '10.0.0.77',
  controllerKey: 'key-abc-123',
  sensorProtocol: 'NWAVE',
  parentLevel: 'Level 0',
};

const CAMERA = {
  id: 'cam-1',
  type: 'cam-fli',
  name: '1.1F',
  visibleName: 'North Entry Lane 1',
  ipAddress: '10.0.1.11',
  port: '5540',
  resolution: '2560x1440',
  rtspUrl: 'rtsp://operator:secret@10.0.1.11/stream1',
  server: 'SRV-NORTH-01',
  disabled: false,
  isEntryExitCamera: false,
  dependentCameraName: '1.2F',
  trafficFlow: { direction: 'in' },
};

const LPR_CAMERA = {
  ...CAMERA,
  id: 'cam-2',
  type: 'cam-lpr',
  name: '1.3L',
  visibleName: 'North LPR',
  ipAddress: '10.0.1.13',
  dependentCameraName: '',
  trafficFlow: { direction: 'out' },
};

const SIGN = {
  id: 'sign-1',
  type: 'sign-static',
  name: 'S1.1',
  controllerName: 'CTRL-S1-1',
  visibleName: 'North Entry Sign',
  displayGroupId: 3,
  server: 'SRV-NORTH-01',
  ipAddress: '10.0.2.21',
  port: '10001',
  serialAddress: '3',
  displayProtocol: 'SignalTechVMS',
  displayMap: 'map-a',
  hardwareType: 'VMS-3',
  keepLevelCountsSeparate: true,
  positionName: 'Entry North',
  displayGarageId: 1,
  displayLevelIds: [10],
};

const SENSOR = {
  id: 'sensor-1',
  type: 'sensor-nwave',
  name: 'SEN-1',
  configSensorGroupId: 4,
  sensors: [{
    sensorName: 'SEN-1',
    sensorId: 'S-0001',
    parkingType: 'Temporary',
    tempParkingTimeInMinutes: 90,
  }],
};

const LEVEL = {
  id: 10,
  name: 'Ground Floor',
  internalName: 'Level 1',
  totalSpots: 137,
  evSpots: 4,
  handicapSpots: 6,
  devices: [CAMERA, LPR_CAMERA, SIGN, SENSOR],
  config: {
    server: 'SRV-NORTH-01',
    levelType: 'LPR',
    visibleOnPortal: false,
    maximumOccupancy: 999,
    autoResetCountsEnabled: true,
    autoResetCountValue: 12,
    autoResetCountTime: '04:00',
    forceFullVacancyThreshold: 8,
    vehicleTransitThreshold: 3,
    vehicleTransitThresholdTTLSeconds: 45,
    showFullMessage: false,
    showFullMessageRed: false,
    portalRendering: 'compact',
    vehicleRolesAllowed: 'staff,visitor',
  },
};

const GARAGE = {
  id: 1,
  name: 'North Deck',
  internalName: 'NorthDeck',
  stage: 'live',
  displayGroups: [DISPLAY_GROUP],
  sensorGroups: [SENSOR_GROUP],
  servers: [SERVER],
  levels: [LEVEL],
};

const CUSTOMER_RECORD = {
  customerId: 'acme',
  code: 'ACME',
  friendlyName: 'Acme Health',
  config: {
    address: '100 Main St',
    city: 'Boston',
    state: 'MA',
    zip: '02101',
    mapsUrl: 'https://maps.example.test/acme',
    support: {
      maintenanceProvider: 'aps',
      maintenanceOther: 'After hours: APS',
      enterpriseSite: true,
      support24Hour: true,
    },
  },
};

async function view(tabName) {
  return buildTabView(tabName, await readTabValues(spreadsheetId, tabName));
}

/** Assert every named column on the matching row, and report all mismatches. */
function expectRow(v, row, expected) {
  const wrong = [];
  for (const [column, value] of Object.entries(expected)) {
    const actual = String(v.get(row, column) ?? '');
    if (actual !== String(value)) wrong.push(`${column}: expected "${value}", got "${actual}"`);
  }
  expect(wrong).toEqual([]);
}

beforeEach(async () => {
  h.fake = createFakeSheets();
  spreadsheetId = h.fake.createSpreadsheet({ title: 'Acme-config', tabs: ALL_TABS }).id;
  customer = { ...CUSTOMER_RECORD, spreadsheetId };
  await syncAllConfigTabsForCustomer({ customer, garages: [GARAGE], servers: [SERVER] });
});

describe('Customer tab', () => {
  it('writes every column', async () => {
    await syncCustomerToSheet({ customer });
    const v = await view('Customer');
    expectRow(v, v.dataRows[0], {
      FriendlyName: 'Acme Health',
      CustomerId: 'acme',
      Code: 'ACME',
      Address: '100 Main St',
      City: 'Boston',
      State: 'MA',
      Zip: '02101',
      GoogleMapsUrl: 'https://maps.example.test/acme',
      MaintenanceProvider: 'aps',
      MaintenanceOther: 'After hours: APS',
      EnterpriseSite: 'TRUE',
      Support24Hour: 'TRUE',
    });
  });
});

describe('Garages tab', () => {
  it('writes every column, using internalName as the key and name as the visible one', async () => {
    const v = await view('Garages');
    expectRow(v, v.dataRows[0], {
      Garage: 'NorthDeck',
      VisibleGarageName: 'North Deck',
      Stage: 'live',
    });
  });
});

describe('GarageLevels tab', () => {
  it('writes all 19 columns from the level and its config', async () => {
    const v = await view('GarageLevels');
    expectRow(v, v.dataRows[0], {
      Garage: 'NorthDeck',
      Level: 'Level 1',
      VisibleLevelName: 'Ground Floor',
      Server: 'SRV-NORTH-01',
      LevelType: 'LPR',
      VisibleOnPortal: 'FALSE',
      // totalSpots wins over config.maximumOccupancy — it is the edited field.
      MaximumOccupancy: '137',
      AutoResetCountsEnabled: 'TRUE',
      AutoResetCountValue: '12',
      AutoResetCountTime: '04:00',
      ForceFullVacancyThreshold: '8',
      VehicleTransitThreshold: '3',
      VehicleTransitThresholdTTLSeconds: '45',
      ShowFullMessage: 'FALSE',
      ShowFullMessageRed: 'FALSE',
      PortalDisplayOrdinal: '1',
      SignDisplayOrdinal: '1',
      PortalRendering: 'compact',
      VehicleRolesAllowed: 'staff,visitor',
    });
  });

  it('covers every column in the schema', async () => {
    const v = await view('GarageLevels');
    for (const column of CONFIG_TAB_HEADERS.GarageLevels) {
      expect(v.indexOf(column), `missing column ${column}`).not.toBe(-1);
    }
  });
});

describe('Cameras tab', () => {
  it('writes every column for an FLI camera', async () => {
    const v = await view('Cameras');
    const row = v.dataRows.find((r) => v.key(r, 'Name') === '1.1f');
    expectRow(v, row, {
      Name: '1.1F',
      VisibleCameraName: 'North Entry Lane 1',
      IPAddress: '10.0.1.11',
      Port: '5540',
      DetectionType: 'FLI',
      Server: 'SRV-NORTH-01',
      RTSPURL: 'rtsp://operator:secret@10.0.1.11/stream1',
      Status: 'enabled',
      Resolution: '2560x1440',
    });
  });

  it('marks a disabled camera as disabled', async () => {
    await syncAllConfigTabsForCustomer({
      customer,
      garages: [{
        ...GARAGE,
        levels: [{ ...LEVEL, devices: [{ ...CAMERA, disabled: true }] }],
      }],
    });
    const v = await view('Cameras');
    const row = v.dataRows.find((r) => v.key(r, 'Name') === '1.1f');
    expect(v.get(row, 'Status')).toBe('disabled');
  });

  it('routes an LPR camera to DetectionType LPR', async () => {
    const v = await view('Cameras');
    const row = v.dataRows.find((r) => v.key(r, 'Name') === '1.3l');
    expect(v.get(row, 'DetectionType')).toBe('LPR');
  });
});

describe('FLICameras / LPRCameras tabs', () => {
  it('writes every column, and sends each camera to the tab for its type', async () => {
    const fli = await view('FLICameras');
    expectRow(fli, fli.dataRows[0], {
      CameraName: '1.1F',
      Garage: 'NorthDeck',
      Level: 'Level 1',
      // trafficFlow 'in' means the back of the car is leaving: BackOfCarIs = IN
      BackOfCarIs: 'IN',
      IsEntryExitCamera: 'false',
      DependentCameraName: '1.2F',
    });

    const lpr = await view('LPRCameras');
    expectRow(lpr, lpr.dataRows[0], {
      CameraName: '1.3L',
      Garage: 'NorthDeck',
      Level: 'Level 1',
      BackOfCarIs: 'OUT',
      DependentCameraName: '',
    });

    // An FLI camera must not appear on the LPR tab, or vice versa.
    expect(fli.dataRows.some((r) => fli.key(r, 'CameraName') === '1.3l')).toBe(false);
    expect(lpr.dataRows.some((r) => lpr.key(r, 'CameraName') === '1.1f')).toBe(false);
  });
});

describe('DisplayControllers tab', () => {
  it('writes every column', async () => {
    const v = await view('DisplayControllers');
    expectRow(v, v.dataRows[0], {
      DisplayName: 'S1.1',
      DisplayControllerName: 'CTRL-S1-1',
      VisibleDisplayName: 'North Entry Sign',
      DisplayGroupName: 'North-Entry-Group',
      Server: 'SRV-NORTH-01',
      IPAddress: '10.0.2.21',
      Port: '10001',
      SerialAddress: '3',
      DisplayProtocol: 'SignalTechVMS',
      DisplayMap: 'map-a',
      HardwareType: 'VMS-3',
      KeepLevelCountsSeparate: 'TRUE',
    });
  });
});

describe('DisplayLevels tab', () => {
  it('writes every column for a sign assigned to one level', async () => {
    const v = await view('DisplayLevels');
    expectRow(v, v.dataRows[0], {
      DisplayName: 'S1.1',
      Garage: 'NorthDeck',
      Level: 'Level 1',
      PositionName: 'Entry North',
      LevelName: 'Ground Floor',
    });
  });

  it('writes Level = All for a sign covering the whole site', async () => {
    await syncAllConfigTabsForCustomer({
      customer,
      garages: [{
        ...GARAGE,
        levels: [{ ...LEVEL, devices: [{ ...SIGN, displayLevelAll: true }] }],
      }],
    });
    const v = await view('DisplayLevels');
    expect(v.get(v.dataRows[0], 'Level')).toBe('All');
  });
});

describe('DisplayGroups tab', () => {
  it('writes every column', async () => {
    const v = await view('DisplayGroups');
    expectRow(v, v.dataRows[0], {
      Name: 'North-Entry-Group',
      SendOnlyOnUpdates: 'TRUE',
      ForceSendAfterSeconds: '45',
    });
  });
});

describe('SensorGroups tab', () => {
  it('writes every column', async () => {
    const v = await view('SensorGroups');
    expectRow(v, v.dataRows[0], {
      GroupID: 'NWAVE-NORTH',
      ControllerAddress: '10.0.0.77',
      ControllerKey: 'key-abc-123',
      SensorProtocol: 'NWAVE',
      Garage: 'NorthDeck',
      Level: 'Level 1',
      ParentLevel: 'Level 0',
    });
  });
});

describe('Sensors tab', () => {
  it('writes every column', async () => {
    const v = await view('Sensors');
    expectRow(v, v.dataRows[0], {
      SensorName: 'SEN-1',
      SensorId: 'S-0001',
      SensorGroupID: 'NWAVE-NORTH',
      ParkingType: 'Temporary',
      TempParkingTimeInMinutes: '90',
    });
  });
});

describe('Networking tab', () => {
  it('writes every column and reads each one back', async () => {
    await syncServersToSheet({ customer, garage: GARAGE });

    const v = await view('Networking');
    expectRow(v, v.dataRows[0], {
      Manufacturer: 'Dell',
      Device: 'FLI Server',
      Name: 'SRV-NORTH-01',
      Status: 'Online',
      Location: 'Level 1 IDF',
      'IDF/MDF Location': 'IDF-2',
      'IP Address': '10.0.0.50',
      'IP Assignment Method': 'Static',
      'MAC Address': 'AA:BB:CC:DD:EE:FF',
      Subnet: '255.255.255.0',
      Gateway: '10.0.0.254',
      DNS: '8.8.8.8',
      Username: 'ensight-admin',
      Password: 'p@ss-0123',
      Notes: 'replaced NIC 2025-06',
      'Stream Address': 'https://stream.example.test/north',
    });

    // Round-trip: everything the sheet holds comes back into the app model.
    const [readBack] = await loadServersFromNetworkingTab(customer);
    expect(readBack.name).toBe('SRV-NORTH-01');
    expect(readBack.manufacturer).toBe('Dell');
    expect(readBack.status).toBe('Online');
    expect(readBack.location).toBe('Level 1 IDF');
    expect(readBack.mdfIdfLocation).toBe('IDF-2');
    expect(readBack.subnet).toBe('255.255.255.0');
    expect(readBack.gateway).toBe('10.0.0.254');
    expect(readBack.dns).toBe('8.8.8.8');
    expect(readBack.splashtopUser).toBe('ensight-admin');
    expect(readBack.splashtopPassword).toBe('p@ss-0123');
    expect(readBack.splashtopUrl).toBe('https://stream.example.test/north');
    expect(readBack.notes).toBe('replaced NIC 2025-06');
    expect(readBack.ports[0].ip).toBe('10.0.0.50');
    expect(readBack.ports[0].mac).toBe('AA:BB:CC:DD:EE:FF');
    expect(readBack.ports[0].dhcp).toBe(false);
  });

  it('records DHCP when the port is not static', async () => {
    await syncServersToSheet({
      customer,
      garage: { ...GARAGE, servers: [{ ...SERVER, ports: [{ ...SERVER.ports[0], dhcp: true }] }] },
    });
    const v = await view('Networking');
    expect(v.get(v.dataRows[0], 'IP Assignment Method')).toBe('DHCP');
    const [readBack] = await loadServersFromNetworkingTab(customer);
    expect(readBack.ports[0].dhcp).toBe(true);
  });
});

describe('no field is silently dropped', () => {
  it('every schema column exists on every synced tab', async () => {
    await syncCustomerToSheet({ customer });
    await syncServersToSheet({ customer, garage: GARAGE });

    const missing = [];
    for (const tab of ALL_TABS) {
      if (tab === 'DisplaySchedules') continue; // read-only; not written by the app
      const v = await view(tab);
      for (const column of CONFIG_TAB_HEADERS[tab]) {
        if (v.indexOf(column) === -1) missing.push(`${tab}.${column}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
