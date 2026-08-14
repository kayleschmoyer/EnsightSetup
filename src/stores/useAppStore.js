import { create } from 'zustand';
import { normalizeCustomersTrafficFlow } from '../lib/trafficFlowUtils';
import {
  isSetupContentError,
  loadCustomerSetupFromSheet,
  readSetupJsonRevision,
  serializeCustomerLayout,
  setupContentHash,
  writeSetupJsonToSpreadsheet,
} from '../services/LayoutPersistenceService';
import { downloadConfigFile } from '../services/GoogleDriveService';
import { parseExcelFile } from '../services/ExcelParserService';
import {
  loadDisplaySchedulesFromTab,
  loadServersFromNetworkingTab,
  syncAllConfigTabsForCustomer,
} from '../services/ConfigSheetSyncService';
import { applyServersToGarages, mergeGaragesPreferNetworkingServers } from '../lib/configSheetSchema';
import { customerHasConfigFile, customerCanSyncToSheet } from '../lib/customerConfigUtils';
import { customersForLocalPersistence } from '../lib/localPersistence';
import { compressOversizedBackgrounds } from '../lib/floorPlanBackground';
import { compressOversizedDevicePhotos } from '../lib/photoPick';

const toSlug = (str) => str?.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || '';

const LS_KEY_V1 = 'garageLayout_save';
const LS_KEY = 'garageLayout_v2';
const LS_ENABLED_KEY = 'garageLayout_saveEnabled';

function parseStoredState(raw) {
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  if (Array.isArray(data.customers)) {
    return { customers: normalizeCustomersTrafficFlow(data.customers), mode: data.mode };
  }

  if (Array.isArray(data.garages)) {
    return {
      customers: normalizeCustomersTrafficFlow([{
        id: 1,
        customerId: 'imported',
        code: 'IMPORTED',
        friendlyName: 'Imported Sites',
        address: '',
        city: '',
        state: '',
        zip: '',
        mapsUrl: '',
        garages: data.garages,
      }]),
      mode: data.mode,
    };
  }

  return null;
}

function loadLocalState() {
  try {
    const rawV2 = localStorage.getItem(LS_KEY);
    if (rawV2) {
      const parsed = parseStoredState(rawV2);
      if (parsed) return parsed;
    }

    const rawV1 = localStorage.getItem(LS_KEY_V1);
    if (rawV1) {
      const migrated = parseStoredState(rawV1);
      if (migrated) {
        localStorage.setItem(LS_KEY, JSON.stringify({
          customers: migrated.customers,
          mode: migrated.mode,
        }));
        return migrated;
      }
    }
  } catch { /* ignore corrupt storage */ }
  return null;
}

function saveLocalState(state) {
  try {
    // Sheet-synced customers keep only opened-customer stubs locally; SetupJson owns layout.
    localStorage.setItem(LS_KEY, JSON.stringify({
      customers: customersForLocalPersistence(state.customers),
      mode: state.mode,
    }));
    return true;
  } catch {
    return false;
  }
}

/**
 * `garages: null` means "not read from the sheet yet" and is different from
 * `[]`, which means "read, and this customer has no sites". Mutating a customer
 * in the null state would invent layout the sheet never had, so it is refused.
 */
function updateCustomerGarages(customers, customerId, garagesOrFn) {
  return customers.map((c) => {
    if (c.id !== customerId) return c;
    if (c.garages == null && typeof garagesOrFn === 'function') {
      console.warn('[Garage Editor] Ignored a garage edit before the sheet finished loading.');
      return c;
    }
    const current = c.garages ?? [];
    const next = typeof garagesOrFn === 'function' ? garagesOrFn(current) : garagesOrFn;
    return { ...c, garages: next };
  });
}

/** True when this customer's layout must come from a sheet we have not read yet. */
export function customerNeedsHydration(customer, hydration) {
  if (!customerCanSyncToSheet(customer)) return false;
  const state = hydration?.[customer.id];
  return state !== 'hydrated' && state !== 'absent';
}

/** Legacy URLs: /{garage-slug}/{level-slug} (pre-customer tier) */
function findLegacyGarageRoute(customers, parts) {
  const garageSlug = parts[0];
  const levelSlug = parts[1];
  for (const customer of customers) {
    const garage = customer.garages?.find((g) => toSlug(g.name) === garageSlug);
    if (!garage) continue;
    if (parts.length >= 2) {
      const level = garage.levels?.find((l) => toSlug(l.name) === levelSlug);
      if (level) {
        return { customer, garage, level, view: 'editor' };
      }
      return { customer, garage, level: null, view: 'levels' };
    }
    return { customer, garage, level: null, view: 'garages' };
  }
  return null;
}

function applyRouteSelection(set, get, { customer, garage, level, view }, { replace = false } = {}) {
  set({
    selectedCustomerId: customer.id,
    selectedGarageId: garage?.id ?? null,
    selectedLevelId: level?.id ?? null,
    currentView: view,
  });
  get().updateUrl(customer.id, garage?.id ?? null, level?.id ?? null, { replace });
}

