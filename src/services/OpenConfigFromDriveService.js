/**
 * Open / hydrate a customer from a Drive config file (xlsx or Google Sheet).
 * Creates a native Google Sheet from xlsx only at open time — never during catalog Sync.
 * Prefers SetupJson shared layout when present so sheet-tab parse is not flashed then overwritten.
 */
import { downloadConfigFile } from './GoogleDriveService';
import { parseExcelFile } from './ExcelParserService';
import {
  prepareImportFromDriveFile,
  customerSheetQuickLink,
} from './ConfigSheetSyncService';
import { loadCustomerSetupFromSheet } from './LayoutPersistenceService';
import {
  customerIdFromFileName,
  customerCodeFromFileName,
  customerConfigPatch,
  normalizeCustomerConfig,
} from '../lib/customerUtils';
import {
  defaultCustomerConfig,
  mergeGaragesPreferNetworkingServers,
} from '../lib/configSheetSchema';

function addressFromFirstGarage(garages) {
  const g = garages?.[0];
  if (!g) return defaultCustomerConfig();
  return {
    address: g.address || '',
    city: g.city || '',
    state: g.state || '',
    zip: g.zip || '',
    mapsUrl: g.mapsUrl || '',
    support: defaultCustomerConfig().support,
  };
}

function attachConfigSheetLink(garages, sheetMeta, sourceFile) {
  const sheetLink = sheetMeta
    ? customerSheetQuickLink(sheetMeta.spreadsheetTitle, sheetMeta.spreadsheetUrl)
    : null;
  const driveLink = sourceFile
    ? (sourceFile.webViewLink || `https://drive.google.com/file/d/${sourceFile.id}/view`)
    : null;
  if (!sheetLink && !driveLink) return garages;

  return garages.map((garage) => {
    const existing = (garage.quickLinks || []).filter((l) => l.icon !== 'sheets');
    const primaryLink = sheetLink || {
      id: 1,
      name: String(sourceFile.name || '').replace(/\.xlsx?$/i, '') || 'Configuration Sheet',
      url: driveLink,
      icon: 'sheets',
    };
    return {
      ...garage,
      quickLinks: [primaryLink, ...existing],
    };
  });
}

/**
 * Download, parse, and hydrate a Drive config into the app store.
 *
 * @param {object} params
 * @param {object} params.sourceFile - Drive file metadata
 * @param {object[]} params.customers - current customers from the store
 * @param {{ addCustomer: Function, updateCustomer: Function, selectCustomer: Function,
 *   setHydration?: Function }} params.store
 * @param {'new'|'replace'} [params.mode] - default: replace if customerId exists, else new
 * @param {string} [params.friendlyName]
 * @param {string|null} [params.existingSpreadsheetId]
 * @param {number|string|null} [params.existingCustomerId] - store id of the local customer
 *   the caller already matched (e.g. by Drive file IDs). Takes precedence over the
 *   filename-derived customerId lookup, so renamed files still replace the right customer.
 * @returns {Promise<{ customerId: number|string, spreadsheetId: string|null,
 *   usedSetupJson: boolean, setupStatus: 'hydrated'|'absent'|'failed',
 *   setupError: string|null }>}
 */
