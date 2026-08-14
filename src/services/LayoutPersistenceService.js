/**
 * LayoutPersistenceService - Full customer setup snapshots (JSON file + SetupJson sheet tab).
 *
 * The SetupJson tab is the shared source of truth: Save writes the entire customer
 * state (info, garages, levels, devices, floor plans, zones) so anyone opening
 * the site reads the same snapshot from Google Sheets.
 */
import { downloadFile, readFileAsText } from './ConfigService';
import { countGaragesDevices } from '../lib/deviceCountUtils';
import { normalizeCustomerConfig } from '../lib/customerUtils';
import { buildConfigFileAppProperties } from '../lib/driveConfigCatalog';
import { updateFileAppProperties } from './GoogleDriveService';
import { enqueueSheetWrite } from './SheetsWriteQueue';
import {
  SETUP_JSON_TAB,
  SETUP_JSON_HEADERS,
  SETUP_JSON_CHUNK_SIZE,
  SETUP_JSON_CHUNK_DATA_PREFIX,
  SETUP_JSON_REVISION_RANGE,
} from '../lib/configSheetSchema';
import {
  getSpreadsheet,
  isMissingSheetTabError,
  readRangeValues,
  readTabValues,
  replaceTabAtomically,
  resolveSpreadsheetId,
  spreadsheetUrl,
} from './GoogleSheetsService';

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
 * @param {{ navigation?: { garageId?: number|null, levelId?: number|null } }} [options]
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
      garages: cloneJson(customer.garages ?? []),
      ...(Array.isArray(customer.displaySchedules)
        ? { displaySchedules: cloneJson(customer.displaySchedules) }
        : {}),
    },
  };

  if (navigation && (navigation.garageId != null || navigation.levelId != null)) {
    payload.navigation = {
      garageId: navigation.garageId ?? null,
      levelId: navigation.levelId ?? null,
    };
  }

  return payload;
}

/** Encode opaque chunk text so Sheets never treats leading +/= as a formula. */
export function encodeSetupJsonChunkData(data) {
  return `${SETUP_JSON_CHUNK_DATA_PREFIX}${String(data ?? '')}`;
}