function resolveRouteFromParts(customers, parts) {
  const resetPatch = {
    selectedCustomerId: null,
    selectedGarageId: null,
    selectedLevelId: null,
    currentView: 'customers',
  };

  if (parts.length === 0) {
    return {
      type: 'patch',
      patch: {
        selectedCustomerId: null,
        selectedGarageId: null,
        selectedLevelId: null,
        currentView: 'customers',
      },
      rewriteUrl: null,
    };
  }

  const customer = customers.find((c) => c.customerId === parts[0]);
  if (customer) {
    // Layout has not been read from the sheet yet, so the garage/level slugs
    // cannot be resolved. Remember them and finish the navigation once the
    // snapshot lands — never rewrite the URL to '/' in the meantime, which is
    // what used to make deep links die in a cold browser.
    if (customer.garages == null) {
      return {
        type: 'pending',
        patch: {
          selectedCustomerId: customer.id,
          selectedGarageId: null,
          selectedLevelId: null,
          currentView: 'garages',
        },
        pendingRoute: {
          customerId: customer.id,
          garageSlug: parts[1] ?? null,
          levelSlug: parts[2] ?? null,
        },
        rewriteUrl: null,
      };
    }

    const garages = customer.garages ?? [];
    const base = { selectedCustomerId: customer.id };

    if (parts.length >= 2) {
      const garage = garages.find((g) => toSlug(g.name) === parts[1]);
      if (garage) {
        const levels = garage.levels ?? [];
        if (parts.length >= 3) {
          const level = levels.find((l) => toSlug(l.name) === parts[2]);
          if (level) {
            return {
              type: 'patch',
              patch: { ...base, selectedGarageId: garage.id, selectedLevelId: level.id, currentView: 'editor' },
              rewriteUrl: null,
            };
          }
          return {
            type: 'patch',
            patch: { ...base, selectedGarageId: garage.id, selectedLevelId: null, currentView: 'levels' },
            rewriteUrl: null,
          };
        }
        return {
          type: 'patch',
          patch: { ...base, selectedGarageId: garage.id, selectedLevelId: null, currentView: 'levels' },
          rewriteUrl: null,
        };
      }
      return {
        type: 'patch',
        patch: { ...base, selectedGarageId: null, selectedLevelId: null, currentView: 'garages' },
        rewriteUrl: null,
      };
    }

    return {
      type: 'patch',
      patch: { ...base, selectedGarageId: null, selectedLevelId: null, currentView: 'garages' },
      rewriteUrl: null,
    };
  }

  const legacy = findLegacyGarageRoute(customers, parts);
  if (legacy) {
    return { type: 'legacy', legacy };
  }

  return { type: 'reset', patch: resetPatch, rewriteUrl: '/' };
}

let loggedLegacyUrlRewrite = false;

function applyResolvedRoute(set, get, resolved) {
  if (resolved.type === 'pending') {
    set({ ...resolved.patch, pendingRoute: resolved.pendingRoute });
    return;
  }
  if (resolved.type === 'legacy') {
    if (!loggedLegacyUrlRewrite) {
      loggedLegacyUrlRewrite = true;
      console.info(
        '[Garage Editor] Rewrote legacy URL /{garage}/{level} to /{customerId}/{garage}/{level}.',
      );
    }
    applyRouteSelection(set, get, resolved.legacy, { replace: true });
    return;
  }
  if (resolved.type === 'reset') {
    set(resolved.patch);
    if (resolved.rewriteUrl && window.location.pathname !== resolved.rewriteUrl) {
      window.history.replaceState({}, '', resolved.rewriteUrl);
    }
    return;
  }
  const { currentView } = get();
  const nextView = resolved.patch.currentView ?? currentView;
  if (currentView !== nextView || Object.keys(resolved.patch).some((k) => get()[k] !== resolved.patch[k])) {
    set(resolved.patch);
  }
}

// Default ON: opened Drive customers must survive refresh so the catalog can
// show them as opened and deep links can resolve. Users may still opt out in Settings.
// Missing key → enabled (legacy default was off and cleared "opened" on every reload).
const _localEnabled = localStorage.getItem(LS_ENABLED_KEY) !== 'false';
// Always restore any saved customers when present — even if the user later turns
// the preference off (turning off stops new writes; it does not wipe existing data).
const _localState = loadLocalState();

// Reclaim quota from older builds that stored full SetupJson layouts (incl. floor plans)
// for sheet-synced customers. In-memory state still has whatever was loaded; we only
// rewrite the persisted blob to slim stubs.
if (_localEnabled && _localState?.customers?.length) {
  saveLocalState({ customers: _localState.customers, mode: _localState.mode });
}

const SETUP_AUTOSAVE_DEBOUNCE_MS = 4000;

// Guards so hydrating from (or recording a save to) the sheet doesn't retrigger auto-save.
let applyingSetupSnapshot = false;
let setupSaveTimer = null;
let setupSaveInFlight = false;
const pendingSetupSaveIds = new Set();
// Customers confirmed to have no writable Google Sheet (xlsx-only) — skip auto-save.
const setupSheetUnavailableIds = new Set();

