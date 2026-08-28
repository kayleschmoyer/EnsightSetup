/**
 * The acceptance scenario, end to end:
 *
 *   A edits a customer, adds 20 floor-plan backgrounds across 20 levels, saves,
 *   closes. Later B opens the same customer on a different machine in a
 *   different state and sees every one of A's edits. B replaces backgrounds,
 *   adds cameras, edits signs. A reopens and sees B's changes.
 *
 * "A different machine in a different state" is modelled literally: B starts
 * with empty localStorage and nothing in memory, so everything B renders has
 * to come from Supabase — modelled here with a fake CustomerRepository backed
 * by an in-memory row (see fakeCustomerRepository.js). Floor-plan backgrounds
 * are now Storage object paths (short strings) rather than embedded base64, so
 * this no longer needs to push ~500KB of fake base64 per level to exercise a
 * realistic save.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeCustomerRepository } from '../services/__fixtures__/fakeCustomerRepository';
import { installBrowserEnv } from '../services/__fixtures__/browserEnv';

const h = vi.hoisted(() => ({ fake: null }));

vi.mock('../services/CustomerRepository', () => ({
  loadCustomerFull: (...args) => h.fake.loadCustomerFull(...args),
  saveCustomerFull: (...args) => h.fake.saveCustomerFull(...args),
  subscribeToCustomerChanges: (...args) => h.fake.subscribeToCustomerChanges(...args),
}));

installBrowserEnv();

const { useAppStore } = await import('./useAppStore');

const CUSTOMER_ID = 'acme-id';
const LEVEL_COUNT = 20;
const BG = (marker) => `floor-plans/${CUSTOMER_ID}/garage-1/level-${marker}/bg.webp`;

/** Exactly what localStorage holds for a Supabase-backed customer: pointers. */
function pointerCustomer() {
  return {
    id: CUSTOMER_ID,
    customerId: 'acme',
    code: 'ACME',
    friendlyName: 'Acme',
    sites: null,
    lastSetupSavedAt: null,
  };
}

/** Reset the store to a cold browser that has only ever seen the pointer. */
function coldBrowser() {
  useAppStore.setState({
    customers: [pointerCustomer()],
    selectedCustomerId: CUSTOMER_ID,
    selectedSiteId: null,
    selectedLevelId: null,
    hydration: {},
    pendingRoute: null,
    setupSync: { status: 'idle', error: null, savedAt: null, customerId: null },
    currentView: 'sites',
  });
}

function currentSite() {
  return useAppStore.getState().customers[0].sites[0];
}

beforeEach(() => {
  h.fake = createFakeCustomerRepository();
  // Nothing seeded — this customer has no Supabase row content yet, matching
  // the old "no SetupJson tab" starting state.
});