/** Decode a SetupJson Data cell; accepts legacy unprefixed chunks. */
export function decodeSetupJsonChunkData(cell) {
  const value = String(cell ?? '');
  if (value.startsWith(SETUP_JSON_CHUNK_DATA_PREFIX)) {
    return value.slice(SETUP_JSON_CHUNK_DATA_PREFIX.length);
  }
  return value;
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
 * Split a setup JSON string into sheet rows for the SetupJson tab.
 * @param {object|string} payload - Setup payload object or pre-stringified JSON
 * @returns {string[][]}
 */
export function setupJsonChunksFromPayload(payload) {
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (json.length > MAX_LAYOUT_JSON_BYTES) {
    throw new Error('Setup is too large to save. Try removing floor-plan images or split by site.');
  }

  const chunks = [];
  for (let i = 0; i < json.length; i += SETUP_JSON_CHUNK_SIZE) {
    chunks.push(json.slice(i, i + SETUP_JSON_CHUNK_SIZE));
  }
  const total = Math.max(chunks.length, 1);
  const dataChunks = chunks.length ? chunks : ['{}'];
  const savedAt = (typeof payload === 'object' && payload?.savedAt) || '';
  const hash = setupContentHash(payload);

  return [
    [...SETUP_JSON_HEADERS],
    ...dataChunks.map((data, index) => (
      // The revision rides on the first data row so it can be read on its own.
      index === 0
        ? [index, total, encodeSetupJsonChunkData(data), savedAt, hash]
        : [index, total, encodeSetupJsonChunkData(data)]
    )),
  ];
}

/** Reassemble the JSON string a set of chunk rows encodes (no validation). */
export function setupJsonTextFromRows(rows) {
  let startRow = 0;
  const headerCell = String(rows?.[0]?.[0] ?? '').trim().toLowerCase();
  if (headerCell === 'chunkindex') startRow = 1;
  const dataRows = (rows || []).slice(startRow).filter((row) => row && row.length >= 3);
  const sorted = [...dataRows].sort((a, b) => Number(a[0]) - Number(b[0]));
  return sorted.map((row) => decodeSetupJsonChunkData(row[2])).join('');
}

/**
 * True when a SetupJson read failed because the tab's CONTENT is unusable,
 * rather than because the network or the session was.
 *
 * The difference decides what the user is offered. A transient failure just
 * needs retrying. Content that cannot be parsed will never parse, and since
 * editing is blocked until the layout loads, retrying forever would leave the
 * customer permanently stuck — they need a way to rebuild the tab instead.
 * Tabs written before atomic commits landed can be in exactly this state.
 */
export function isSetupContentError(message) {
  return /SetupJson tab (is|has)|corrupted by the spreadsheet|could not parse JSON|Unsupported setup version|Invalid setup file|Setup file is (empty|too large)/i
    .test(String(message || ''));
}

/** Spreadsheet formula/error tokens that destroy opaque SetupJson chunk data. */
const SPREADSHEET_ERROR_CELL_RE = /^#(ERROR!|REF!|VALUE!|NAME\?|N\/A|DIV\/0!|NUM!|NULL!|CALC!|SPILL!)$/i;

export function isSpreadsheetErrorCell(value) {
  return SPREADSHEET_ERROR_CELL_RE.test(String(value ?? '').trim());
}

/**
 * Validate SetupJson chunk rows before reassembly.
 * @param {string[][]} rows
 */
export function validateSetupJsonChunkRows(rows) {
  if (!rows?.length) {
    throw new Error('SetupJson tab is empty.');
  }

  let startRow = 0;
  const headerCell = String(rows[0]?.[0] ?? '').trim().toLowerCase();
  if (headerCell === 'chunkindex') startRow = 1;

  const dataRows = rows.slice(startRow).filter((row) => row && row.length >= 3);
  if (!dataRows.length) {
    throw new Error('SetupJson tab has no data rows.');
  }

  const expectedTotal = Number(dataRows[0][1]);
  if (!Number.isFinite(expectedTotal) || expectedTotal < 1) {
    throw new Error('SetupJson tab has an invalid ChunkTotal.');
  }
  if (dataRows.length !== expectedTotal) {
    throw new Error(`SetupJson tab is incomplete (${dataRows.length} of ${expectedTotal} chunks).`);
  }

  const indices = new Set();
  for (const row of dataRows) {
    const index = Number(row[0]);
    const total = Number(row[1]);
    if (!Number.isFinite(index) || index < 0) {
      throw new Error('SetupJson tab has an invalid ChunkIndex.');
    }
    if (total !== expectedTotal) {
      throw new Error('SetupJson tab has mismatched ChunkTotal values.');
    }
    if (indices.has(index)) {
      throw new Error(`SetupJson tab has duplicate chunk index ${index}.`);
    }
    if (isSpreadsheetErrorCell(row[2])) {
      throw new Error(
        `SetupJson chunk ${index} was corrupted by the spreadsheet (got "${String(row[2]).trim()}"). `
          + 'Re-upload the floor plan background and save again so layout sync can rewrite the tab.',
      );
    }
    indices.add(index);
  }

  for (let i = 0; i < expectedTotal; i += 1) {
    if (!indices.has(i)) {
      throw new Error(`SetupJson tab is missing chunk ${i} of ${expectedTotal}.`);
    }
  }
}

/**
 * Reassemble SetupJson tab rows into a validated setup snapshot.
 * @param {string[][]} rows
 * @returns {ReturnType<typeof validateLayoutPayload>|null}
 */
export function setupJsonPayloadFromRows(rows) {
  if (!rows?.length) return null;

  let startRow = 0;
  const headerCell = String(rows[0]?.[0] ?? '').trim().toLowerCase();
  if (headerCell === 'chunkindex') startRow = 1;

  const dataRows = rows.slice(startRow).filter((row) => row && row.length >= 3);
  if (!dataRows.length) return null;

  validateSetupJsonChunkRows(rows);

  const sorted = [...dataRows].sort((a, b) => Number(a[0]) - Number(b[0]));
  const json = sorted.map((row) => decodeSetupJsonChunkData(row[2])).join('');
  if (!json.trim()) return null;

  return parseLayoutJson(json);
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

  if (!Array.isArray(customer.garages)) {
    throw new Error('Invalid setup file: customer.garages must be an array.');
  }

  const deviceCount = countGaragesDevices(customer.garages);
  if (deviceCount > MAX_LAYOUT_DEVICES) {
    throw new Error(`Setup contains too many devices (${deviceCount}). Maximum is ${MAX_LAYOUT_DEVICES}.`);
  }

  let navigation = null;
  if (data.navigation != null) {
    if (typeof data.navigation !== 'object' || Array.isArray(data.navigation)) {
      throw new Error('Invalid setup file: navigation must be an object.');
    }
    navigation = {
      garageId: data.navigation.garageId ?? null,
      levelId: data.navigation.levelId ?? null,
    };
  }

  return {
    customer: {
      customerId: String(customer.customerId || '').trim(),
      code: String(customer.code || '').trim(),
      friendlyName: String(customer.friendlyName || '').trim(),
      config: normalizeCustomerConfig({ config: customer.config }),
      garages: cloneJson(customer.garages),
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

// isSetupSnapshotUnchanged() was removed deliberately. It let loadSetupFromSheet
// skip applying a snapshot whose savedAt matched the local timestamp, on the
// assumption that memory already held that layout. With the sheet as the source
// of truth, memory holds nothing until a hydrate runs, so the optimization
// rendered an empty customer. The snapshot has already been fetched and parsed
// by the time we could check — applying it costs nothing.

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

/**
 * Read the SetupJson tab from a linked Google Sheet.
 * @param {object} customer
 * @returns {Promise<ReturnType<typeof validateLayoutPayload>|null>}
 */
export async function readSetupJsonFromSpreadsheet(customer) {
  let spreadsheetId = null;
  try {
    spreadsheetId = await resolveSpreadsheetId(customer);
  } catch {
    return null;
  }
  if (!spreadsheetId) return null;

  const meta = await getSpreadsheet(spreadsheetId);
  const hasSetupJsonTab = (meta.sheets || []).some((s) => s.properties?.title === SETUP_JSON_TAB);
  if (!hasSetupJsonTab) return null;

  try {
    const rows = await readTabValues(spreadsheetId, SETUP_JSON_TAB);
    return setupJsonPayloadFromRows(rows);
  } catch (err) {
    if (isMissingSheetTabError(err.message)) return null;
    throw err;
  }
}

/**
 * Write the full setup snapshot to the SetupJson tab on a Google Sheet.
 * @param {object} customer
 * @param {object} [payload] - Pre-built payload; serialized from customer if omitted
 */
export async function writeSetupJsonToSpreadsheet(customer, payload = null) {
  const spreadsheetId = customer.spreadsheetId || await resolveSpreadsheetId(customer);
  if (!spreadsheetId) {
    throw new Error('No Google Sheet found for this customer. Link a native Google Sheet or create one in the shared folder.');
  }

  const setupPayload = payload || serializeCustomerLayout(customer);
  const json = JSON.stringify(setupPayload);
  const rows = setupJsonChunksFromPayload(setupPayload);

  // Serialized against config tab writes and any other snapshot save for this
  // spreadsheet: overlapping saves would share one staging tab and delete each
  // other's half-written scratch data.
  await enqueueSheetWrite(spreadsheetId, () => replaceTabAtomically(spreadsheetId, SETUP_JSON_TAB, rows, {
    valueInputOption: 'RAW',
    verify: (writtenRows) => {
      // Confirms the staged payload is complete and byte-identical before it is
      // allowed to replace the live tab.
      validateSetupJsonChunkRows(writtenRows);
      if (setupJsonTextFromRows(writtenRows) !== json) {
        throw new Error('Setup did not save completely — the sheet was left unchanged. Try again.');
      }
    },
  }));

  // Stamp shared catalog metadata (Enterprise badge, counts) on the Drive file
  // so every browser's customer list shows it without opening the sheet.
  try {
    await updateFileAppProperties(
      spreadsheetId,
      buildConfigFileAppProperties(setupPayload.customer, setupPayload.savedAt),
    );
  } catch {
    // Best-effort — never fail the setup save over catalog metadata.
  }

  return { setupPayload, spreadsheetId, contentHash: setupContentHash(setupPayload) };
}

/**
 * Read just the SetupJson revision (SavedAt + PayloadHash) — two cells.
 *
 * The conflict check used to reload the entire snapshot before every save. For
 * a customer with twenty floor plans that is ~10 MB down and ~10 MB up every
 * four seconds of editing, which is a large part of why saves timed out and hit
 * rate limits in the first place.
 *
 * @returns {Promise<{ savedAt: string|null, hash: string|null }>}
 */
export async function readSetupJsonRevision(customer) {
  let spreadsheetId = customer?.spreadsheetId || null;
  if (!spreadsheetId) {
    try {
      spreadsheetId = await resolveSpreadsheetId(customer);
    } catch {
      return { savedAt: null, hash: null };
    }
  }
  if (!spreadsheetId) return { savedAt: null, hash: null };

  const rows = await readRangeValues(spreadsheetId, SETUP_JSON_REVISION_RANGE);
  const row = rows?.[0] || [];
  const savedAt = String(row[0] ?? '').trim() || null;
  const hash = String(row[1] ?? '').trim() || null;
  if (savedAt) return { savedAt, hash };

  // A tab written before the revision columns existed has nothing in D2:E2.
  // Fall back to the payload's own savedAt so the conflict check still works on
  // sheets already in the wild — without this, the first save after upgrading
  // would skip the check and could overwrite someone else's newer work. Costs
  // one full read per sheet, once: the next save writes the revision cells.
  try {
    const snapshot = await readSetupJsonFromSpreadsheet({ ...customer, spreadsheetId });
    return { savedAt: snapshot?.savedAt ?? null, hash: null };
  } catch {
    // An unreadable tab is handled by the caller's own read; do not mask it here.
    return { savedAt: null, hash: null };
  }
}

/**
 * Save the full customer setup — writes to Google Sheet when available.
 * Falls back to JSON download for Excel-only Drive links.
 *
 * @param {object} customer
 * @param {{ navigation?: object, download?: boolean }} [options]
 * @returns {Promise<{ payload: object, sheetSaved: boolean, downloaded: boolean }>}
 */
export async function saveCustomerSetup(customer, { navigation = null, download = false } = {}) {
  const payload = serializeCustomerLayout(customer, { navigation });
  let sheetSaved = false;
  let downloaded = false;
  let spreadsheetId = null;
  try {
    spreadsheetId = await resolveSpreadsheetId(customer);
  } catch {
    spreadsheetId = null;
  }

  if (spreadsheetId) {
    await writeSetupJsonToSpreadsheet({ ...customer, spreadsheetId }, payload);
    sheetSaved = true;
  }

  if (download || !sheetSaved) {
    const json = JSON.stringify(payload, null, 2);
    if (json.length > MAX_LAYOUT_JSON_BYTES) {
      throw new Error('Setup is too large to save. Try removing floor-plan images or split by site.');
    }
    downloadFile(json, layoutFilename(customer), 'application/json');
    downloaded = true;
  }

  return {
    payload,
    sheetSaved,
    downloaded,
    spreadsheetId,
    spreadsheetUrl: spreadsheetId ? spreadsheetUrl(spreadsheetId) : null,
  };
}

/**
 * Load setup from Google Sheet and return parsed snapshot (null if tab empty/missing).
 * @param {object} customer
 */
export async function loadCustomerSetupFromSheet(customer) {
  return readSetupJsonFromSpreadsheet(customer);
}