function friendlySetupSyncError(err, action) {
  const message = err?.message || '';
  if (/sign in|signed in|session expired/i.test(message)) {
    return `Sign in with Google to ${action} the shared setup.`;
  }
  return message || `Failed to ${action} the shared setup.`;
}

/**
 * Recompress any stored floor plans that are too large to sync, writing the
 * smaller versions back to the store so the shrink happens once.
 * @returns {Promise<object>} the customer record to serialize
 */
async function shrinkOversizedBackgrounds(customerId, customer) {
  let result;
  try {
    result = await compressOversizedBackgrounds(customer.garages);
  } catch {
    return customer; // Never block a save on background optimization.
  }
  if (!result.compressed) return customer;

  const { garages } = result;
  // Merge only the shrunk backgrounds into live state — edits made while the
  // recompression ran must survive.
  const shrunk = new Map();
  for (const garage of garages) {
    for (const level of garage?.levels ?? []) {
      if (level?.bgImage) shrunk.set(`${garage.id}:${level.id}`, level.bgImage);
    }
  }

  applyingSetupSnapshot = true;
  try {
    useAppStore.setState({
      customers: useAppStore.getState().customers.map((c) => {
        if (c.id !== customerId) return c;
        return {
          ...c,
          garages: (c.garages ?? []).map((garage) => ({
            ...garage,
            levels: (garage.levels ?? []).map((level) => {
              const bgImage = shrunk.get(`${garage.id}:${level.id}`);
              return bgImage && bgImage !== level.bgImage ? { ...level, bgImage } : level;
            }),
          })),
        };
      }),
    });
  } finally {
    applyingSetupSnapshot = false;
  }
  return { ...customer, garages };
}

/**
 * Recompress oversized sign/camera photos before SetupJson write.
 * @returns {Promise<object>} the customer record to serialize
 */
async function shrinkOversizedDevicePhotos(customerId, customer) {
  let result;
  try {
    result = await compressOversizedDevicePhotos(customer.garages);
  } catch {
    return customer;
  }
  if (!result.compressed) return customer;

  const photosByDevice = new Map();
  for (const garage of result.garages) {
    for (const level of garage?.levels ?? []) {
      for (const device of level?.devices ?? []) {
        photosByDevice.set(`${garage.id}:${level.id}:${device.id}`, {
          viewImage: device.viewImage,
          signImages: device.signImages,
        });
      }
    }
  }

  applyingSetupSnapshot = true;
  try {
    useAppStore.setState({
      customers: useAppStore.getState().customers.map((c) => {
        if (c.id !== customerId) return c;
        return {
          ...c,
          garages: (c.garages ?? []).map((garage) => ({
            ...garage,
            levels: (garage.levels ?? []).map((level) => ({
              ...level,
              devices: (level.devices ?? []).map((device) => {
                const photos = photosByDevice.get(`${garage.id}:${level.id}:${device.id}`);
                if (!photos) return device;
                let changed = false;
                const next = { ...device };
                if (photos.viewImage != null && photos.viewImage !== device.viewImage) {
                  next.viewImage = photos.viewImage;
                  changed = true;
                }
                if (
                  Array.isArray(photos.signImages)
                  && photos.signImages !== device.signImages
                  && JSON.stringify(photos.signImages) !== JSON.stringify(device.signImages || [])
                ) {
                  next.signImages = photos.signImages;
                  changed = true;
                }
                return changed ? next : device;
              }),
            })),
          })),
        };
      }),
    });
  } finally {
    applyingSetupSnapshot = false;
  }

  return useAppStore.getState().customers.find((c) => c.id === customerId)
    || { ...customer, garages: result.garages };
}

/** Floor plans + device photos — both embed in SetupJson and can wedge saves. */
async function shrinkOversizedSetupMedia(customerId, customer) {
  let current = await shrinkOversizedBackgrounds(customerId, customer);
  const live = useAppStore.getState().customers.find((c) => c.id === customerId);
  if (live) current = live;
  return shrinkOversizedDevicePhotos(customerId, current);
}

/**
 * Bring the config tabs back in line with the app's state.
 *
 * This is what makes the sheet self-correcting. A device the tabs never
 * received gets added, and a value mangled by an older build is rewritten —
 * without anyone having to find that exact row. Only tabs whose content
 * actually differs are written, and rows the app does not own are left alone.
 *
 * Never fails the save: the shared layout is the record, and a config tab that
 * could not be refreshed is a warning, not a lost edit.
 */
async function refreshConfigTabs(customer) {
  try {
    return await syncAllConfigTabsForCustomer({
      customer,
      garages: customer.garages || [],
      servers: customer.garages?.[0]?.servers || [],
    });
  } catch (err) {
    console.warn('[Garage Editor] Config tabs were not fully refreshed:', err?.message);
    return { changedTabs: [] };
  }
}

function scheduleSetupAutoSave() {
  if (setupSaveTimer) clearTimeout(setupSaveTimer);
  setupSaveTimer = setTimeout(runSetupAutoSave, SETUP_AUTOSAVE_DEBOUNCE_MS);
}

