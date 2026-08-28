/**
 * The regression that matters most: a failed read of the shared layout must
 * never be written back over Supabase.
 *
 * The old sequence was — localStorage held site/level stubs with empty
 * devices, the read failed, the error surfaced only as a small chip, the user
 * dragged one device, and an auto-save pushed the stub state over a complete
 * layout. Because the failure path also left `lastSetupSavedAt` null, the
 * conflict check was skipped and the overwrite was unconditional. The
 * hydration gate (customerNeedsHydration) is what closes that hole, and it's
 * persistence-agnostic — this test now drives it against a fake
 * CustomerRepository instead of a fake Google Sheets backend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const LAYOUT_CUSTOMER = {
  id: CUSTOMER_ID,
  customerId: 'acme',
  code: 'ACME',
  friendlyName: 'Acme',
  config: { address: '1 Main', city: 'Boston', state: 'MA', zip: '02101', mapsUrl: '', support: {} },
  sites: [{
    id: 'garage-1',
    name: 'North',
    internalName: 'North',
    levels: [{
      id: 'level-1',
      name: 'Level 1',
      bgImage: 'floor-plans/acme-id/garage-1/level-1/bg-1.webp',
      devices: [{ id: 'cam-1', type: 'cam-fli', name: '1.1F', x: 120, y: 240 }],
      zones: [{ id: 'z1', points: [{ x: 0, y: 0 }] }],
    }],
  }],
};

/** The customer as localStorage now stores it: pointers only, no layout. */
function pointerCustomer(id = CUSTOMER_ID) {
  return {
    id,
    customerId: 'acme',
    code: 'ACME',
    friendlyName: 'Acme',
    sites: null,
    lastSetupSavedAt: null,
  };
}

function saveCallCount() {
  return h.fake._saveCalls;
}

beforeEach(() => {
  h.fake = createFakeCustomerRepository();
  const originalSave = h.fake.saveCustomerFull.bind(h.fake);
  h.fake._saveCalls = 0;
  h.fake.saveCustomerFull = (...args) => {
    h.fake._saveCalls += 1;
    return originalSave(...args);
  };
  h.fake.seed(CUSTOMER_ID, LAYOUT_CUSTOMER);

  useAppStore.setState({
    customers: [pointerCustomer()],
    selectedCustomerId: CUSTOMER_ID,
    selectedSiteId: null,
    selectedLevelId: null,
    hydration: {},
    pendingRoute: null,
    currentView: 'sites',
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a failed shared-layout read', () => {
  beforeEach(() => {
    h.fake.loadCustomerFull = async () => { throw new Error('Backend error'); };
  });

  it('marks the customer failed and leaves sites unloaded', async () => {
    await useAppStore.getState().loadCustomerSetup(CUSTOMER_ID);

    const state = useAppStore.getState();
    expect(state.hydration[CUSTOMER_ID]).toBe('failed');
    expect(state.setupSync.status).toBe('error');
    // Crucially: no empty layout is fabricated to stand in for the real one.
    expect(state.customers[0].sites).toBe(null);
  });

  it('does not write anything when the user then edits', async () => {
    vi.useFakeTimers();
    await useAppStore.getState().loadCustomerSetup(CUSTOMER_ID);
    const before = saveCallCount();

    // The user edits. Under the old code this scheduled an auto-save that
    // replaced the entire shared layout with the empty local state.
    useAppStore.getState().updateCustomer(CUSTOMER_ID, { friendlyName: 'Acme Renamed' });
    useAppStore.getState().setSites((sites) => [...sites, { id: 'ghost', name: 'Ghost', levels: [] }]);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(saveCallCount()).toBe(before);
    expect(useAppStore.getState().customers[0].sites).toBe(null);
  });

  it('refuses an explicit save too, not just the debounced one', async () => {
    await useAppStore.getState().loadCustomerSetup(CUSTOMER_ID);
    const before = saveCallCount();

    await useAppStore.getState().saveCustomerSetup(CUSTOMER_ID);

    expect(saveCallCount()).toBe(before);
    expect(useAppStore.getState().setupSync.status).toBe('error');
  });
});

describe('recovering after the read succeeds', () => {
  it('hydrates the real layout and only then allows saving', async () => {
    // One failure on the first attempt, then it clears.
    let attempt = 0;
    const realLoad = h.fake.loadCustomerFull.bind(h.fake);
    h.fake.loadCustomerFull = async (...args) => {
      attempt += 1;
      if (attempt === 1) throw new Error('Backend error');
      return realLoad(...args);
    };

    await useAppStore.getState().loadCustomerSetup(CUSTOMER_ID);
    expect(useAppStore.getState().hydration[CUSTOMER_ID]).toBe('failed');

    // Retry — the transient failure has cleared.
    await useAppStore.getState().loadCustomerSetup(CUSTOMER_ID);

    const state = useAppStore.getState();
    expect(state.hydration[CUSTOMER_ID]).toBe('hydrated');
    const level = state.customers[0].sites[0].levels[0];
    expect(level.devices).toHaveLength(1);
    expect(level.devices[0].x).toBe(120);
    expect(level.bgImage).toBe(LAYOUT_CUSTOMER.sites[0].levels[0].bgImage);
    expect(state.customers[0].lastSetupSavedAt).toBeTruthy();
  });
});

describe('a customer whose Supabase row genuinely has no layout yet', () => {
  it('is treated as absent, not failed, so the first save is allowed', async () => {
    useAppStore.setState({
      customers: [pointerCustomer('brand-new-id')],
      selectedCustomerId: 'brand-new-id',
      hydration: {},
    });

    await useAppStore.getState().loadCustomerSetup('brand-new-id');

    const state = useAppStore.getState();
    expect(state.hydration['brand-new-id']).toBe('absent');
    expect(state.customers[0].sites).toEqual([]);
  });
});

describe('a browser upgrading from the previous build', () => {
  /** What old localStorage held: site/level stubs, devices stripped. */
  function legacyStubCustomer() {
    return {
      id: CUSTOMER_ID,
      customerId: 'acme',
      code: 'ACME',
      friendlyName: 'Acme',
      lastSetupSavedAt: null,
      sites: [{
        id: 'garage-1',
        name: 'North',
        internalName: 'North',
        levels: [{ id: 'level-1', name: 'Level 1', bgImage: null, devices: [], zones: [] }],
        servers: [],
        displayGroups: [],
      }],
    };
  }

  it('does not auto-save the stale stubs before the real layout is read', async () => {
    vi.useFakeTimers();
    useAppStore.setState({
      customers: [legacyStubCustomer()],
      selectedCustomerId: CUSTOMER_ID,
      hydration: {},
      pendingRoute: null,
    });
    const before = saveCallCount();

    // The stubs are non-null, so nothing about the shape marks them unloaded.
    // The hydration state is what blocks the write.
    useAppStore.getState().updateCustomer(CUSTOMER_ID, { friendlyName: 'Renamed' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(saveCallCount()).toBe(before);
  });

  it('replaces the stubs with the real layout on first load', async () => {
    useAppStore.setState({
      customers: [legacyStubCustomer()],
      selectedCustomerId: CUSTOMER_ID,
      hydration: {},
      pendingRoute: null,
    });

    await useAppStore.getState().loadCustomerSetup(CUSTOMER_ID);

    const level = useAppStore.getState().customers[0].sites[0].levels[0];
    expect(level.devices).toHaveLength(1);
    expect(level.bgImage).toBe(LAYOUT_CUSTOMER.sites[0].levels[0].bgImage);
  });
});
