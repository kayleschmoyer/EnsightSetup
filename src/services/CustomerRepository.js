/**
 * CustomerRepository — replaces LayoutPersistenceService's role as the app's
 * source of truth. Reads/writes the customer -> sites -> levels -> devices
 * tree via the api/customers/* Vercel functions (MySQL/RDS-backed — see
 * sql/schema.sql and api/_customers-data.js), reassembled into the same
 * in-memory shape useAppStore.js already expects
 * (`customer.sites[].levels[].devices[]`), so only the persistence boundary
 * changes, not the store's selectors/derived state. The server does the row
 * <-> legacy-shape mapping (reusing src/lib/customerRowMapping.js) and returns
 * already-legacy-shaped JSON, so this module has no snake_case anywhere.
 *
 * Optimistic concurrency: saveCustomerFull compares the customer row's
 * `updated_at` against the value the caller loaded (`expectedUpdatedAt`) inside
 * the same write, enforced server-side via a row lock (see saveCustomerFull in
 * api/_customers-data.js). A mismatch means someone else saved since the
 * caller last loaded.
 *
 * Live updates: Supabase Realtime's websocket subscription has no MySQL
 * equivalent, so subscribeToCustomersTable/subscribeToCustomerChanges are now
 * polling (interval + refetch-on-window-focus) — both were always
 * non-authoritative "go re-fetch" doorbells (the real conflict guard is
 * saveCustomerFull's updated_at check), so polling is a faithful, much
 * simpler replacement, not a behavior downgrade.
 */
import { guardedWrite } from './WriteGuard';

const FULL_TREE_TABLES = [
  'customers', 'customer_addresses', 'customer_support', 'sites', 'levels', 'zones', 'devices',
  'servers', 'display_groups', 'sensor_groups', 'mdf_idf_locations', 'display_schedules',
  'camera_details', 'sign_details', 'sensor_details', 'camera_streams', 'camera_traffic_destinations',
  'sign_display_levels', 'sign_inserts', 'sign_insert_levels', 'sensor_units', 'device_photos',
];

const POLL_INTERVAL_MS = 30_000;

/** Row counts per entity type, used to summarize a bulk tree save without a full field-level diff. */
function summarizeTree(customer) {
  const sites = customer?.sites || [];
  let levels = 0;
  let zones = 0;
  let devices = 0;
  let servers = 0;
  for (const site of sites) {
    servers += (site.servers || []).length;
    for (const level of site.levels || []) {
      if (level.isZone) zones += 1; else levels += 1;
      devices += (level.devices || []).length;
    }
  }
  return { sites: sites.length, levels, zones, devices, servers };
}

async function apiGet(path, { treatNotFoundAsNull = false } = {}) {
  const res = await fetch(path);
  if (treatNotFoundAsNull && res.status === 404) return null;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `GET ${path} failed (${res.status}).`);
  return body;
}

async function apiSend(method, path, payload) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `${method} ${path} failed (${res.status}).`);
  return body;
}

/**
 * Load one customer's full tree, reassembled into the legacy
 * `customer.sites[].levels[].devices[]` shape.
 * @param {string} customerRowId - customers.id (uuid)
 * @returns {Promise<{ customer: object, updatedAt: string } | null>}
 */
export async function loadCustomerFull(customerRowId) {
  return apiGet(`/api/customers/${encodeURIComponent(customerRowId)}`, { treatNotFoundAsNull: true });
}

/**
 * Create a new customer row (and its initial site/level tree, if provided).
 * @param {{ customerId: string, code: string, friendlyName: string, config?: object, sites?: object[] }} customer
 * @returns {Promise<{ customer: object, updatedAt: string }>}
 */
export async function createCustomer({
  customerId, code, friendlyName, config = {}, sites = [],
}) {
  return guardedWrite(
    () => ({
      title: `Create customer "${friendlyName}" (${code})`,
      tables: sites.length ? FULL_TREE_TABLES : ['customers', 'customer_addresses', 'customer_support'],
      changes: [
        {
          table: 'customers',
          identifier: `customer_id=${customerId}`,
          before: null,
          after: { customer_id: customerId, code, friendly_name: friendlyName },
        },
        { table: 'customer_addresses', identifier: '(new customer)', before: null, after: config },
        {
          table: 'sites',
          identifier: `${sites.length} site(s)`,
          before: null,
          after: sites.map((s) => s.name || '(unnamed)'),
        },
      ],
    }),
    async () => apiSend('POST', '/api/customers', {
      customerId, code, friendlyName, config, sites,
    }),
  );
}

/**
 * Update a customer's identity/config fields (friendly name, address, support)
 * without touching the site/level/device tree.
 * @param {string} customerRowId
 * @param {{ friendlyName: string, address?: object, support?: object }} info
 * @returns {Promise<{ updatedAt: string }>}
 */
export async function updateCustomerInfo(customerRowId, { friendlyName, address, support }) {
  return guardedWrite(
    async () => {
      const card = await loadCustomerCard(customerRowId).catch(() => null);
      const changes = [{
        table: 'customers',
        identifier: `id=${customerRowId}`,
        before: { friendlyName: card?.friendlyName ?? null },
        after: { friendlyName },
      }];
      if (address) {
        changes.push({
          table: 'customer_addresses',
          identifier: `customer_id=${customerRowId}`,
          before: card?.config ? {
            address: card.config.address,
            city: card.config.city,
            state: card.config.state,
            zip: card.config.zip,
            mapsUrl: card.config.mapsUrl,
          } : null,
          after: address,
        });
      }
      if (support) {
        changes.push({
          table: 'customer_support', identifier: `customer_id=${customerRowId}`, before: card?.config?.support ?? null, after: support,
        });
      }
      return {
        title: `Update customer info (${customerRowId})`,
        tables: changes.map((c) => c.table),
        changes,
      };
    },
    async () => apiSend('PATCH', `/api/customers/${encodeURIComponent(customerRowId)}`, { friendlyName, address, support }),
  );
}

