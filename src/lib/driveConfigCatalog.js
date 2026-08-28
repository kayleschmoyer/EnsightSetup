/**
 * Merge Drive xlsx + Google Sheet config files into one catalog row per site.
 * When both exist for the same stem, prefer the native Google Sheet (open still
 * re-seeds from the companion xlsx when present).
 */
import { customerIdFromFileName, fileNameStem } from './customerUtils';
import { countSitesDevices } from './deviceCountUtils';

const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';

/**
 * Drive appProperties keys stamped on config files so the catalog can show
 * shared customer metadata (Enterprise badge, counts) without opening files.
 * files.list returns appProperties with the normal catalog fetch — no extra calls.
 */
export const CONFIG_META_PROP_KEYS = Object.freeze({
  enterprise: 'gleEnterprise',
  support24h: 'gleSupport24h',
  sites: 'gleSites',
  levels: 'gleLevels',
  devices: 'gleDevices',
  savedAt: 'gleSavedAt',
});

/**
 * Build Drive appProperties (string values) from a serialized customer snapshot.
 * @param {{ config?: object, sites?: object[] }} customer
 * @param {string} [savedAt] - snapshot ISO timestamp
 */
export function buildConfigFileAppProperties(customer, savedAt = '') {
  const support = customer?.config?.support || {};
  const sites = Array.isArray(customer?.sites) ? customer.sites : [];
  const levelCount = sites.reduce((sum, s) => sum + (s.levels?.length || 0), 0);
  return {
    [CONFIG_META_PROP_KEYS.enterprise]: support.enterpriseSite ? 'true' : 'false',
    [CONFIG_META_PROP_KEYS.support24h]: support.support24Hour ? 'true' : 'false',
    [CONFIG_META_PROP_KEYS.sites]: String(sites.length),
    [CONFIG_META_PROP_KEYS.levels]: String(levelCount),
    [CONFIG_META_PROP_KEYS.devices]: String(countSitesDevices(sites)),
    [CONFIG_META_PROP_KEYS.savedAt]: String(savedAt || ''),
  };
}

/**
 * Parse shared catalog metadata from a Drive file's appProperties.
 * @returns {{ enterpriseSite: boolean, support24Hour: boolean, siteCount: number,
 *   levelCount: number, deviceCount: number, savedAt: string|null }|null}
 *   null when the file has no stamped metadata.
 */
export function configFileMetaFromAppProperties(appProperties) {
  if (!appProperties || typeof appProperties !== 'object') return null;
  const hasAny = Object.values(CONFIG_META_PROP_KEYS)
    .some((key) => appProperties[key] != null);
  if (!hasAny) return null;

  const count = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  };
  return {
    enterpriseSite: appProperties[CONFIG_META_PROP_KEYS.enterprise] === 'true',
    support24Hour: appProperties[CONFIG_META_PROP_KEYS.support24h] === 'true',
    siteCount: count(appProperties[CONFIG_META_PROP_KEYS.sites]),
    levelCount: count(appProperties[CONFIG_META_PROP_KEYS.levels]),
    deviceCount: count(appProperties[CONFIG_META_PROP_KEYS.devices]),
    savedAt: appProperties[CONFIG_META_PROP_KEYS.savedAt] || null,
  };
}

export function isNativeSpreadsheetFile(file) {
  return file?.mimeType === SPREADSHEET_MIME;
}

export function catalogKeyFromFileName(fileName) {
  return customerIdFromFileName(fileName);
}

export function catalogDisplayName(fileName) {
  return fileNameStem(fileName) || String(fileName || '').trim() || 'Untitled';
}

/**
 * @param {Array<{ id: string, name: string, mimeType: string }>} files
 * @returns {Array<{
 *   key: string,
 *   displayName: string,
 *   file: object,
 *   isNativeSheet: boolean,
 *   sourceXlsxFile: object|null,
 *   duplicateFiles: object[],
 * }>}
 */