async function runSetupAutoSave() {
  setupSaveTimer = null;
  if (setupSaveInFlight) {
    scheduleSetupAutoSave();
    return;
  }
  setupSaveInFlight = true;
  try {
    const ids = [...pendingSetupSaveIds];
    pendingSetupSaveIds.clear();
    for (const id of ids) {
      await useAppStore.getState().saveCustomerSetupToSheet(id);
    }
  } finally {
    setupSaveInFlight = false;
    if (pendingSetupSaveIds.size) scheduleSetupAutoSave();
  }
}

export const useAppStore = create((set, get) => ({
  // Local save (browser-only until API sync is available)
  localSaveEnabled: _localEnabled,
  localSaveError: null,
  setLocalSaveEnabled: (enabled) => {
    localStorage.setItem(LS_ENABLED_KEY, String(enabled));
    if (enabled) {
      const saved = saveLocalState(get());
      set({
        localSaveEnabled: true,
        localSaveError: saved ? null : 'Local save failed — browser storage may be full.',
      });
      return;
    }
    // Opting out stops further writes; keep in-memory + already-stored customers.
    set({ localSaveEnabled: false, localSaveError: null });
  },
  clearLocalSaveError: () => set({ localSaveError: null }),

  // Theme
  mode: _localState?.mode ?? 'dark',
  setMode: (mode) => {
    document.documentElement.classList.toggle('dark', mode === 'dark');
    document.documentElement.classList.toggle('light', mode === 'light');
    set({ mode });
  },
  toggleMode: () => {
    const newMode = get().mode === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', newMode === 'dark');
    document.documentElement.classList.toggle('light', newMode === 'light');
    set({ mode: newMode });
  },

  // Customers data
  customers: _localState?.customers ?? [],
  setCustomers: (customersOrFn) => {
    const current = get().customers;
    const next = typeof customersOrFn === 'function' ? customersOrFn(current) : customersOrFn;
    set({ customers: normalizeCustomersTrafficFlow(next) });
  },

  addCustomer: (customer) => {
    const { customers } = get();
    const numericIds = customers.map((c) => Number(c.id)).filter((n) => Number.isFinite(n) && n > 0);
    const newId = numericIds.length ? Math.max(...numericIds) + 1 : 1;
    const requestedId = Number(customer?.id);
    const id = Number.isFinite(requestedId) && requestedId > 0 ? requestedId : newId;
    // Keep id last so a null/undefined id from the payload cannot wipe the assigned id
    // (falsy selectedCustomerId would immediately reset navigation back to customers).
    const entry = { garages: [], ...customer, id };
    set({ customers: [...customers, entry] });
    return entry;
  },

  updateCustomer: (customerId, updates) => {
    set({
      customers: get().customers.map((c) =>
        c.id === customerId ? { ...c, ...updates } : c
      ),
    });
  },

  removeCustomer: (customerId) => {
    const { selectedCustomerId, currentView } = get();
    const isSelected = selectedCustomerId === customerId;
    set({
      customers: get().customers.filter((c) => c.id !== customerId),
      ...(isSelected
        ? {
          selectedCustomerId: null,
          selectedGarageId: null,
          selectedLevelId: null,
          currentView: 'customers',
        }
        : {}),
    });
    if (isSelected && ['garages', 'levels', 'editor'].includes(currentView)) {
      window.history.replaceState({}, '', '/');
    }
  },

  resetNavigation: () => {
    set({
      selectedCustomerId: null,
      selectedGarageId: null,
      selectedLevelId: null,
      selectedDevice: null,
      currentView: 'customers',
      pendingRoute: null,
    });
    if (window.location.pathname !== '/') {
      window.history.replaceState({}, '', '/');
    }
  },

  setGarages: (garagesOrFn) => {
    const { customers, selectedCustomerId } = get();
    if (!selectedCustomerId) return;
    set({
      customers: updateCustomerGarages(customers, selectedCustomerId, garagesOrFn),
    });
  },

  // Navigation
  currentView: 'customers',
  setCurrentView: (view) => set({ currentView: view }),

  selectedCustomerId: null,
  setSelectedCustomerId: (id) => set({ selectedCustomerId: id }),

  selectedGarageId: null,
  setSelectedGarageId: (id) => set({ selectedGarageId: id }),

  selectedLevelId: null,
  setSelectedLevelId: (id) => {
    const numericId = typeof id === 'string' ? parseInt(id, 10) : id;
    set({ selectedLevelId: numericId });
    const { selectedCustomerId, selectedGarageId } = get();
    get().updateUrl(selectedCustomerId, selectedGarageId, numericId);
  },

  selectedDevice: null,
  setSelectedDevice: (device) => set({ selectedDevice: device }),

  // Shared setup persistence (SetupJson tab on the customer's Google Sheet)
  setupSync: { status: 'idle', error: null, savedAt: null, customerId: null },

  /**
   * Per-customer hydration state: 'loading' | 'hydrated' | 'absent' | 'failed'.
   *
   * This is the gate that protects the sheet. Auto-save is allowed only from
   * 'hydrated' (we read the shared layout) or 'absent' (we read successfully
   * and there is none yet). Writing from 'loading' or 'failed' would push
   * whatever happens to be in memory — historically an empty stub — over good
   * data on the sheet.
   */
  hydration: {},

  /** Deep-link garage/level slugs awaiting a hydrate before they can resolve. */
  pendingRoute: null,

  setHydration: (customerId, status) => set((state) => ({
    hydration: { ...state.hydration, [customerId]: status },
  })),

  /**
   * Finish a deep link once layout is available. Normalizes the URL to what
   * actually resolved so a stale slug cannot linger in the address bar.
   */
  applyPendingRoute: () => {
    const { pendingRoute, customers } = get();
    if (!pendingRoute) return;
    const customer = customers.find((c) => c.id === pendingRoute.customerId);
    if (!customer || customer.garages == null) return;

    set({ pendingRoute: null });
    const garages = customer.garages;
    const garage = pendingRoute.garageSlug
      ? garages.find((g) => toSlug(g.name) === pendingRoute.garageSlug)
      : null;
    if (!garage) {
      set({ selectedGarageId: null, selectedLevelId: null, currentView: 'garages' });
      get().updateUrl(customer.id, null, null, { replace: true });
      return;
    }
    const level = pendingRoute.levelSlug
      ? (garage.levels ?? []).find((l) => toSlug(l.name) === pendingRoute.levelSlug)
      : null;
    set({
      selectedGarageId: garage.id,
      selectedLevelId: level?.id ?? null,
      currentView: level ? 'editor' : 'levels',
    });
    get().updateUrl(customer.id, garage.id, level?.id ?? null, { replace: true });
  },

  /**
   * Pull the SetupJson snapshot for a customer and hydrate the store with it.
   * No-op when the customer has no linked config file or the tab is empty.
   */
  loadSetupFromSheet: async (customerId) => {
    const customer = get().customers.find((c) => c.id === customerId);
    if (!customer || !customerHasConfigFile(customer)) return;

    get().setHydration(customerId, 'loading');
    set({ setupSync: { status: 'loading', error: null, savedAt: customer.lastSetupSavedAt ?? null, customerId } });
    try {
      const snapshot = await loadCustomerSetupFromSheet(customer);
      if (!snapshot) {
        // The read succeeded and there is no shared layout yet. That is a
        // legitimate starting state, so editing (and the first save) is allowed
        // — but only because we know the sheet is empty, not because we failed.
        get().setHydration(customerId, 'absent');
        set((state) => ({
          customers: state.customers.map((c) => (
            c.id === customerId && c.garages == null ? { ...c, garages: [] } : c
          )),
          setupSync: { status: 'idle', error: null, savedAt: customer.lastSetupSavedAt ?? null, customerId },
        }));
        get().applyPendingRoute();
        return;
      }

      applyingSetupSnapshot = true;
      try {
        let nextGarages = snapshot.customer.garages;
        try {
          const networkingServers = await loadServersFromNetworkingTab(customer);
          if (networkingServers.length) {
            nextGarages = applyServersToGarages(nextGarages, networkingServers);
          } else {
            // Keep Servers tab data already loaded from Networking when SetupJson is empty.
            nextGarages = mergeGaragesPreferNetworkingServers(nextGarages, customer.garages || []);
          }
        } catch {
          nextGarages = mergeGaragesPreferNetworkingServers(nextGarages, customer.garages || []);
        }

        // The DisplaySchedules tab is authoritative. Nothing in the app edits
        // schedules — they are only carried through SetupJson — so the copy in
        // a snapshot goes stale the moment anyone edits the tab, and the app
        // would then show schedules the sheet no longer has.
        let nextSchedules = Array.isArray(snapshot.customer.displaySchedules)
          ? snapshot.customer.displaySchedules
          : null;
        try {
          const fromTab = await loadDisplaySchedulesFromTab(customer);
          if (fromTab) nextSchedules = fromTab;
        } catch {
          // Fall back to the snapshot copy rather than dropping schedules.
        }

        set({
          customers: normalizeCustomersTrafficFlow(get().customers.map((c) => (
            c.id === customerId
              ? {
                ...c,
                friendlyName: snapshot.customer.friendlyName || c.friendlyName,
                config: snapshot.customer.config,
                garages: nextGarages,
                ...(nextSchedules ? { displaySchedules: nextSchedules } : {}),
                lastSetupSavedAt: snapshot.savedAt,
              }
              : c
          ))),
        });
      } finally {
        applyingSetupSnapshot = false;
      }
      get().setHydration(customerId, 'hydrated');
      set({ setupSync: { status: 'loaded', error: null, savedAt: snapshot.savedAt, customerId } });
      get().applyPendingRoute();
    } catch (err) {
      // Leave `garages` as-is (null when never loaded). Do NOT fabricate an
      // empty layout — auto-save is gated on this state precisely so a failed
      // read can never be written back over the sheet.
      get().setHydration(customerId, 'failed');
      set({
        setupSync: {
          status: 'error',
          action: 'load',
          error: friendlySetupSyncError(err, 'load'),
          // Content that cannot be parsed will never parse. Retrying forever
          // would leave this customer stuck, since editing is blocked until the
          // layout loads — offer a rebuild instead.
          recoverable: isSetupContentError(err?.message),
          savedAt: customer.lastSetupSavedAt ?? null,
          customerId,
        },
      });
    }
  },

  /**
   * Rebuild an unreadable shared layout from the customer's config tabs.
   *
   * Only for a SetupJson tab whose content is damaged — typically written by a
   * build that could leave a partial payload behind. The config tabs still hold
   * sites, levels and devices, so the layout is recoverable; what is lost is
   * editor-only detail the tabs never carried (floor-plan images, device
   * positions, zones). That is stated plainly in the UI before it runs.
   */
  rebuildSetupFromConfigTabs: async (customerId) => {
    const customer = get().customers.find((c) => c.id === customerId);
    if (!customer || !customerHasConfigFile(customer)) return;

    set({ setupSync: { status: 'loading', error: null, savedAt: null, customerId } });
    try {
      const fileId = customer.sourceFileId || customer.spreadsheetId;
      const buffer = await downloadConfigFile(fileId);
      const parsed = parseExcelFile(buffer);

      applyingSetupSnapshot = true;
      try {
        set({
          customers: normalizeCustomersTrafficFlow(get().customers.map((c) => (
            c.id === customerId
              ? { ...c, garages: parsed.garages || [], lastSetupSavedAt: null }
              : c
          ))),
        });
      } finally {
        applyingSetupSnapshot = false;
      }

      // 'absent' rather than 'hydrated': there is no valid shared layout, and
      // saying so is what permits the save that replaces the damaged one.
      get().setHydration(customerId, 'absent');
      await get().saveCustomerSetupToSheet(customerId, { force: true });
    } catch (err) {
      get().setHydration(customerId, 'failed');
      set({
        setupSync: {
          status: 'error',
          action: 'load',
          error: friendlySetupSyncError(err, 'rebuild'),
          recoverable: false,
          savedAt: null,
          customerId,
        },
      });
    }
  },

  /**
   * Write the full customer snapshot to the SetupJson tab so other users
   * opening the customer see the same state.
   * @param {number|string} customerId
   * @param {{ force?: boolean }} [options] - force skips remote conflict check
   */
  saveCustomerSetupToSheet: async (customerId, { force = false } = {}) => {
    const customer = get().customers.find((c) => c.id === customerId);
    if (!customer || !customerHasConfigFile(customer)) return;
    if (setupSheetUnavailableIds.has(customerId)) return;

    // Never write layout we did not read. This is the last line of defence for
    // the case that used to wipe customers: a failed load leaves memory empty,
    // one edit fires auto-save, and the empty state lands on the sheet.
    if (customerNeedsHydration(customer, get().hydration)) {
      set({
        setupSync: {
          status: 'error',
          action: 'load',
          error: 'The shared layout has not loaded yet — reload it before saving.',
          savedAt: customer.lastSetupSavedAt ?? null,
          customerId,
        },
      });
      return;
    }

    set({ setupSync: { status: 'saving', error: null, savedAt: customer.lastSetupSavedAt ?? null, customerId } });
    try {
      // Backgrounds / device photos from older builds (or oversized re-imports)
      // can be several MB each; shrink them here so one big photo can't wedge
      // every later save for the customer.
      const customerToSave = await shrinkOversizedSetupMedia(customerId, customer);

      const payload = serializeCustomerLayout(customerToSave);
      const contentHash = setupContentHash(payload);

      // Two cells, not the whole snapshot. The old check reloaded the entire
      // SetupJson before every save, so a customer with twenty floor plans
      // pulled ~10 MB down and pushed ~10 MB up every four seconds of editing.
      const remote = await readSetupJsonRevision(customerToSave);

      if (remote.hash && remote.hash === contentHash) {
        // The layout is identical, so the snapshot does not need rewriting —
        // but the config tabs can still be behind it (they are what drifts).
        // Refresh them anyway: it costs one batched read when nothing differs.
        await refreshConfigTabs(customerToSave);

        // Adopt the remote timestamp so a later save is compared against what
        // is really there.
        const savedAt = remote.savedAt ?? customer.lastSetupSavedAt ?? null;
        applyingSetupSnapshot = true;
        try {
          set({
            customers: get().customers.map((c) => (
              c.id === customerId ? { ...c, lastSetupSavedAt: savedAt } : c
            )),
          });
        } finally {
          applyingSetupSnapshot = false;
        }
        set({ setupSync: { status: 'saved', error: null, savedAt, customerId } });
        return;
      }

      // Checked on every save, not just when a local timestamp happens to
      // exist. The old `&& customer.lastSetupSavedAt` gate meant the very paths
      // that lost the timestamp (failed load, tab fallback) also skipped the
      // conflict check and overwrote unconditionally.
      if (
        !force
        && remote.savedAt
        && remote.savedAt !== customer.lastSetupSavedAt
        && (!customer.lastSetupSavedAt
          || new Date(remote.savedAt) > new Date(customer.lastSetupSavedAt))
      ) {
        set({
          setupSync: {
            status: 'conflict',
            action: 'conflict',
            error: 'Someone else saved a newer shared setup. Reload their version or overwrite with yours.',
            savedAt: customer.lastSetupSavedAt,
            remoteSavedAt: remote.savedAt,
            customerId,
          },
        });
        return;
      }

      await writeSetupJsonToSpreadsheet(customerToSave, payload);

      await refreshConfigTabs(customerToSave);

      applyingSetupSnapshot = true;
      try {
        set({
          customers: get().customers.map((c) => (
            c.id === customerId ? { ...c, lastSetupSavedAt: payload.savedAt } : c
          )),
        });
      } finally {
        applyingSetupSnapshot = false;
      }
      set({ setupSync: { status: 'saved', error: null, savedAt: payload.savedAt, customerId } });
    } catch (err) {
      if (/no google sheet found/i.test(err?.message || '')) {
        // Excel-only Drive link — sheet writes aren't possible; don't keep retrying.
        setupSheetUnavailableIds.add(customerId);
        set({ setupSync: { status: 'unavailable', error: null, savedAt: customer.lastSetupSavedAt ?? null, customerId } });
        return;
      }
      set({
        setupSync: {
          status: 'error',
          action: 'save',
          error: friendlySetupSyncError(err, 'save'),
          savedAt: customer.lastSetupSavedAt ?? null,
          customerId,
        },
      });
    }
  },

  /** Retry the failed shared-setup operation (used by the error indicator). */
  retrySetupSync: () => {
    const { selectedCustomerId, setupSync } = get();
    if (!selectedCustomerId) return;
    if (setupSync.action === 'load') {
      get().loadSetupFromSheet(selectedCustomerId);
    } else if (setupSync.action === 'conflict') {
      get().saveCustomerSetupToSheet(selectedCustomerId, { force: true });
    } else {
      get().saveCustomerSetupToSheet(selectedCustomerId);
    }
  },

  resolveSetupConflictReload: () => {
    const { selectedCustomerId } = get();
    if (!selectedCustomerId) return;
    get().loadSetupFromSheet(selectedCustomerId);
  },

  resolveSetupConflictOverwrite: () => {
    const { selectedCustomerId } = get();
    if (!selectedCustomerId) return;
    get().saveCustomerSetupToSheet(selectedCustomerId, { force: true });
  },

  // Actions
  selectCustomer: (customerId) => {
    const customer = get().customers.find((c) => c.id === customerId);
    if (!customer) return;
    set({
      selectedCustomerId: customer.id,
      selectedGarageId: null,
      selectedLevelId: null,
      currentView: 'garages',
      pendingRoute: null,
    });
    get().updateUrl(customer.id, null, null);
    get().loadSetupFromSheet(customer.id);
  },

  selectGarage: (garageId) => {
    set({ selectedGarageId: garageId, selectedLevelId: null, currentView: 'levels', pendingRoute: null });
    const { selectedCustomerId } = get();
    get().updateUrl(selectedCustomerId, garageId, null);
  },

  selectLevel: (levelId) => {
    set({ selectedLevelId: levelId, currentView: 'editor' });
    const { selectedCustomerId, selectedGarageId } = get();
    get().updateUrl(selectedCustomerId, selectedGarageId, levelId);
  },

  /**
   * Browser Back. Navigation views are restored by popstate → handlePopState.
   * Used by mouse Back; in-app ← buttons were removed in favor of the browser.
   */
  goBack: () => {
    if (get().currentView === 'customers') return;
    window.history.back();
  },

  /** Jump to the main Customers screen from any nested view. */
  goHome: () => {
    const { currentView } = get();
    if (currentView === 'customers') return;
    set({
      selectedCustomerId: null,
      selectedGarageId: null,
      selectedLevelId: null,
      selectedDevice: null,
      currentView: 'customers',
      pendingRoute: null,
    });
    window.history.pushState({}, '', '/');
  },

  setLevels: (newLevels) => {
    const { customers, selectedCustomerId, selectedGarageId } = get();
    if (!selectedCustomerId || !selectedGarageId) return;
    set({
      customers: customers.map((c) => {
        if (c.id !== selectedCustomerId) return c;
        return {
          ...c,
          garages: (c.garages ?? []).map((g) =>
            g.id === selectedGarageId ? { ...g, levels: newLevels } : g
          ),
        };
      }),
    });
  },

  // URL management: /{customer-id}/{garage-slug}/{level-slug}
  updateUrl: (customerId, garageId, levelId, { replace = false } = {}) => {
    const write = replace ? 'replaceState' : 'pushState';
    const { customers } = get();
    const customer = customers.find((c) => c.id === customerId);
    if (!customer) {
      window.history[write]({}, '', '/');
      return;
    }
    const garages = customer.garages ?? [];
    const garage = garages.find((g) => g.id === garageId);
    if (!garage) {
      window.history[write]({}, '', `/${customer.customerId}`);
      return;
    }
    const levels = garage.levels ?? [];
    const level = levels.find((l) => l.id === levelId);
    if (level) {
      window.history[write]({}, '', `/${customer.customerId}/${toSlug(garage.name)}/${toSlug(level.name)}`);
    } else {
      window.history[write]({}, '', `/${customer.customerId}/${toSlug(garage.name)}`);
    }
  },

  parseUrlAndRestore: () => {
    const { customers } = get();
    const parts = window.location.pathname.split('/').filter(Boolean);
    const resolved = resolveRouteFromParts(customers, parts);
    applyResolvedRoute(set, get, resolved);
    maybeLoadSetupForRoute(get);
  },

  handlePopState: () => {
    const { customers } = get();
    const parts = window.location.pathname.split('/').filter(Boolean);
    const resolved = resolveRouteFromParts(customers, parts);
    applyResolvedRoute(set, get, resolved);
    maybeLoadSetupForRoute(get);
  },
}));

