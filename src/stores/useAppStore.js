import { create } from 'zustand';
import { normalizeCustomersTrafficFlow } from '../lib/trafficFlowUtils';
import {
  loadCustomerFull, saveCustomerFull, listCustomers, loadCustomerCard,
} from '../services/CustomerRepository';
import { customerHasConfigFile, customerCanSyncToSheet } from '../lib/customerConfigUtils';
import { compressOversizedBackgrounds } from '../lib/floorPlanBackground';
import { compressOversizedDevicePhotos } from '../lib/photoPick';

const toSlug = (str) => str?.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || '';

// The database is the only store of customer data — nothing about customers
// is persisted in this browser anymore. Signed out means the app shows
// nothing; signing in pulls the list fresh from the database.

// One-time cleanup of pre-migration persisted blobs so stale customers can
// never resurface from an old build's storage.
try {
  localStorage.removeItem('garageLayout_save');
  localStorage.removeItem('garageLayout_v2');
  localStorage.removeItem('garageLayout_saveEnabled');
} catch { /* ignore unavailable storage */ }

/**
 * `sites: null` means "not read from the sheet yet" and is different from
 * `[]`, which means "read, and this customer has no sites". Mutating a customer
 * in the null state would invent layout the sheet never had, so it is refused.
 */
function updateCustomerSites(customers, customerId, sitesOrFn) {
  return customers.map((c) => {
    if (c.id !== customerId) return c;
    if (c.sites == null && typeof sitesOrFn === 'function') {
      console.warn('[Garage Editor] Ignored a site edit before the sheet finished loading.');
      return c;
    }
    const current = c.sites ?? [];
    const next = typeof sitesOrFn === 'function' ? sitesOrFn(current) : sitesOrFn;
    return { ...c, sites: next };
  });
}

/** True when this customer's layout must come from a sheet we have not read yet. */
export function customerNeedsHydration(customer, hydration) {
  if (!customerCanSyncToSheet(customer)) return false;
  const state = hydration?.[customer.id];
  return state !== 'hydrated' && state !== 'absent';
}

/** Legacy URLs: /{site-slug}/{level-slug} (pre-customer tier) */
function findLegacySiteRoute(customers, parts) {
  const siteSlug = parts[0];
  const levelSlug = parts[1];
  for (const customer of customers) {
    const site = customer.sites?.find((s) => toSlug(s.name) === siteSlug);
    if (!site) continue;
    if (parts.length >= 2) {
      const level = site.levels?.find((l) => toSlug(l.name) === levelSlug);
      if (level) {
        return { customer, site, level, view: 'editor' };
      }
      return { customer, site, level: null, view: 'levels' };
    }
    return { customer, site, level: null, view: 'sites' };
  }
  return null;
}

function applyRouteSelection(set, get, { customer, site, level, view }, { replace = false } = {}) {
  set({
    selectedCustomerId: customer.id,
    selectedSiteId: site?.id ?? null,
    selectedLevelId: level?.id ?? null,
    currentView: view,
  });
  get().updateUrl(customer.id, site?.id ?? null, level?.id ?? null, { replace });
}