export function mergeConfigFilesIntoCatalog(files = []) {
  const byKey = new Map();

  for (const file of files) {
    if (!file?.id || !file?.name) continue;
    const key = catalogKeyFromFileName(file.name);
    if (!key) continue;

    const isNativeSheet = isNativeSpreadsheetFile(file);
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, {
        key,
        displayName: catalogDisplayName(file.name),
        file,
        isNativeSheet,
        sourceXlsxFile: isNativeSheet ? null : file,
        duplicateFiles: [],
      });
      continue;
    }

    if (isNativeSheet && !existing.isNativeSheet) {
      byKey.set(key, {
        key,
        displayName: catalogDisplayName(file.name),
        file,
        isNativeSheet: true,
        sourceXlsxFile: existing.file,
        duplicateFiles: existing.duplicateFiles || [],
      });
      continue;
    }

    if (!isNativeSheet && existing.isNativeSheet && !existing.sourceXlsxFile) {
      existing.sourceXlsxFile = file;
      continue;
    }

    // Same-type duplicate for this stem (second Sheet or second xlsx).
    if (
      (isNativeSheet && existing.isNativeSheet && file.id !== existing.file.id)
      || (!isNativeSheet && !existing.isNativeSheet && file.id !== existing.file.id
        && file.id !== existing.sourceXlsxFile?.id)
    ) {
      existing.duplicateFiles = [...(existing.duplicateFiles || []), file];
    }
  }

  return [...byKey.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }),
  );
}

/**
 * Find a local customer that matches a catalog row.
 * Prefer Drive file IDs; only fall back to customerId when the local customer
 * is not yet linked to any Drive file.
 */
export function findLocalCustomerForCatalogRow(customers = [], row) {
  if (!row) return null;
  const fileId = row.file?.id;
  const xlsxId = row.sourceXlsxFile?.id;

  const byFile = customers.find((c) => (
    (fileId && (c.spreadsheetId === fileId || c.sourceFileId === fileId))
    || (xlsxId && (c.spreadsheetId === xlsxId || c.sourceFileId === xlsxId))
  ));
  if (byFile) return byFile;

  return customers.find((c) => (
    c.customerId
    && c.customerId === row.key
    && !c.spreadsheetId
    && !c.sourceFileId
  )) || null;
}

/**
 * Local customers that are not represented by any Drive catalog row.
 */
export function findLocalOrphanCustomers(customers = [], catalogRows = []) {
  return customers.filter((c) => !catalogRows.some((row) => findLocalCustomerForCatalogRow([c], row)));
}

/**
 * Build UI list rows: Drive catalog + local-only orphans.
 * @returns {Array<{
 *   id: string,
 *   key: string,
 *   displayName: string,
 *   isNativeSheet: boolean,
 *   isLocalOnly: boolean,
 *   catalogRow: object|null,
 *   customer: object|null,
 * }>}
 */
export function buildCustomerListRows(customers = [], catalogRows = []) {
  const rows = catalogRows.map((catalogRow) => {
    const customer = findLocalCustomerForCatalogRow(customers, catalogRow);
    return {
      id: `drive:${catalogRow.file.id}`,
      key: catalogRow.key,
      displayName: customer?.friendlyName || catalogRow.displayName,
      isNativeSheet: Boolean(catalogRow.isNativeSheet || customer?.spreadsheetId),
      isLocalOnly: false,
      catalogRow,
      customer,
    };
  });

  for (const customer of findLocalOrphanCustomers(customers, catalogRows)) {
    rows.push({
      id: `local:${customer.id}`,
      key: customer.customerId || String(customer.id),
      displayName: customer.friendlyName || customer.customerId || 'Untitled',
      isNativeSheet: Boolean(customer.spreadsheetId),
      isLocalOnly: true,
      catalogRow: null,
      customer,
    });
  }

  return rows.sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }),
  );
}
