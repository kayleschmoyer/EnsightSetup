/**
 * The acceptance scenario, end to end:
 *
 *   A edits a customer, adds 20 floor-plan backgrounds across 20 levels, saves,
 *   closes. Later B opens the same customer on a different machine in a
 *   different state and sees every one of A's edits. B replaces backgrounds,
 *   adds cameras, edits signs. A reopens and sees B's changes.
 *
 * "A different machine in a different state" is modelled literally: B starts
 * with empty localStorage and nothing in memory, so everything B renders has to
 * come from the sheet.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSheets } from '../services/__fixtures__/fakeSheets';
import { installBrowserEnv } from '../services/__fixtures__/browserEnv';

const h = vi.hoisted(() => ({ fake: null }));

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
  downloadConfigFile: async () => new ArrayBuffer(0),
  renameDriveFile: async () => ({}),
  SPREADSHEET_MIME: 'application/vnd.google-apps.spreadsheet',
}));

installBrowserEnv();

const { useAppStore } = await import('./useAppStore');

const LEVEL_COUNT = 20;
const BG = (marker) => `data:image/png;base64,${marker.repeat(500_000)}`;

let spreadsheetId;

/** Exactly what localStorage holds for a sheet-backed customer: pointers. */
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

/** Reset the store to a cold browser that has only ever seen the pointer. */
function coldBrowser() {
  useAppStore.setState({
    customers: [pointerCustomer()],
    selectedCustomerId: 1,
    selectedGarageId: null,
    selectedLevelId: null,
    hydration: {},
    pendingRoute: null,
    setupSync: { status: 'idle', error: null, savedAt: null, customerId: null },
    currentView: 'garages',
  });
}

function currentGarage() {
  return useAppStore.getState().customers[0].garages[0];
}

beforeEach(() => {
  h.fake = createFakeSheets();
  spreadsheetId = h.fake.createSpreadsheet({ title: 'Acme-config', tabs: ['Garages'] }).id;
});

describe('two people, two machines, one sheet', () => {
  it('round-trips a full editing session in both directions', async () => {
    // ---- A: builds the site with 20 levels, each with a background ---------
    coldBrowser();
    await useAppStore.getState().loadSetupFromSheet(1);
    expect(useAppStore.getState().hydration[1]).toBe('absent');

    useAppStore.getState().setGarages(() => [{
      id: 1,
      name: 'North',
      internalName: 'North',
      levels: Array.from({ length: LEVEL_COUNT }, (_, i) => ({
        id: i + 1,
        name: `Level ${i + 1}`,
        bgImage: BG('A'),
        devices: [{ id: `cam-a-${i}`, type: 'cam-fli', name: `${i + 1}.1F`, x: i * 10, y: 20 }],
        zones: [],
      })),
    }]);

    await useAppStore.getState().saveCustomerSetupToSheet(1);
    expect(useAppStore.getState().setupSync.status).toBe('saved');
    const aSavedAt = useAppStore.getState().customers[0].lastSetupSavedAt;
    expect(aSavedAt).toBeTruthy();

    // ---- B: different machine, empty localStorage, nothing in memory ------
    coldBrowser();
    expect(useAppStore.getState().customers[0].garages).toBe(null);

    await useAppStore.getState().loadSetupFromSheet(1);
    expect(useAppStore.getState().hydration[1]).toBe('hydrated');

    // B sees every one of A's edits.
    const asBSees = currentGarage();
    expect(asBSees.name).toBe('North');
    expect(asBSees.levels).toHaveLength(LEVEL_COUNT);
    expect(asBSees.levels.every((l) => l.bgImage === BG('A'))).toBe(true);
    expect(asBSees.levels[19].devices[0].name).toBe('20.1F');
    expect(asBSees.levels[7].devices[0].x).toBe(70);

    // ---- B: replaces backgrounds, adds a camera, edits a sign ------------
    useAppStore.getState().setGarages((garages) => garages.map((g) => ({
      ...g,
      levels: g.levels.map((level, i) => ({
        ...level,
        bgImage: BG('B'),
        devices: [
          ...level.devices,
          ...(i === 0
            ? [
              { id: 'cam-b-new', type: 'cam-lpr', name: '1.2L', x: 400, y: 88 },
              { id: 'sign-b-1', type: 'sign-static', name: 'S1.1', visibleName: 'North Entry' },
            ]
            : []),
        ],
      })),
    })));

    await useAppStore.getState().saveCustomerSetupToSheet(1);
    expect(useAppStore.getState().setupSync.status).toBe('saved');
    const bSavedAt = useAppStore.getState().customers[0].lastSetupSavedAt;
    expect(bSavedAt).not.toBe(aSavedAt);

    // ---- A: reopens later, cold, and sees B's changes ---------------------
    coldBrowser();
    await useAppStore.getState().loadSetupFromSheet(1);

    const asASeesNow = currentGarage();
    expect(asASeesNow.levels).toHaveLength(LEVEL_COUNT);
    expect(asASeesNow.levels.every((l) => l.bgImage === BG('B'))).toBe(true);
    const level1 = asASeesNow.levels[0];
    expect(level1.devices.map((d) => d.name)).toEqual(['1.1F', '1.2L', 'S1.1']);
    expect(level1.devices[1].type).toBe('cam-lpr');
    expect(level1.devices[2].visibleName).toBe('North Entry');
    expect(useAppStore.getState().customers[0].lastSetupSavedAt).toBe(bSavedAt);
  }, 30_000);

  it('flags a conflict instead of silently overwriting a newer save', async () => {
    // A loads and saves.
    coldBrowser();
    await useAppStore.getState().loadSetupFromSheet(1);
    useAppStore.getState().setGarages(() => [{ id: 1, name: 'North', levels: [] }]);
    await useAppStore.getState().saveCustomerSetupToSheet(1);
    const aState = useAppStore.getState().customers[0];

    // B loads the same thing and saves something different.
    coldBrowser();
    await useAppStore.getState().loadSetupFromSheet(1);
    useAppStore.getState().setGarages(() => [{ id: 1, name: 'North (B)', levels: [] }]);
    await useAppStore.getState().saveCustomerSetupToSheet(1);
    expect(useAppStore.getState().setupSync.status).toBe('saved');

    // A — still holding the older timestamp — tries to save on top.
    useAppStore.setState({
      customers: [{ ...aState, garages: [{ id: 1, name: 'North (A)', levels: [] }] }],
      hydration: { 1: 'hydrated' },
    });
    await useAppStore.getState().saveCustomerSetupToSheet(1);

    expect(useAppStore.getState().setupSync.status).toBe('conflict');

    // B's save survives untouched.
    coldBrowser();
    await useAppStore.getState().loadSetupFromSheet(1);
    expect(currentGarage().name).toBe('North (B)');
  }, 20_000);

  it('skips the write entirely when nothing actually changed', async () => {
    coldBrowser();
    await useAppStore.getState().loadSetupFromSheet(1);
    useAppStore.getState().setGarages(() => [{
      id: 1,
      name: 'North',
      levels: [{ id: 1, name: 'Level 1', bgImage: BG('A'), devices: [], zones: [] }],
    }]);
    await useAppStore.getState().saveCustomerSetupToSheet(1);

    // Save again with identical content — rewriting ~500k of base64 for a new
    // timestamp is pure cost, and every write is a chance to fail.
    h.fake.requests.length = 0;
    await useAppStore.getState().saveCustomerSetupToSheet(1);

    expect(useAppStore.getState().setupSync.status).toBe('saved');
    expect(h.fake.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
  }, 20_000);
});