// Load shared SetupJson when a customer is in the route (deep link / refresh / popstate).
// loadSetupFromSheet skips hydrate when remote savedAt matches local.
function maybeLoadSetupForRoute(get) {
  const { selectedCustomerId } = get();
  if (!selectedCustomerId) return;
  get().loadSetupFromSheet(selectedCustomerId);
}

// Auto-save to localStorage whenever customers or mode change (if enabled).
// Remembers opened customers only — sheet layout still lives in SetupJson.
useAppStore.subscribe((state, prev) => {
  if (!state.localSaveEnabled) return;
  if (state.customers !== prev.customers || state.mode !== prev.mode) {
    const saved = saveLocalState(state);
    if (saved) {
      if (state.localSaveError) {
        useAppStore.setState({ localSaveError: null });
      }
      return;
    }
    if (!state.localSaveError) {
      useAppStore.setState({
        localSaveError: 'Local save failed — browser storage may be full.',
      });
    }
  }
});

// Auto-save the selected customer's full setup to the SetupJson sheet tab
// (debounced) whenever their data changes, so other users see the same state.
useAppStore.subscribe((state, prev) => {
  if (applyingSetupSnapshot) return;
  if (state.customers === prev.customers) return;
  const id = state.selectedCustomerId;
  if (!id || setupSheetUnavailableIds.has(id)) return;
  const customer = state.customers.find((c) => c.id === id);
  const prevCustomer = prev.customers.find((c) => c.id === id);
  if (!customer || customer === prevCustomer) return;
  if (!customerHasConfigFile(customer)) return;
  // The gate. Until the shared layout has actually been read, there is nothing
  // safe to write — in-memory state is either empty or derived from a fallback.
  if (customerNeedsHydration(customer, state.hydration)) return;
  pendingSetupSaveIds.add(id);
  scheduleSetupAutoSave();
});