export async function openConfigFromDriveFile({
  sourceFile,
  customers = [],
  store,
  mode = null,
  friendlyName = '',
  existingSpreadsheetId = null,
  existingCustomerId = null,
  signal = null,
}) {
  if (!sourceFile?.id) {
    throw new Error('No source file selected.');
  }
  if (!store?.addCustomer || !store?.updateCustomer || !store?.selectCustomer) {
    throw new Error('App store actions are required to open a configuration.');
  }
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const buffer = await downloadConfigFile(sourceFile.id, { signal });
  const parsed = parseExcelFile(buffer);
  const cid = customerIdFromFileName(sourceFile.name);
  const code = customerCodeFromFileName(sourceFile.name);
  const existing = (existingCustomerId != null
    ? customers.find((c) => c.id === existingCustomerId)
    : null)
    || customers.find((c) => c.customerId === cid)
    || null;
  const resolvedMode = mode || (existing ? 'replace' : 'new');
  const name = String(friendlyName || existing?.friendlyName || code).trim() || code;

  const sheetMeta = await prepareImportFromDriveFile({
    friendlyName: name,
    sourceFile,
    rawData: parsed.rawData,
    sheetNames: parsed.sheetNames,
    existingSpreadsheetId: existingSpreadsheetId ?? existing?.spreadsheetId ?? null,
    signal,
  });
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const garagesFromTabs = attachConfigSheetLink(parsed.garages, sheetMeta, sourceFile);
  const displaySchedulesFromTabs = parsed.rawData?.displaySchedules || [];
  const sheetFields = {
    spreadsheetId: sheetMeta.spreadsheetId,
    spreadsheetUrl: sheetMeta.spreadsheetUrl,
    spreadsheetTitle: sheetMeta.spreadsheetTitle,
    sourceFileId: sheetMeta.sourceFileId,
    sourceFileName: sheetMeta.sourceFileName,
  };

  // Prefer shared SetupJson layout when present (avoids tab flash then overwrite).
  let usedSetupJson = false;
  let nameFromSetup = '';
  let garages = garagesFromTabs;
  let importedConfig = addressFromFirstGarage(garagesFromTabs);
  let displaySchedules = displaySchedulesFromTabs;
  let lastSetupSavedAt = null;
  // 'hydrated' — the shared layout was read.
  // 'absent'   — the read succeeded and there is no shared layout yet.
  // 'failed'   — the read failed; tab data is shown read-only and must never
  //              be written back over whatever is actually on the sheet.
  let setupStatus = 'absent';
  let setupError = null;

  try {
    const snapshot = await loadCustomerSetupFromSheet({
      ...sheetFields,
      customerId: cid,
    });
    if (snapshot?.customer?.garages) {
      usedSetupJson = true;
      setupStatus = 'hydrated';
      // SetupJson owns layout; Networking tab owns servers (config fields).
      garages = mergeGaragesPreferNetworkingServers(
        attachConfigSheetLink(snapshot.customer.garages, sheetMeta, sourceFile),
        garagesFromTabs,
      );
      importedConfig = snapshot.customer.config || normalizeCustomerConfig({ config: snapshot.customer.config });
      if (Array.isArray(snapshot.customer.displaySchedules)) {
        displaySchedules = snapshot.customer.displaySchedules;
      }
      lastSetupSavedAt = snapshot.savedAt;
      if (snapshot.customer.friendlyName) {
        nameFromSetup = snapshot.customer.friendlyName;
      }
    }
  } catch (err) {
    // A failed SetupJson read is NOT the same as "this customer has no shared
    // layout". Swallowing the difference is what used to lose data: the app
    // showed tab-derived garages (no floor plans, no device positions, no
    // zones) as if they were the shared layout, and the next edit auto-saved
    // that over the real one. Tab data is still shown so the customer stays
    // openable, but the status marks it unsafe to write.
    setupStatus = 'failed';
    setupError = err?.message || 'Could not read the shared layout.';
  }

  const sharedFields = {
    ...sheetFields,
    displaySchedules,
    ...(lastSetupSavedAt ? { lastSetupSavedAt } : {}),
  };

  const resolvedName = String(
    friendlyName || nameFromSetup || existing?.friendlyName || name,
  ).trim() || name;

  if (resolvedMode === 'new' || !existing) {
    const customer = store.addCustomer({
      customerId: cid,
      code,
      friendlyName: resolvedName,
      config: importedConfig,
      garages,
      ...sharedFields,
    });
    store.setHydration?.(customer.id, setupStatus);
    store.selectCustomer(customer.id);
    return {
      customerId: customer.id,
      spreadsheetId: sheetMeta.spreadsheetId,
      usedSetupJson,
      setupStatus,
      setupError,
    };
  }

  const existingConfig = normalizeCustomerConfig(existing);
  const needsAddress = !existingConfig.address && !existingConfig.city;
  store.updateCustomer(existing.id, {
    friendlyName: resolvedName,
    garages,
    config: importedConfig,
    ...sharedFields,
    ...(needsAddress && !usedSetupJson ? customerConfigPatch(existing, importedConfig) : {}),
  });
  store.setHydration?.(existing.id, setupStatus);
  store.selectCustomer(existing.id);
  return {
    customerId: existing.id,
    spreadsheetId: sheetMeta.spreadsheetId,
    usedSetupJson,
    setupStatus,
    setupError,
  };
}