/**
 * Delete a customer and (via FK cascades — see sql/schema.sql) its entire
 * site/level/device tree.
 * @param {string} customerRowId
 */
export async function deleteCustomer(customerRowId) {
  return guardedWrite(
    async () => {
      const card = await loadCustomerCard(customerRowId).catch(() => null);
      return {
        title: `Delete customer "${card?.friendlyName || customerRowId}"`,
        tables: FULL_TREE_TABLES,
        changes: [{ table: 'customers', identifier: `id=${customerRowId}`, before: card, after: null }],
        note: 'Deleting the customers row cascades (FK ON DELETE CASCADE) through every descendant table listed above.',
      };
    },
    async () => apiSend('DELETE', `/api/customers/${encodeURIComponent(customerRowId)}`),
  );
}

/** List all customers (id/customerId/friendlyName only) for the customer picker. */
export async function listCustomers() {
  const { customers } = await apiGet('/api/customers');
  return customers;
}

/**
 * Card-level refresh for one customer: identity + address/support only. Used
 * by the polling doorbell for customers that were never opened in this tab —
 * enough to keep the list card fresh without pulling the whole tree.
 * @param {string} customerRowId
 * @returns {Promise<{ friendlyName: string, code: string, config: object, updatedAt: string } | null>}
 */
export async function loadCustomerCard(customerRowId) {
  return apiGet(`/api/customers/${encodeURIComponent(customerRowId)}/card`, { treatNotFoundAsNull: true });
}

/**
 * Upsert every site/level/device under a customer, gated by an optimistic
 * concurrency check on customers.updated_at.
 * @param {string} customerRowId
 * @param {object} customer - full legacy-shaped customer object (customer.sites[]...)
 * @param {{ expectedUpdatedAt: string }} options
 * @returns {Promise<{ status: 'saved', updatedAt: string } | { status: 'conflict', remoteUpdatedAt: string }>}
 */
export async function saveCustomerFull(customerRowId, customer, { expectedUpdatedAt }) {
  return guardedWrite(
    async () => {
      const before = await loadCustomerFull(customerRowId);
      return {
        title: `Save full setup for "${customer.friendlyName || customerRowId}"`,
        tables: FULL_TREE_TABLES,
        changes: [{
          table: '(whole tree, row counts)',
          identifier: `customers.id=${customerRowId}`,
          before: summarizeTree(before?.customer),
          after: summarizeTree(customer),
        }],
        note: 'This is a bulk save across ~19 tables — row counts per entity type are shown rather than a full field-level diff.',
      };
    },
    async () => apiSend('PUT', `/api/customers/${encodeURIComponent(customerRowId)}/full`, { customer, expectedUpdatedAt }),
  );
}

/**
 * App-wide "go re-fetch" doorbell, polling-based (see module header for why).
 * Synthesizes the same `{ eventType, old?, new? }` shape the old Realtime
 * channel delivered, so useAppStore.js's handleRemoteCustomerEvent doesn't
 * need to change at all.
 * @param {(payload: object) => void} onChange
 * @returns {() => void} unsubscribe
 */
export function subscribeToCustomersTable(onChange) {
  let lastSnapshot = new Map();
  let primed = false;
  let stopped = false;

  async function poll() {
    if (stopped) return;
    try {
      const customers = await listCustomers();
      const nextSnapshot = new Map(customers.map((c) => [c.id, c.updatedAt]));
      if (primed) {
        for (const [id, updatedAt] of nextSnapshot) {
          if (!lastSnapshot.has(id)) {
            onChange({ eventType: 'INSERT', new: { id, updated_at: updatedAt } });
          } else if (lastSnapshot.get(id) !== updatedAt) {
            onChange({ eventType: 'UPDATE', new: { id, updated_at: updatedAt } });
          }
        }
        for (const id of lastSnapshot.keys()) {
          if (!nextSnapshot.has(id)) onChange({ eventType: 'DELETE', old: { id } });
        }
      }
      lastSnapshot = nextSnapshot;
      primed = true;
    } catch {
      // Transient poll failure — try again next tick, same tolerance the old
      // Realtime channel had for dropped/reconnecting websocket events.
    }
  }

  const intervalId = setInterval(poll, POLL_INTERVAL_MS);
  const onFocus = () => poll();
  window.addEventListener('focus', onFocus);
  poll();

  return () => {
    stopped = true;
    clearInterval(intervalId);
    window.removeEventListener('focus', onFocus);
  };
}

/**
 * Secondary, non-blocking "someone else just edited this" notice, polling-based.
 * Not the conflict guard itself (see saveCustomerFull's updated_at check).
 * @returns {() => void} unsubscribe
 */
export function subscribeToCustomerChanges(customerRowId, onRemoteChange) {
  let lastUpdatedAt;
  let primed = false;
  let stopped = false;

  async function poll() {
    if (stopped) return;
    try {
      const card = await loadCustomerCard(customerRowId);
      if (!card) return;
      if (primed && card.updatedAt !== lastUpdatedAt) {
        onRemoteChange({ id: customerRowId, updated_at: card.updatedAt });
      }
      lastUpdatedAt = card.updatedAt;
      primed = true;
    } catch {
      // Transient poll failure — try again next tick.
    }
  }

  const intervalId = setInterval(poll, POLL_INTERVAL_MS);
  const onFocus = () => poll();
  window.addEventListener('focus', onFocus);
  poll();

  return () => {
    stopped = true;
    clearInterval(intervalId);
    window.removeEventListener('focus', onFocus);
  };
}