describe('two people, two machines, one Supabase row', () => {
  it('round-trips a full editing session in both directions', async () => {
    // ---- A: builds the site with 20 levels, each with a background ---------
    coldBrowser();
    await useAppStore.getState().loadCustomerSetup(CUSTOMER_ID);
    expect(useAppStore.getState().hydration[CUSTOMER_ID]).toBe('absent');

    useAppStore.getState().setSites(() => [{
      id: 'garage-1',
      name: 'North',
      internalName: 'North',
      levels: Array.from({ length: LEVEL_COUNT }, (_, i) => ({
        id: `level-${i + 1}`,
        name: `Level ${i + 1}`,
        bgImage: BG('A'),
        devices: [{ id: `cam-a-${i}`, type: 'cam-fli', name: `${i + 1}.1F`, x: i * 10, y: 20 }],
        zones: [],
      })),
    }]);

    await useAppStore.getState().saveCustomerSetup(CUSTOMER_ID);
    expect(useAppStore.getState().setupSync.status).toBe('saved');
    const aSavedAt = useAppStore.getState().customers[0].lastSetupSavedAt;
    expect(aSavedAt).toBeTruthy();

    // ---- B: different machine, empty localStorage, nothing in memory ------
    coldBrowser();
    expect(useAppStore.getState().customers[0].sites).toBe(null);

    await useAppStore.getState().loadCustomerSetup(CUSTOMER_ID);
    expect(useAppStore.getState().hydration[CUSTOMER_ID]).toBe('hydrated');

    // B sees every one of A's edits.
    const asBSees = currentSite();
    expect(asBSees.name).toBe('North');
    expect(asBSees.levels).toHaveLength(LEVEL_COUNT);
    expect(asBSees.levels.every((l) => l.bgImage === BG('A'))).toBe(true);
    expect(asBSees.levels[19].devices[0].name).toBe('20.1F');
    expect(asBSees.levels[7].devices[0].x).toBe(70);

    // ---- B: replaces backgrounds, adds a camera, edits a sign ------------
    useAppStore.getState().setSites((sites) => sites.map((s) => ({
      ...s,
      levels: s.levels.map((level, i) => ({
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

    await useAppStore.getState().saveCustomerSetup(CUSTOMER_ID);
    expect(useAppStore.getState().setupSync.status).toBe('saved');
    const bSavedAt = useAppStore.getState().customers[0].lastSetupSavedAt;
    expect(bSavedAt).not.toBe(aSavedAt);

    // ---- A: reopens later, cold, and sees B's changes ---------------------
    coldBrowser();
    await useAppStore.getState().loadCustomerSetup(CUSTOMER_ID);

    const asASeesNow = currentSite();
    expect(asASeesNow.levels).toHaveLength(LEVEL_COUNT);
    expect(asASeesNow.levels.every((l) => l.bgImage === BG('B'))).toBe(true);
    const level1 = asASeesNow.levels[0];
    expect(level1.devices.map((d) => d.name)).toEqual(['1.1F', '1.2L', 'S1.1']);
    expect(level1.devices[1].type).toBe('cam-lpr');
    expect(level1.devices[2].visibleName).toBe('North Entry');
    expect(useAppStore.getState().customers[0].lastSetupSavedAt).toBe(bSavedAt);
  });

  it('flags a conflict instead of silently overwriting a newer save', async () => {
    // A loads and saves.
    coldBrowser();
    await useAppStore.getState().loadCustomerSetup(CUSTOMER_ID);
    useAppStore.getState().setSites(() => [{ id: 'garage-1', name: 'North', levels: [] }]);
    await useAppStore.getState().saveCustomerSetup(CUSTOMER_ID);
    const aState = useAppStore.getState().customers[0];

    // B loads the same thing and saves something different.
    coldBrowser();
    await useAppStore.getState().loadCustomerSetup(CUSTOMER_ID);
    useAppStore.getState().setSites(() => [{ id: 'garage-1', name: 'North (B)', levels: [] }]);
    await useAppStore.getState().saveCustomerSetup(CUSTOMER_ID);
    expect(useAppStore.getState().setupSync.status).toBe('saved');

    // A — still holding the older timestamp — tries to save on top.
    useAppStore.setState({
      customers: [{ ...aState, sites: [{ id: 'garage-1', name: 'North (A)', levels: [] }] }],
      hydration: { [CUSTOMER_ID]: 'hydrated' },
    });
    await useAppStore.getState().saveCustomerSetup(CUSTOMER_ID);

    expect(useAppStore.getState().setupSync.status).toBe('conflict');

    // B's save survives untouched.
    coldBrowser();
    await useAppStore.getState().loadCustomerSetup(CUSTOMER_ID);
    expect(currentSite().name).toBe('North (B)');
  });

  it('overwriting after a conflict (force) replaces the remote save', async () => {
    coldBrowser();
    await useAppStore.getState().loadCustomerSetup(CUSTOMER_ID);
    useAppStore.getState().setSites(() => [{ id: 'garage-1', name: 'North', levels: [] }]);
    await useAppStore.getState().saveCustomerSetup(CUSTOMER_ID);
    const aState = useAppStore.getState().customers[0];

    coldBrowser();
    await useAppStore.getState().loadCustomerSetup(CUSTOMER_ID);
    useAppStore.getState().setSites(() => [{ id: 'garage-1', name: 'North (B)', levels: [] }]);
    await useAppStore.getState().saveCustomerSetup(CUSTOMER_ID);

    useAppStore.setState({
      customers: [{ ...aState, sites: [{ id: 'garage-1', name: 'North (A, forced)', levels: [] }] }],
      hydration: { [CUSTOMER_ID]: 'hydrated' },
      selectedCustomerId: CUSTOMER_ID,
    });
    await useAppStore.getState().saveCustomerSetup(CUSTOMER_ID, { force: true });

    expect(useAppStore.getState().setupSync.status).toBe('saved');

    coldBrowser();
    await useAppStore.getState().loadCustomerSetup(CUSTOMER_ID);
    expect(currentSite().name).toBe('North (A, forced)');
  });
});