// Warn before closing the tab while a shared-setup save is pending or running.
window.addEventListener('beforeunload', (e) => {
  if (setupSaveTimer || setupSaveInFlight || pendingSetupSaveIds.size) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// Stable fallbacks — selectors must not return new [] on every snapshot
const EMPTY_GARAGES = [];
const EMPTY_LEVELS = [];

// Selectors
export const useCurrentCustomer = () => useAppStore((state) =>
  state.customers.find((c) => c.id === state.selectedCustomerId) ?? null
);

/**
 * Layout status for the selected customer, so views can wait for the sheet
 * instead of rendering an empty layout that looks like real (missing) data.
 * @returns {'ready'|'loading'|'failed'}
 */
export const useCustomerDataStatus = () => useAppStore((state) => {
  const customer = state.customers.find((c) => c.id === state.selectedCustomerId);
  if (!customer) return 'ready';
  // Linked to an .xlsx but no Google Sheet: every write silently goes nowhere,
  // so the app would show devices the linked file has never contained. A local
  // customer with no linked file at all is left alone — there is no second
  // copy for it to disagree with.
  if (customerHasConfigFile(customer) && !customerCanSyncToSheet(customer)) return 'nosheet';
  if (!customerNeedsHydration(customer, state.hydration)) return 'ready';
  return state.hydration[customer.id] === 'failed' ? 'failed' : 'loading';
});

export const useCustomerGarages = () => useAppStore((state) => {
  const customer = state.customers.find((c) => c.id === state.selectedCustomerId);
  return customer?.garages ?? EMPTY_GARAGES;
});

/** Alias for components that previously used store.garages */
export const useGarages = useCustomerGarages;

export const useCurrentGarage = () => useAppStore((state) => {
  const customer = state.customers.find((c) => c.id === state.selectedCustomerId);
  if (!customer?.garages) return null;
  return customer.garages.find((g) => g.id === state.selectedGarageId) ?? null;
});

export const useLevels = () => useAppStore((state) => {
  const customer = state.customers.find((c) => c.id === state.selectedCustomerId);
  const garage = customer?.garages?.find((g) => g.id === state.selectedGarageId);
  return garage?.levels ?? EMPTY_LEVELS;
});

export const useCurrentLevel = () => useAppStore((state) => {
  const customer = state.customers.find((c) => c.id === state.selectedCustomerId);
  const garage = customer?.garages?.find((g) => g.id === state.selectedGarageId);
  if (!garage?.levels) return null;
  return garage.levels.find((l) => l.id === state.selectedLevelId) ?? null;
});
