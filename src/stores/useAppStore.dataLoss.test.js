/**
 * The regression that matters most: a failed read of the shared layout must
 * never be written back over the sheet.
 *
 * The old sequence was — localStorage held garage/level stubs with empty
 * devices, the SetupJson read failed, the error surfaced only as a small chip,
 * the user dragged one device, and the 4s auto-save pushed the stub state over
 * a complete layout. Because the failure path also left `lastSetupSavedAt`
 * null, the conflict check was skipped and the overwrite was unconditional.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSheets } from '../services/__fixtures__/fakeSheets';
import { installBrowserEnv } from '../services/__fixtures__/browserEnv';

const h = vi.hoisted(() => ({ fake: null, configBuffer: null }));

vi.mock('../services/GoogleDriveService', () => ({
  fetchWithTimeout: (...args) => h.fake.fetchWithTimeout(...args),
  getAccessToken: () => 'test-token',
  isSignedIn: () => true,
  hadGoogleSession: () => true,
  refreshAccessTokenSilently: async () => 'test-token',
  invalidateGoogleAccessToken: () => {},
  getFileMetadata: async () => ({ id: 'f', mimeType: 'application/vnd.google-apps.spreadsheet' }),
  updateFileAppProperties: async () => ({}),
  findConfigSheetInFolder: async () => null,
  trashDriveFile: async () => ({}),
  downloadConfigFile: async () => h.configBuffer ?? new ArrayBuffer(0),
  renameDriveFile: async () => ({}),
  SPREADSHEET_MIME: 'application/vnd.google-apps.spreadsheet',
}));

installBrowserEnv();

const { useAppStore } = await import('./useAppStore');
const { setupJsonChunksFromPayload } = await import('../services/LayoutPersistenceService');

const LAYOUT = {
  schemaVersion: 1,
  savedAt: '2026-08-07T10:00:00.000Z',
  app: 'garage-layout-editor',
  customer: {
    customerId: 'acme',
    code: 'ACME',
    friendlyName: 'Acme',
    config: { address: '1 Main', city: 'Boston', state: 'MA', zip: '02101', mapsUrl: '', support: {} },
    garages: [{
      id: 1,
      name: 'North',
      internalName: 'North',
      levels: [{
        id: 10,
        name: 'Level 1',
        bgImage: 'data:image/png;base64,AAAABBBBCCCC',
        devices: [{ id: 'cam-1', type: 'cam-fli', name: '1.1F', x: 120, y: 240 }],
        zones: [{ id: 'z1', points: [{ x: 0, y: 0 }] }],
      }],
    }],
  },
};

let spreadsheetId;

/** The customer as localStorage now stores it: pointers only, no layout. */
function pointerCustomer() {
  return {
    id: 1,
    customerId: 'acme',
    code: 'ACME',
    friendlyName: 'Acme',
    spreadsheetId,
    garages: null,
    lastSetupSavedAt: null,
  };
}

function writeCount() {
  return h.fake.requests.filter((r) => r.method === 'PUT' || r.method === 'POST').length;
}

