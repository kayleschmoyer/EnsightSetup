/**
 * LayoutPersistenceService - customer setup snapshots (JSON file backup/restore).
 */
import { downloadFile, readFileAsText } from './ConfigService';
import { countSitesDevices } from '../lib/deviceCountUtils';
import { normalizeCustomerConfig } from '../lib/customerUtils';

export const LAYOUT_SCHEMA_VERSION = 1;
export const LAYOUT_APP_ID = 'garage-layout-editor';
export const MAX_LAYOUT_JSON_BYTES = 50 * 1024 * 1024;
export const MAX_LAYOUT_DEVICES = 50000;

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Build a portable setup document for one customer (full editor state).
 * @param {object} customer - Store customer record
 * @param {{ navigation?: { siteId?: number|null, levelId?: number|null } }} [options]
 */
export function serializeCustomerLayout(customer, { navigation = null } = {}) {
  if (!customer || typeof customer !== 'object') {
    throw new Error('No customer to export.');
  }

  const config = normalizeCustomerConfig(customer);
  const payload = {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    app: LAYOUT_APP_ID,
    customer: {
      customerId: customer.customerId || '',
      code: customer.code || '',
      friendlyName: customer.friendlyName || '',
      config,
      sites: cloneJson(customer.sites ?? []),
      ...(Array.isArray(customer.displaySchedules)
        ? { displaySchedules: cloneJson(customer.displaySchedules) }
        : {}),
    },
  };

  if (navigation && (navigation.siteId != null || navigation.levelId != null)) {
    payload.navigation = {
      siteId: navigation.siteId ?? null,
      levelId: navigation.levelId ?? null,
    };
  }

  return payload;
}

/**
 * Stable non-cryptographic digest of the payload. Used to detect that a save
 * would be a no-op, and to verify a staged write landed intact. FNV-1a over
 * the string, mixed with the length so truncation cannot collide.
 * @param {string} text
 * @returns {string}
 */
export function payloadHash(text) {
  const s = String(text ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${s.length.toString(36)}-${hash.toString(36)}`;
}

/**
 * Hash of a payload's *content*, ignoring savedAt.
 *
 * serializeCustomerLayout stamps a fresh savedAt on every call, so hashing the
 * whole payload would make every save look like a change. This is what lets a
 * save that would rewrite ~10 MB of identical floor plans be skipped instead.
 * @param {object|string} payload
 */
export function setupContentHash(payload) {
  if (typeof payload === 'string') return payloadHash(payload);
  const { savedAt: _savedAt, ...rest } = payload || {};
  return payloadHash(JSON.stringify(rest));
}

/**
 * Validate parsed layout JSON before applying to the store.
 * @param {unknown} data
 */
export function validateLayoutPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid setup file: expected a JSON object.');
  }

  const version = data.schemaVersion;
  if (version !== LAYOUT_SCHEMA_VERSION) {
    throw new Error(`Unsupported setup version (${version ?? 'missing'}). Expected ${LAYOUT_SCHEMA_VERSION}.`);
  }

  if (data.app && data.app !== LAYOUT_APP_ID) {
    throw new Error('This file does not appear to be a Garage Editor setup export.');
  }

  const customer = data.customer;
  if (!customer || typeof customer !== 'object' || Array.isArray(customer)) {
    throw new Error('Invalid setup file: missing customer data.');
  }

  if (!Array.isArray(customer.sites)) {
    throw new Error('Invalid setup file: customer.sites must be an array.');
  }

  const deviceCount = countSitesDevices(customer.sites);
  if (deviceCount > MAX_LAYOUT_DEVICES) {
    throw new Error(`Setup contains too many devices (${deviceCount}). Maximum is ${MAX_LAYOUT_DEVICES}.`);
  }

  let navigation = null;
  if (data.navigation != null) {
    if (typeof data.navigation !== 'object' || Array.isArray(data.navigation)) {
      throw new Error('Invalid setup file: navigation must be an object.');
    }
    navigation = {
      siteId: data.navigation.siteId ?? null,
      levelId: data.navigation.levelId ?? null,
    };
  }

  return {
    customer: {
      customerId: String(customer.customerId || '').trim(),
      code: String(customer.code || '').trim(),
      friendlyName: String(customer.friendlyName || '').trim(),
      config: normalizeCustomerConfig({ config: customer.config }),
      sites: cloneJson(customer.sites),
      ...(Array.isArray(customer.displaySchedules)
        ? { displaySchedules: cloneJson(customer.displaySchedules) }
        : {}),
    },
    navigation,
    savedAt: typeof data.savedAt === 'string' ? data.savedAt : null,
  };
}

/**
 * Parse setup JSON text.
 * @param {string} text
 */
export function parseLayoutJson(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Setup file is empty.');
  }
  if (text.length > MAX_LAYOUT_JSON_BYTES) {
    throw new Error('Setup file is too large.');
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Invalid setup file: could not parse JSON.');
  }

  return validateLayoutPayload(data);
}

export function layoutFilename(customer) {
  const id = String(customer?.customerId || 'customer').trim() || 'customer';
  return `${id}-setup.json`;
}

/**
 * Download the current customer setup as a JSON file.
 */
export function downloadLayoutJson(customer, options = {}) {
  const payload = serializeCustomerLayout(customer, options);
  const json = JSON.stringify(payload, null, 2);
  if (json.length > MAX_LAYOUT_JSON_BYTES) {
    throw new Error('Setup is too large to export. Try removing floor-plan images or split by site.');
  }
  downloadFile(json, layoutFilename(customer), 'application/json');
  return payload;
}

/**
 * Read and validate a setup JSON file from disk.
 * @param {File} file
 */
export async function readLayoutJsonFile(file) {
  if (!file) throw new Error('No file selected.');
  if (file.size > MAX_LAYOUT_JSON_BYTES) {
    throw new Error('Setup file is too large.');
  }
  const text = await readFileAsText(file);
  return parseLayoutJson(text);
}