function resolveRouteFromParts(customers, parts) {
  const resetPatch = {
    selectedCustomerId: null,
    selectedSiteId: null,
    selectedLevelId: null,
    currentView: 'customers',
  };

  if (parts.length === 0) {
    return {
      type: 'patch',
      patch: {
        selectedCustomerId: null,
        selectedSiteId: null,
        selectedLevelId: null,
        currentView: 'customers',
      },
      rewriteUrl: null,
    };
  }

  const customer = customers.find((c) => c.customerId === parts[0]);
  if (customer) {
    // Layout has not been read from the sheet yet, so the site/level slugs
    // cannot be resolved. Remember them and finish the navigation once the
    // snapshot lands — never rewrite the URL to '/' in the meantime, which is
    // what used to make deep links die in a cold browser.
    if (customer.sites == null) {
      return {
        type: 'pending',
        patch: {
          selectedCustomerId: customer.id,
          selectedSiteId: null,
          selectedLevelId: null,
          currentView: 'sites',
        },
        pendingRoute: {
          customerId: customer.id,
          siteSlug: parts[1] ?? null,
          levelSlug: parts[2] ?? null,
        },
        rewriteUrl: null,
      };
    }

    const sites = customer.sites ?? [];
    const base = { selectedCustomerId: customer.id };

    if (parts.length >= 2) {
      const site = sites.find((s) => toSlug(s.name) === parts[1]);
      if (site) {
        const levels = site.levels ?? [];
        if (parts.length >= 3) {
          const level = levels.find((l) => toSlug(l.name) === parts[2]);
          if (level) {
            return {
              type: 'patch',
              patch: { ...base, selectedSiteId: site.id, selectedLevelId: level.id, currentView: 'editor' },
              rewriteUrl: null,
            };
          }
          return {
            type: 'patch',
            patch: { ...base, selectedSiteId: site.id, selectedLevelId: null, currentView: 'levels' },
            rewriteUrl: null,
          };
        }
        return {
          type: 'patch',
          patch: { ...base, selectedSiteId: site.id, selectedLevelId: null, currentView: 'levels' },
          rewriteUrl: null,
        };
      }
      return {
        type: 'patch',
        patch: { ...base, selectedSiteId: null, selectedLevelId: null, currentView: 'sites' },
        rewriteUrl: null,
      };
    }

    return {
      type: 'patch',
      patch: { ...base, selectedSiteId: null, selectedLevelId: null, currentView: 'sites' },
      rewriteUrl: null,
    };
  }

  const legacy = findLegacySiteRoute(customers, parts);
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
        '[Garage Editor] Rewrote legacy URL /{site}/{level} to /{customerId}/{site}/{level}.',
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

const SETUP_AUTOSAVE_DEBOUNCE_MS = 4000;

// Realtime doorbell re-fetches wait a beat before pulling: saveCustomerFull
// bumps the customers row (the event) *before* writing the child tables, so an
// immediate read could catch a half-written tree. Child upserts land well
// inside this window; repeated events for the same customer coalesce.
const REMOTE_REFETCH_DELAY_MS = 1500;
const remoteRefetchTimers = new Map();

// Guards so hydrating from (or recording a save to) the sheet doesn't retrigger auto-save.
let applyingSetupSnapshot = false;
let setupSaveTimer = null;
let setupSaveInFlight = false;
const pendingSetupSaveIds = new Set();
// Customers confirmed to have no database row to sync against — skip auto-save.
const setupSheetUnavailableIds = new Set();

function friendlySetupSyncError(err, action) {
  const message = err?.message || '';
  return message || `Failed to ${action} the customer's setup.`;
}

/**
 * Recompress any stored floor plans that are too large to sync, writing the
 * smaller versions back to the store so the shrink happens once.
 * @returns {Promise<object>} the customer record to serialize
 */
async function shrinkOversizedBackgrounds(customerId, customer) {
  let result;
  try {
    result = await compressOversizedBackgrounds(customer.sites);
  } catch {
    return customer; // Never block a save on background optimization.
  }
  if (!result.compressed) return customer;

  const { sites } = result;
  // Merge only the shrunk backgrounds into live state — edits made while the
  // recompression ran must survive.
  const shrunk = new Map();
  for (const site of sites) {
    for (const level of site?.levels ?? []) {
      if (level?.bgImage) shrunk.set(`${site.id}:${level.id}`, level.bgImage);
    }
  }

  applyingSetupSnapshot = true;
  try {
    useAppStore.setState({
      customers: useAppStore.getState().customers.map((c) => {
        if (c.id !== customerId) return c;
        return {
          ...c,
          sites: (c.sites ?? []).map((site) => ({
            ...site,
            levels: (site.levels ?? []).map((level) => {
              const bgImage = shrunk.get(`${site.id}:${level.id}`);
              return bgImage && bgImage !== level.bgImage ? { ...level, bgImage } : level;
            }),
          })),
        };
      }),
    });
  } finally {
    applyingSetupSnapshot = false;
  }
  return { ...customer, sites };
}

/**
 * Recompress oversized sign/camera photos before SetupJson write.
 * @returns {Promise<object>} the customer record to serialize
 */
async function shrinkOversizedDevicePhotos(customerId, customer) {
  let result;
  try {
    result = await compressOversizedDevicePhotos(customer.sites);
  } catch {
    return customer;
  }
  if (!result.compressed) return customer;

  const photosByDevice = new Map();
  for (const site of result.sites) {
    for (const level of site?.levels ?? []) {
      for (const device of level?.devices ?? []) {
        photosByDevice.set(`${site.id}:${level.id}:${device.id}`, {
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
          sites: (c.sites ?? []).map((site) => ({
            ...site,
            levels: (site.levels ?? []).map((level) => ({
              ...level,
              devices: (level.devices ?? []).map((device) => {
                const photos = photosByDevice.get(`${site.id}:${level.id}:${device.id}`);
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
    || { ...customer, sites: result.sites };
}

/** Floor plans + device photos — both embed in SetupJson and can wedge saves. */
async function shrinkOversizedSetupMedia(customerId, customer) {
  let current = await shrinkOversizedBackgrounds(customerId, customer);
  const live = useAppStore.getState().customers.find((c) => c.id === customerId);
  if (live) current = live;
  return shrinkOversizedDevicePhotos(customerId, current);
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
      await useAppStore.getState().saveCustomerSetup(id);
    }
  } finally {
    setupSaveInFlight = false;
    if (pendingSetupSaveIds.size) scheduleSetupAutoSave();
  }
}

export const useAppStore = create((set, get) => ({
  // Theme
  // Dark mode only — light mode was removed. Kept as a fixed value (rather
  // than deleting `mode` outright) so existing dark-mode checks elsewhere
  // (e.g. ConfigEditor's Monaco theme) don't need to change.
  mode: 'dark',

  // Customers data — in-memory only; Supabase is the single source of truth.
  customers: [],
  setCustomers: (customersOrFn) => {
    const current = get().customers;
    const next = typeof customersOrFn === 'function' ? customersOrFn(current) : customersOrFn;
    set({ customers: normalizeCustomersTrafficFlow(next) });
  },

  // App session (Google OAuth — see GoogleAuthService.js / App.jsx's subscription).
  session: null,
  setSession: (session) => set({ session }),

  /**
   * Refresh the customer list from Supabase (pointer-only — sites stay null
   * until loadCustomerSetup hydrates one). Merges rather than replaces so an
   * already-open, already-hydrated customer isn't reset back to a pointer.
   */
  loadCustomersFromSupabase: async () => {
    let rows;
    try {
      rows = await listCustomers();
    } catch (err) {
      console.warn('[Garage Editor] Could not load customers from Supabase:', err?.message);
      return;
    }
    set((state) => {
      const existingById = new Map(state.customers.map((c) => [c.id, c]));
      const merged = rows.map((row) => {
        const existing = existingById.get(row.id);
        if (existing) {
          return {
            ...existing,
            customerId: row.customerId,
            code: row.code,
            friendlyName: row.friendlyName,
            // Hydrated customers already carry config from their full-tree
            // load; only pointer-only entries take the list's copy so a
            // mid-edit tree is never partially overwritten.
            ...(existing.sites == null ? { config: row.config } : {}),
          };
        }
        return {
          id: row.id,
          customerId: row.customerId,
          code: row.code,
          friendlyName: row.friendlyName,
          config: row.config,
          sites: null,
          lastSetupSavedAt: row.updatedAt,
        };
      });
      const listedIds = new Set(rows.map((r) => r.id));
      const others = state.customers.filter((c) => !listedIds.has(c.id));
      return { customers: normalizeCustomersTrafficFlow([...merged, ...others]) };
    });
  },

  addCustomer: (customer) => {
    const { customers } = get();
    // Supabase customer ids are uuid strings — only auto-assign a numeric id
    // when the caller didn't supply one at all (a customer.id of 0/NaN/'' is
    // never valid, but a uuid string must be preserved, not coerced to NaN).
    let id = customer?.id;
    if (id == null) {
      const numericIds = customers.map((c) => Number(c.id)).filter((n) => Number.isFinite(n) && n > 0);
      id = numericIds.length ? Math.max(...numericIds) + 1 : 1;
    }
    const entry = { sites: [], ...customer, id };
    // A realtime customers-list refresh can beat this optimistic add back
    // (see loadCustomersFromSupabase), landing a second row with the same id
    // before this call's `set` even runs — replace in place rather than
    // appending so the two never coexist and collide on React key `local:id`
    // (driveConfigCatalog.js's buildCustomerListRows).
    const existingIndex = customers.findIndex((c) => c.id === id);
    const nextCustomers = existingIndex === -1
      ? [...customers, entry]
      : customers.map((c, i) => (i === existingIndex ? { ...c, ...entry } : c));
    set({ customers: nextCustomers });
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
          selectedSiteId: null,
          selectedLevelId: null,
          currentView: 'customers',
        }
        : {}),
    });
    if (isSelected && ['sites', 'levels', 'editor'].includes(currentView)) {
      window.history.replaceState({}, '', '/');
    }
  },

  /**
   * Sign-out: drop everything the session's RLS grant was letting us see.
   * Customers only exist in memory now, so this is what guarantees a signed-out
   * browser shows nothing.
   */
  clearAllCustomers: () => {
    for (const timer of remoteRefetchTimers.values()) clearTimeout(timer);
    remoteRefetchTimers.clear();
    set({ customers: [], hydration: {}, pendingRoute: null });
    get().resetNavigation();
  },

  /**
   * A customers row changed on the server (another tab or user). The payload
   * is only a doorbell — everything real is re-fetched, debounced per customer
   * so bursts of events collapse into one read.
   */
  handleRemoteCustomerEvent: (payload) => {
    const type = payload?.eventType;
    if (type === 'DELETE') {
      const id = payload.old?.id;
      if (id && get().customers.some((c) => c.id === id)) {
        get().removeCustomer(id);
      }
      return;
    }
    const row = payload?.new;
    if (!row?.id) return;
    if (type === 'INSERT' || !get().customers.some((c) => c.id === row.id)) {
      get().loadCustomersFromSupabase();
      return;
    }
    const customer = get().customers.find((c) => c.id === row.id);
    if (row.updated_at === customer.lastSetupSavedAt) return; // our own save echoing back
    if (remoteRefetchTimers.has(row.id)) clearTimeout(remoteRefetchTimers.get(row.id));
    remoteRefetchTimers.set(row.id, setTimeout(() => {
      remoteRefetchTimers.delete(row.id);
      get().applyRemoteCustomerUpdate(row);
    }, REMOTE_REFETCH_DELAY_MS));
  },

  /** Debounced tail of handleRemoteCustomerEvent — pull the fresh state. */
  applyRemoteCustomerUpdate: async (row) => {
    const customer = get().customers.find((c) => c.id === row.id);
    if (!customer) return;
    if (row.updated_at === customer.lastSetupSavedAt) return;
    // This tab has its own unsaved edits in flight for this customer — do not
    // clobber them; the save's updated_at guard will surface the conflict.
    if (pendingSetupSaveIds.has(row.id) || setupSaveInFlight) return;

    if (customer.sites == null) {
      // Pointer-only (never opened here): refresh what the list card shows —
      // identity plus address/support. The full tree still loads on open.
      try {
        const card = await loadCustomerCard(row.id);
        if (!card) return;
        set({
          customers: get().customers.map((c) => (c.id === row.id
            ? {
              ...c,
              friendlyName: card.friendlyName || c.friendlyName,
              code: card.code || c.code,
              config: card.config,
              lastSetupSavedAt: card.updatedAt,
            }
            : c)),
        });
      } catch {
        // Background refresh failed — stay stale until the next event or reload.
      }
      return;
    }

    try {
      const result = await loadCustomerFull(row.id);
      if (!result) return;
      applyingSetupSnapshot = true;
      try {
        set({
          customers: normalizeCustomersTrafficFlow(get().customers.map((c) => (c.id === row.id
            ? {
              ...c,
              friendlyName: result.customer.friendlyName || c.friendlyName,
              code: result.customer.code || c.code,
              config: result.customer.config,
              sites: result.customer.sites,
              displaySchedules: result.customer.displaySchedules,
              lastSetupSavedAt: result.updatedAt,
            }
            : c))),
        });
      } finally {
        applyingSetupSnapshot = false;
      }
      get().setHydration(row.id, 'hydrated');
    } catch {
      // Background refresh failed — stay stale until the next event or reload
      // rather than surfacing an error the user never asked for.
    }
  },

  resetNavigation: () => {
    set({
      selectedCustomerId: null,
      selectedSiteId: null,
      selectedLevelId: null,
      selectedDevice: null,
      currentView: 'customers',
      pendingRoute: null,
    });
    if (window.location.pathname !== '/') {
      window.history.replaceState({}, '', '/');
    }
  },

  setSites: (sitesOrFn) => {
    const { customers, selectedCustomerId } = get();
    if (!selectedCustomerId) return;
    set({
      customers: updateCustomerSites(customers, selectedCustomerId, sitesOrFn),
    });
  },

  // Navigation
  currentView: 'customers',
  setCurrentView: (view) => set({ currentView: view }),

  selectedCustomerId: null,
  setSelectedCustomerId: (id) => set({ selectedCustomerId: id }),

  selectedSiteId: null,
  setSelectedSiteId: (id) => set({ selectedSiteId: id }),

  selectedLevelId: null,
  setSelectedLevelId: (id) => {
    // Level ids are uuid strings — never coerce (parseInt would truncate a
    // uuid that happens to start with digits into a bogus number).
    set({ selectedLevelId: id });
    const { selectedCustomerId, selectedSiteId } = get();
    get().updateUrl(selectedCustomerId, selectedSiteId, id);
  },

  selectedDevice: null,
  setSelectedDevice: (device) => set({ selectedDevice: device }),

  // Customer setup persistence (customer tree stored in the database)
  setupSync: { status: 'idle', error: null, savedAt: null, customerId: null },

  /**
   * Per-customer hydration state: 'loading' | 'hydrated' | 'absent' | 'failed'.
   *
   * This is the gate that protects the database. Auto-save is allowed only from
   * 'hydrated' (we read the customer's data) or 'absent' (we read successfully
   * and there is none yet). Writing from 'loading' or 'failed' would push
   * whatever happens to be in memory — historically an empty stub — over good
   * data in the database.
   */
  hydration: {},

  /** Deep-link site/level slugs awaiting a hydrate before they can resolve. */
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
    if (!customer || customer.sites == null) return;

    set({ pendingRoute: null });
    const sites = customer.sites;
    const site = pendingRoute.siteSlug
      ? sites.find((s) => toSlug(s.name) === pendingRoute.siteSlug)
      : null;
    if (!site) {
      set({ selectedSiteId: null, selectedLevelId: null, currentView: 'sites' });
      get().updateUrl(customer.id, null, null, { replace: true });
      return;
    }
    const level = pendingRoute.levelSlug
      ? (site.levels ?? []).find((l) => toSlug(l.name) === pendingRoute.levelSlug)
      : null;
    set({
      selectedSiteId: site.id,
      selectedLevelId: level?.id ?? null,
      currentView: level ? 'editor' : 'levels',
    });
    get().updateUrl(customer.id, site.id, level?.id ?? null, { replace: true });
  },

  /**
   * Pull the customer's full tree from Supabase and hydrate the store with it.
   * No-op once the customer's row id is known but the fetch hasn't happened yet
   * for a brand-new (locally created) customer — callers create the row first.
   */
  loadCustomerSetup: async (customerId) => {
    const customer = get().customers.find((c) => c.id === customerId);
    if (!customer || !customerHasConfigFile(customer)) return;

    get().setHydration(customerId, 'loading');
    set({ setupSync: { status: 'loading', error: null, savedAt: customer.lastSetupSavedAt ?? null, customerId } });
    try {
      const result = await loadCustomerFull(customerId);
      if (!result) {
        // The row exists locally but Supabase has nothing for it — treat as an
        // empty starting layout rather than a failure.
        get().setHydration(customerId, 'absent');
        set((state) => ({
          customers: state.customers.map((c) => (
            c.id === customerId && c.sites == null ? { ...c, sites: [] } : c
          )),
          setupSync: { status: 'idle', error: null, savedAt: customer.lastSetupSavedAt ?? null, customerId },
        }));
        get().applyPendingRoute();
        return;
      }

      applyingSetupSnapshot = true;
      try {
        set({
          customers: normalizeCustomersTrafficFlow(get().customers.map((c) => (
            c.id === customerId
              ? {
                ...c,
                friendlyName: result.customer.friendlyName || c.friendlyName,
                code: result.customer.code || c.code,
                config: result.customer.config,
                sites: result.customer.sites,
                displaySchedules: result.customer.displaySchedules,
                lastSetupSavedAt: result.updatedAt,
              }
              : c
          ))),
        });
      } finally {
        applyingSetupSnapshot = false;
      }
      get().setHydration(customerId, 'hydrated');
      set({ setupSync: { status: 'loaded', error: null, savedAt: result.updatedAt, customerId } });
      get().applyPendingRoute();
    } catch (err) {
      // Leave `sites` as-is (null when never loaded). Do NOT fabricate an
      // empty layout — auto-save is gated on this state precisely so a failed
      // read can never be written back over Supabase.
      get().setHydration(customerId, 'failed');
      set({
        setupSync: {
          status: 'error',
          action: 'load',
          error: friendlySetupSyncError(err, 'load'),
          recoverable: false,
          savedAt: customer.lastSetupSavedAt ?? null,
          customerId,
        },
      });
    }
  },

  /**
   * Write the full customer tree to Supabase so other users opening the
   * customer see the same state.
   * @param {string} customerId
   * @param {{ force?: boolean }} [options] - force skips the remote conflict check
   */
  saveCustomerSetup: async (customerId, { force = false } = {}) => {
    const customer = get().customers.find((c) => c.id === customerId);
    if (!customer || !customerHasConfigFile(customer)) return;

    // Never write layout we did not read. This is the last line of defence for
    // the case that used to wipe customers: a failed load leaves memory empty,
    // one edit fires auto-save, and the empty state lands on Supabase.
    if (customerNeedsHydration(customer, get().hydration)) {
      set({
        setupSync: {
          status: 'error',
          action: 'load',
          error: 'The layout has not loaded yet — reload it before saving.',
          savedAt: customer.lastSetupSavedAt ?? null,
          customerId,
        },
      });
      return;
    }

    set({ setupSync: { status: 'saving', error: null, savedAt: customer.lastSetupSavedAt ?? null, customerId } });
    try {
      // Backgrounds / device photos carried over from a JSON import can still be
      // oversized inline data URLs; shrink them here so one big photo can't wedge
      // the save. Normal Storage-uploaded images are already small paths, so this
      // is a no-op in the common case.
      const customerToSave = await shrinkOversizedSetupMedia(customerId, customer);

      const expectedUpdatedAt = force ? null : customer.lastSetupSavedAt;
      const result = await saveCustomerFull(customerId, customerToSave, { expectedUpdatedAt });

      if (result.status === 'conflict') {
        set({
          setupSync: {
            status: 'conflict',
            action: 'conflict',
            error: 'Someone else saved a newer shared setup. Reload their version or overwrite with yours.',
            savedAt: customer.lastSetupSavedAt,
            remoteSavedAt: result.remoteUpdatedAt,
            customerId,
          },
        });
        return;
      }

      applyingSetupSnapshot = true;
      try {
        set({
          customers: get().customers.map((c) => (
            c.id === customerId ? { ...c, lastSetupSavedAt: result.updatedAt } : c
          )),
        });
      } finally {
        applyingSetupSnapshot = false;
      }
      set({ setupSync: { status: 'saved', error: null, savedAt: result.updatedAt, customerId } });
    } catch (err) {
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
      get().loadCustomerSetup(selectedCustomerId);
    } else if (setupSync.action === 'conflict') {
      get().saveCustomerSetup(selectedCustomerId, { force: true });
    } else {
      get().saveCustomerSetup(selectedCustomerId);
    }
  },

  resolveSetupConflictReload: () => {
    const { selectedCustomerId } = get();
    if (!selectedCustomerId) return;
    get().loadCustomerSetup(selectedCustomerId);
  },

  resolveSetupConflictOverwrite: () => {
    const { selectedCustomerId } = get();
    if (!selectedCustomerId) return;
    get().saveCustomerSetup(selectedCustomerId, { force: true });
  },

  // Actions
  selectCustomer: (customerId) => {
    const customer = get().customers.find((c) => c.id === customerId);
    if (!customer) return;
    set({
      selectedCustomerId: customer.id,
      selectedSiteId: null,
      selectedLevelId: null,
      currentView: 'sites',
      pendingRoute: null,
    });
    get().updateUrl(customer.id, null, null);
    get().loadCustomerSetup(customer.id);
  },

  selectSite: (siteId) => {
    set({ selectedSiteId: siteId, selectedLevelId: null, currentView: 'levels', pendingRoute: null });
    const { selectedCustomerId } = get();
    get().updateUrl(selectedCustomerId, siteId, null);
  },

  selectLevel: (levelId) => {
    set({ selectedLevelId: levelId, currentView: 'editor' });
    const { selectedCustomerId, selectedSiteId } = get();
    get().updateUrl(selectedCustomerId, selectedSiteId, levelId);
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
      selectedSiteId: null,
      selectedLevelId: null,
      selectedDevice: null,
      currentView: 'customers',
      pendingRoute: null,
    });
    window.history.pushState({}, '', '/');
  },

  setLevels: (newLevels) => {
    const { customers, selectedCustomerId, selectedSiteId } = get();
    if (!selectedCustomerId || !selectedSiteId) return;
    set({
      customers: customers.map((c) => {
        if (c.id !== selectedCustomerId) return c;
        return {
          ...c,
          sites: (c.sites ?? []).map((s) =>
            s.id === selectedSiteId ? { ...s, levels: newLevels } : s
          ),
        };
      }),
    });
  },

  // URL management: /{customer-id}/{site-slug}/{level-slug}
  updateUrl: (customerId, siteId, levelId, { replace = false } = {}) => {
    const write = replace ? 'replaceState' : 'pushState';
    const { customers } = get();
    const customer = customers.find((c) => c.id === customerId);
    if (!customer) {
      window.history[write]({}, '', '/');
      return;
    }
    const sites = customer.sites ?? [];
    const site = sites.find((s) => s.id === siteId);
    if (!site) {
      window.history[write]({}, '', `/${customer.customerId}`);
      return;
    }
    const levels = site.levels ?? [];
    const level = levels.find((l) => l.id === levelId);
    if (level) {
      window.history[write]({}, '', `/${customer.customerId}/${toSlug(site.name)}/${toSlug(level.name)}`);
    } else {
      window.history[write]({}, '', `/${customer.customerId}/${toSlug(site.name)}`);
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

// Load the customer's setup from the database when a customer is in the route
// (deep link / refresh / popstate). loadCustomerSetup skips hydrate when the
// remote savedAt matches local.
function maybeLoadSetupForRoute(get) {
  const { selectedCustomerId } = get();
  if (!selectedCustomerId) return;
  get().loadCustomerSetup(selectedCustomerId);
}

// Auto-save the selected customer's full setup to the database (debounced)
// whenever their data changes, so other users see the same state.
useAppStore.subscribe((state, prev) => {
  if (applyingSetupSnapshot) return;
  if (state.customers === prev.customers) return;
  const id = state.selectedCustomerId;
  if (!id || setupSheetUnavailableIds.has(id)) return;
  const customer = state.customers.find((c) => c.id === id);
  const prevCustomer = prev.customers.find((c) => c.id === id);
  if (!customer || customer === prevCustomer) return;
  if (!customerHasConfigFile(customer)) return;
  // The gate. Until the layout has actually been read from the database, there is
  // nothing safe to write — in-memory state is either empty or derived from a fallback.
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
const EMPTY_SITES = [];
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
  if (!customerNeedsHydration(customer, state.hydration)) return 'ready';
  return state.hydration[customer.id] === 'failed' ? 'failed' : 'loading';
});

export const useCustomerSites = () => useAppStore((state) => {
  const customer = state.customers.find((c) => c.id === state.selectedCustomerId);
  return customer?.sites ?? EMPTY_SITES;
});

export const useCurrentSite = () => useAppStore((state) => {
  const customer = state.customers.find((c) => c.id === state.selectedCustomerId);
  if (!customer?.sites) return null;
  return customer.sites.find((s) => s.id === state.selectedSiteId) ?? null;
});

export const useLevels = () => useAppStore((state) => {
  const customer = state.customers.find((c) => c.id === state.selectedCustomerId);
  const site = customer?.sites?.find((s) => s.id === state.selectedSiteId);
  return site?.levels ?? EMPTY_LEVELS;
});

export const useCurrentLevel = () => useAppStore((state) => {
  const customer = state.customers.find((c) => c.id === state.selectedCustomerId);
  const site = customer?.sites?.find((s) => s.id === state.selectedSiteId);
  if (!site?.levels) return null;
  return site.levels.find((l) => l.id === state.selectedLevelId) ?? null;
});