beforeEach(async () => {
  h.fake = createFakeSheets();
  const ss = h.fake.createSpreadsheet({ title: 'Acme-config', tabs: ['Garages', 'SetupJson'] });
  spreadsheetId = ss.id;

  const { writeTabValues } = await import('../services/GoogleSheetsService');
  await writeTabValues(spreadsheetId, 'SetupJson', setupJsonChunksFromPayload(LAYOUT), {
    valueInputOption: 'RAW',
  });

  useAppStore.setState({
    customers: [pointerCustomer()],
    selectedCustomerId: 1,
    selectedGarageId: null,
    selectedLevelId: null,
    hydration: {},
    pendingRoute: null,
    currentView: 'garages',
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a failed shared-layout read', () => {
  beforeEach(() => {
    // Not retryable, so it fails fast rather than backing off for 15s.
    h.fake.failNext({
      match: (ctx) => ctx.method === 'GET' && ctx.path.includes('/values/'),
      status: 500,
      message: 'Backend error',
      times: 99,
    });
  });

  it('marks the customer failed and leaves garages unloaded', async () => {
    await useAppStore.getState().loadSetupFromSheet(1);

    const state = useAppStore.getState();
    expect(state.hydration[1]).toBe('failed');
    expect(state.setupSync.status).toBe('error');
    // Crucially: no empty layout is fabricated to stand in for the real one.
    expect(state.customers[0].garages).toBe(null);
  });

  it('does not write anything to the sheet when the user then edits', async () => {
    vi.useFakeTimers();
    await useAppStore.getState().loadSetupFromSheet(1);
    const before = writeCount();

    // The user edits. Under the old code this scheduled an auto-save that
    // replaced the entire SetupJson tab with the empty local state.
    useAppStore.getState().updateCustomer(1, { friendlyName: 'Acme Renamed' });
    useAppStore.getState().setGarages((garages) => [...garages, { id: 99, name: 'Ghost', levels: [] }]);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(writeCount()).toBe(before);
    expect(useAppStore.getState().customers[0].garages).toBe(null);
  });

  it('refuses an explicit save too, not just the debounced one', async () => {
    await useAppStore.getState().loadSetupFromSheet(1);
    const before = writeCount();

    await useAppStore.getState().saveCustomerSetupToSheet(1);

    expect(writeCount()).toBe(before);
    expect(useAppStore.getState().setupSync.status).toBe('error');
  });

  it('leaves the sheet byte-for-byte intact', async () => {
    const snapshotBefore = JSON.stringify(h.fake.dumpTab(spreadsheetId, 'SetupJson'));
    await useAppStore.getState().loadSetupFromSheet(1);
    useAppStore.getState().updateCustomer(1, { friendlyName: 'Acme Renamed' });
    await useAppStore.getState().saveCustomerSetupToSheet(1);

    expect(JSON.stringify(h.fake.dumpTab(spreadsheetId, 'SetupJson'))).toBe(snapshotBefore);
  });
});

describe('recovering after the read succeeds', () => {
  it('hydrates the real layout and only then allows saving', async () => {
    // One failure: the SetupJson read on the first attempt. The load aborts
    // there, so nothing else is requested.
    h.fake.failNext({
      match: (ctx) => ctx.method === 'GET' && ctx.path.includes('/values/'),
      status: 500,
      message: 'Backend error',
      times: 1,
    });

    await useAppStore.getState().loadSetupFromSheet(1);
    expect(useAppStore.getState().hydration[1]).toBe('failed');

    // Retry — the transient failure has cleared.
    await useAppStore.getState().loadSetupFromSheet(1);

    const state = useAppStore.getState();
    expect(state.hydration[1]).toBe('hydrated');
    const level = state.customers[0].garages[0].levels[0];
    expect(level.devices).toHaveLength(1);
    expect(level.devices[0].x).toBe(120);
    expect(level.bgImage).toBe('data:image/png;base64,AAAABBBBCCCC');
    expect(state.customers[0].lastSetupSavedAt).toBe(LAYOUT.savedAt);
  });
});

describe('a customer whose sheet genuinely has no shared layout', () => {
  it('is treated as absent, not failed, so the first save is allowed', async () => {
    const ss = h.fake.createSpreadsheet({ title: 'New-config', tabs: ['Garages'] });
    useAppStore.setState({
      customers: [{ ...pointerCustomer(), id: 2, spreadsheetId: ss.id }],
      selectedCustomerId: 2,
      hydration: {},
    });

    await useAppStore.getState().loadSetupFromSheet(2);

    const state = useAppStore.getState();
    expect(state.hydration[2]).toBe('absent');
    expect(state.customers[0].garages).toEqual([]);
  });
});

describe('a browser upgrading from the previous build', () => {
  /** What the old localStorage held: garage/level stubs, devices stripped. */
  function legacyStubCustomer() {
    return {
      id: 1,
      customerId: 'acme',
      code: 'ACME',
      friendlyName: 'Acme',
      spreadsheetId,
      lastSetupSavedAt: null,
      garages: [{
        id: 1,
        name: 'North',
        internalName: 'North',
        levels: [{ id: 10, name: 'Level 1', bgImage: null, devices: [], zones: [] }],
        servers: [],
        displayGroups: [],
      }],
    };
  }

  it('does not auto-save the stale stubs before the sheet is read', async () => {
    vi.useFakeTimers();
    useAppStore.setState({
      customers: [legacyStubCustomer()],
      selectedCustomerId: 1,
      hydration: {},
      pendingRoute: null,
    });
    const before = writeCount();

    // The stubs are non-null, so nothing about the shape marks them unloaded.
    // The hydration state is what blocks the write.
    useAppStore.getState().updateCustomer(1, { friendlyName: 'Renamed' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(writeCount()).toBe(before);
  });

  it('replaces the stubs with the real layout on first load', async () => {
    useAppStore.setState({
      customers: [legacyStubCustomer()],
      selectedCustomerId: 1,
      hydration: {},
      pendingRoute: null,
    });

    await useAppStore.getState().loadSetupFromSheet(1);

    const level = useAppStore.getState().customers[0].garages[0].levels[0];
    expect(level.devices).toHaveLength(1);
    expect(level.bgImage).toBe('data:image/png;base64,AAAABBBBCCCC');
  });
});

describe('a SetupJson tab damaged by an older build', () => {
  /** A partial write: ChunkTotal says 3, only 2 chunks are present. */
  async function writeDamagedTab() {
    const { writeTabValues } = await import('../services/GoogleSheetsService');
    await writeTabValues(spreadsheetId, 'SetupJson', [
      ['ChunkIndex', 'ChunkTotal', 'Data'],
      [0, 3, 'SJ1:{"schemaVersion":1,'],
      [1, 3, 'SJ1:"app":"garage-layout-editor",'],
    ], { valueInputOption: 'RAW' });
  }

  it('is reported as damaged rather than as a transient failure', async () => {
    await writeDamagedTab();
    await useAppStore.getState().loadSetupFromSheet(1);

    const { setupSync, hydration } = useAppStore.getState();
    expect(hydration[1]).toBe('failed');
    expect(setupSync.recoverable).toBe(true);
    expect(setupSync.error).toMatch(/incomplete/i);
  });

  it('does not mark a network failure as damaged, so retry stays the answer', async () => {
    h.fake.failNext({
      match: (ctx) => ctx.method === 'GET' && ctx.path.includes('/values/'),
      status: 500,
      message: 'Backend error',
      times: 1,
    });
    await useAppStore.getState().loadSetupFromSheet(1);
    expect(useAppStore.getState().setupSync.recoverable).toBe(false);
  });

  it('recovers via a rebuild, replacing the damaged tab with a readable one', async () => {
    // The config tabs still describe the sites/levels/devices, which is what
    // makes a rebuild possible at all.
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Garage', 'VisibleGarageName', 'Stage'],
      ['North', 'North Deck', ''],
    ]), 'Garages');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Garage', 'Level', 'VisibleLevelName', 'MaximumOccupancy'],
      ['North', 'Level 1', 'Level 1', 120],
    ]), 'GarageLevels');
    h.configBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });

    await writeDamagedTab();
    await useAppStore.getState().loadSetupFromSheet(1);
    expect(useAppStore.getState().hydration[1]).toBe('failed');

    await useAppStore.getState().rebuildSetupFromConfigTabs(1);

    // Unstuck: editing is permitted again and the tab now parses.
    expect(useAppStore.getState().hydration[1]).not.toBe('failed');
    const { readSetupJsonFromSpreadsheet } = await import('../services/LayoutPersistenceService');
    const recovered = await readSetupJsonFromSpreadsheet({ spreadsheetId });
    expect(recovered.customer.garages[0].name).toBe('North Deck');
    expect(recovered.customer.garages[0].levels).toHaveLength(1);
  });
});
