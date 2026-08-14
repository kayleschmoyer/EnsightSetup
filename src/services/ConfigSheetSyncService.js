/**
 * ConfigSheetSyncService - Sync editor changes to native Google Sheets config files.
 */
import {
  CONFIG_SHEET_TABS,
  CONFIG_TAB_HEADERS,
  configSheetTitle,
  detectionTypeFromDeviceType,
  typeTabForDetection,
  backOfCarIsFromDirection,
  formatSheetCellValue,
  buildGarageSheetRow,
  buildGarageLevelSheetRow,
  buildCustomerSheetRow,
  buildDisplayGroupSheetRow,
  buildSensorGroupSheetRow,
  buildSensorSheetRow,
  buildNetworkingSheetRow,
  defaultCustomerConfig,
  ensureDeviceSensorGroup,
  sensorGroupIdForDevice,
} from '../lib/configSheetSchema';
import {
  allSignSheetDisplayNames,
  buildDisplayControllerSheetRows,
  buildSignDisplayLevelSheetRows,
} from '../lib/signInserts';
import { normalizeCustomerConfig } from '../lib/customerUtils';
import { buildTabView, isNonemptyRow } from '../lib/sheetTabView';
import { normalizeTrafficDirection } from '../lib/trafficFlowUtils';
import {
  compareCameraNames,
  streamSyncSheetName,
  isDualLensCamera,
} from '../lib/deviceNamingUtils';
import { serversFromNetworkingRows } from './ExcelParserService';
import { resolveCameraSheetLevelName } from '../lib/zoneLevelUtils';
import {
  createSpreadsheetInFolder,
  setupSpreadsheetTabs,
  writeTabValues,
  replaceTabValues,
  readTabValues,
  readTabsValues,
  resolveSpreadsheetId,
  spreadsheetUrl,
  ensureSpreadsheetTab,
} from './GoogleSheetsService';
import { isSignedIn, findConfigSheetInFolder, trashDriveFile, SPREADSHEET_MIME } from './GoogleDriveService';
import { enqueueSheetWrite } from './SheetsWriteQueue';

async function spreadsheetIdForSync(customer) {
  if (!customer) return null;
  return resolveSpreadsheetId(customer);
}

// Config tab writes and the SetupJson snapshot share one queue per spreadsheet
// (see SheetsWriteQueue) so only one write is ever in flight against a sheet.
const enqueueSync = enqueueSheetWrite;

/**
 * Message shown when a customer has no Google Sheet to write to.
 */
export const NO_SHEET_LINKED_MESSAGE =
  'This site is not linked to a Google Sheet, so the change could not be saved. '
  + 'Open it from Drive to create one.';

/**
 * Guard for every write path.
 *
 * These used to `return` when no spreadsheet could be resolved — reporting
 * success while writing nothing, which is how devices ended up existing only in
 * one browser. Failing loudly is the point: a save that cannot reach the sheet
 * is not a save.
 */
function requireSpreadsheetForWrite(spreadsheetId) {
  if (!spreadsheetId) throw new Error(NO_SHEET_LINKED_MESSAGE);
  return spreadsheetId;
}

function headerRow(tabName) {
  return [...(CONFIG_TAB_HEADERS[tabName] || [])];
}

function tabRowsWithHeaders(tabName, dataRows = []) {
  return [headerRow(tabName), ...dataRows];
}

function sheetValuesFromParsedTab(parsedTab) {
  if (!parsedTab) return null;
  const { headers, rows } = parsedTab;
  const headerLine = headers.length ? headers : [];
  const dataLines = rows.map((row) =>
    headerLine.map((h) => formatSheetCellValue(row[h])),
  );
  return headerLine.length ? [headerLine, ...dataLines] : null;
}

function sheetValuesFromLegacyRows(tabName, objects) {
  const headers = headerRow(tabName);
  const dataRows = (objects || []).map((row) =>
    headers.map((h) => formatSheetCellValue(row[h])),
  );
  return tabRowsWithHeaders(tabName, dataRows);
}

function getServerName(device, servers = []) {
  if (device.server) return String(device.server);
  if (device.serverId != null) {
    const match = servers.find((s) => s.id === device.serverId);
    return match?.name || '';
  }
  return '';
}

function getStreamObject(device, streamKey) {
  const raw = device[streamKey];
  if (typeof raw === 'object' && raw !== null) return raw;
  // Legacy flat fields (device.ipAddress / rtspUrl) only describe stream 1.
  const isStream1 = streamKey === 'stream1';
  return {
    ipAddress: isStream1 ? (device.ipAddress || '') : '',
    port: isStream1 ? (device.port || '') : '',
    externalUrl: typeof raw === 'string'
      ? raw
      : (isStream1 ? (device.rtspUrl || '') : ''),
    streamType: device.type,
  };
}

function getIpAddress(device, stream, streamKey = 'stream1') {
  const streamIp = String(stream?.ipAddress || '').trim();
  if (streamIp) return streamIp;
  // Top-level device IP is stream 1 only — never copy it onto stream 2.
  if (streamKey === 'stream1') return device.ipAddress || '';
  return '';
}

function getIpAddressForSheet(device, stream, streamKey = 'stream1') {
  const ip = getIpAddress(device, stream, streamKey);
  return String(ip || '').trim() || '0.0.0.0';
}

function getPort(device, stream, streamKey = 'stream1') {
  const streamPort = String(stream?.port || '').trim();
  if (streamPort) return streamPort;
  if (streamKey === 'stream1') return device.port || '';
  return '';
}

function getPortForSheet(device, stream, streamKey = 'stream1') {
  const port = getPort(device, stream, streamKey);
  return String(port || '').trim() || '554';
}

function buildDefaultRtspUrl(ipAddress) {
  const ip = String(ipAddress || '').trim() || '0.0.0.0';
  const year = new Date().getFullYear();
  return `rtsp://root:Ensight${year}!@${ip}/axis-media/media.amp?`;
}

/** True when the RTSP URL written for this stream is a generated placeholder. */
function rtspUrlIsGenerated(device, entry) {
  const streamKey = entry.streamKey || 'stream1';
  if (String(entry.stream?.externalUrl || '').trim()) return false;
  if (streamKey === 'stream1') {
    if (typeof device.stream1 === 'string' && device.stream1.trim()) return false;
    if (device.rtspUrl) return false;
  }
  return true;
}

/** Resolve RTSP for a stream. Device-level rtspUrl applies to stream 1 only. */
export function getRtspUrlForStream(device, stream, streamKey = 'stream1') {
  const streamUrl = String(stream?.externalUrl || '').trim();
  if (streamUrl) return streamUrl;
  if (streamKey === 'stream1') {
    if (typeof device.stream1 === 'string' && device.stream1.trim()) return device.stream1;
    if (device.rtspUrl) return device.rtspUrl;
  }
  return buildDefaultRtspUrl(getIpAddressForSheet(device, stream, streamKey));
}

function getVisibleCameraName(device, sheetName) {
  const visible = device.visibleName || device.friendlyName || '';
  return String(visible).trim() || sheetName || device.name || '';
}

function getCameraStatus(device) {
  return device.disabled ? 'disabled' : 'enabled';
}

function getCameraResolution(device) {
  return device.resolution || '640x480';
}

/** Sheet name keys already owned by other cameras on this level (do not delete/overwrite). */
function cameraSheetKeysOwnedByPeers(levelDevices, deviceId) {
  const keys = new Set();
  for (const d of levelDevices || []) {
    if (deviceId != null && d.id === deviceId) continue;
    if (!d?.type?.startsWith('cam-')) continue;
    for (const key of [
      d.name,
      d.configSheetName,
      d.stream1?.configSheetName,
      d.stream2?.configSheetName,
    ]) {
      const k = String(key || '').trim().toLowerCase();
      if (k) keys.add(k);
    }
  }
  return keys;
}

/** Expand a device into one or more logical camera rows (dual-lens → two streams). */
export function expandCameraSyncEntries(device) {
  if (isDualLensCamera(device)) {
    return [1, 2].map((streamNum) => {
      const streamKey = streamNum === 1 ? 'stream1' : 'stream2';
      const stream = getStreamObject(device, streamKey);
      const streamType = stream.streamType || device.type;
      return {
        sheetName: streamSyncSheetName(device, streamNum),
        streamKey,
        stream,
        detectionType: detectionTypeFromDeviceType(streamType),
        direction: normalizeTrafficDirection(stream.direction || device.trafficFlow?.direction),
      };
    });
  }

  const stream = getStreamObject(device, 'stream1');
  return [{
    sheetName: device.name,
    streamKey: 'stream1',
    stream,
    detectionType: detectionTypeFromDeviceType(device.type),
    direction: normalizeTrafficDirection(device.trafficFlow?.direction),
  }];
}

function buildCameraRow(entry, device, servers) {
  const streamKey = entry.streamKey || 'stream1';
  const ip = getIpAddressForSheet(device, entry.stream, streamKey);
  return [
    entry.sheetName,
    getVisibleCameraName(device, entry.sheetName),
    ip,
    getPortForSheet(device, entry.stream, streamKey),
    entry.detectionType,
    getServerName(device, servers),
    getRtspUrlForStream(device, entry.stream, streamKey),
    getCameraStatus(device),
    getCameraResolution(device),
  ];
}

function buildTypeTabRow(entry, garage, level, device) {
  const garageName = garage.internalName || garage.name || '';
  const levelName = resolveCameraSheetLevelName(device, level, garage);
  return [
    entry.sheetName,
    garageName,
    levelName,
    backOfCarIsFromDirection(entry.direction),
    formatSheetCellValue(device?.isEntryExitCamera ?? true),
    device?.dependentCameraName || '',
  ];
}

const CAMERA_NAME_TABS = new Set(['Cameras', 'FLICameras', 'LPRCameras']);

function sortDataRowsByCameraName(view, dataRows, keyColumn) {
  return [...dataRows].sort((a, b) =>
    compareCameraNames(view.get(a, keyColumn), view.get(b, keyColumn)),
  );
}

const isNonemptyDataRow = isNonemptyRow;

/** Normalize a set of lookup keys the same way a view keys its cells. */
function keySet(keys) {
  if (keys instanceof Set) {
    return new Set([...keys].map((k) => String(k).trim().toLowerCase()).filter(Boolean));
  }
  return new Set([...(keys || [])].map((k) => String(k).trim().toLowerCase()).filter(Boolean));
}

/**
 * Read a tab and resolve its columns by header name.
 *
 * Column positions come from the sheet itself, so a column someone inserted,
 * removed or reordered by hand no longer sends every subsequent write into the
 * wrong column.
 */
async function readTabView(spreadsheetId, tabName, prefetchedRows = null) {
  const rows = prefetchedRows ?? await readTabValues(spreadsheetId, tabName);
  return {
    view: buildTabView(tabName, rows),
    previousRowCount: rows.length,
    previousColumnCount: rows[0]?.length ?? 0,
    originalValues: rows,
  };
}

/** Cheap structural comparison of two 2D string grids. */
function sameValues(a, b) {
  if (a.length !== b.length) return false;
  for (let r = 0; r < a.length; r += 1) {
    const rowA = a[r] || [];
    const rowB = b[r] || [];
    if (rowA.length !== rowB.length) return false;
    for (let c = 0; c < rowA.length; c += 1) {
      if (String(rowA[c] ?? '') !== String(rowB[c] ?? '')) return false;
    }
  }
  return true;
}

/**
 * Write a tab back, unless it already holds exactly this content.
 *
 * Rewriting an identical tab costs a request, burns quota and is one more
 * chance to fail for no benefit — which matters now that a save rebuilds every
 * tab rather than patching one row.
 * @returns {Promise<boolean>} whether a write was issued
 */
async function writeTabView(spreadsheetId, ctx, dataRows) {
  const values = ctx.view.toValues(dataRows);
  if (ctx.originalValues && sameValues(values, ctx.originalValues)) return false;

  await replaceTabValues(spreadsheetId, ctx.view.tabName, values, {
    previousRowCount: ctx.previousRowCount,
    previousColumnCount: ctx.previousColumnCount,
  });
  return true;
}

/**
 * @param {string} keyColumn - header NAME of the key column
 * @param {{key: string, row: any[]}[]} keyedRows - row values in schema order
 */
async function upsertRowsByKey(spreadsheetId, tabName, keyColumn, keyedRows, prefetchedRows = null) {
  const ctx = await readTabView(spreadsheetId, tabName, prefetchedRows);
  const { view } = ctx;
  const dataRows = view.dataRows.filter(isNonemptyDataRow);

  for (const { key, row, preserveColumns } of keyedRows) {
    const target = String(key).trim().toLowerCase();
    const existingIndex = dataRows.findIndex((r) => view.key(r, keyColumn) === target);
    const existingRow = existingIndex === -1 ? null : dataRows[existingIndex];
    // Carry the existing row forward so columns outside the schema survive.
    const next = view.rowFromSchemaValues(row, existingRow);

    // Columns whose incoming value is only a generated default must not
    // overwrite a real value already on the sheet.
    for (const column of preserveColumns || []) {
      const current = existingRow ? String(view.get(existingRow, column) ?? '').trim() : '';
      const index = view.indexOf(column);
      if (current && index !== -1) next[index] = view.get(existingRow, column);
    }
    // Replace every row for this key — earlier upsert bugs left duplicates.
    const withoutKey = dataRows.filter((r) => view.key(r, keyColumn) !== target);
    dataRows.length = 0;
    dataRows.push(...withoutKey, next);
  }

  const sortedRows = CAMERA_NAME_TABS.has(tabName)
    ? sortDataRowsByCameraName(view, dataRows, keyColumn)
    : dataRows;

  return writeTabView(spreadsheetId, ctx, sortedRows);
}

async function deleteRowsByKeys(spreadsheetId, tabName, keyColumn, keys) {
  const targets = keySet(keys);
  if (!targets.size) return;

  const ctx = await readTabView(spreadsheetId, tabName);
  if (ctx.previousRowCount <= 1) return;
  const { view } = ctx;

  const kept = view.dataRows.filter((row) => {
    if (!isNonemptyDataRow(row)) return false;
    return !targets.has(view.key(row, keyColumn));
  });

  const sortedKept = CAMERA_NAME_TABS.has(tabName)
    ? sortDataRowsByCameraName(view, kept, keyColumn)
    : kept;

  await writeTabView(spreadsheetId, ctx, sortedKept);
}

/**
 * Throws when a config file with this title (Sheet, or xlsx unless importMode)
 * already exists in the shared folder. Pass `hint` to tailor the error message.
 * `excludeFileIds` skips this customer's own files (needed when retrying a rename
 * that already succeeded on Drive).
 */
export async function assertConfigSheetNameAvailable(title, {
  importMode = false,
  hint = '',
  excludeFileIds = [],
} = {}) {
  const existing = await findConfigSheetInFolder(title, {
    spreadsheetsOnly: importMode,
    excludeFileIds,
  });
  if (existing) {
    const fallbackHint = importMode
      ? 'This customer has already been imported. Open the existing customer or choose a different friendly name.'
      : 'Use Import Customer to load it, or choose a different friendly name.';
    throw new Error(
      `A configuration sheet named "${existing.name}" already exists in the shared folder. ${hint || fallbackHint}`,
    );
  }
}

/**
 * Create a fresh config spreadsheet with all tab headers.
 * Seeds Garages (+ optional GarageLevels) for manual customers.
 */
export async function createCustomerConfigSheet({
  friendlyName,
  customerId = '',
  code = '',
  config = null,
  garage = null,
  levels = [],
}) {
  if (!isSignedIn()) {
    throw new Error('Sign in with Google to create a configuration sheet.');
  }

  const title = configSheetTitle(friendlyName);
  await assertConfigSheetNameAvailable(title);

  let spreadsheetId = null;
  let url = '';
  try {
    const created = await createSpreadsheetInFolder(title);
    spreadsheetId = created.spreadsheetId;
    url = created.spreadsheetUrl;
    await setupSpreadsheetTabs(spreadsheetId, [...CONFIG_SHEET_TABS]);

    const garageName = garage?.internalName || garage?.name || friendlyName;
    const visibleGarageName = garage?.name || friendlyName;
    const customerConfig = config || defaultCustomerConfig();

    for (const tab of CONFIG_SHEET_TABS) {
      if (tab === 'Customer') {
        const row = buildCustomerSheetRow(
          { friendlyName, customerId, code },
          customerConfig,
        );
        await writeTabValues(spreadsheetId, tab, tabRowsWithHeaders(tab, [row]));
        continue;
      }
      if (tab === 'Garages') {
        await writeTabValues(spreadsheetId, tab, tabRowsWithHeaders(tab, [[garageName, visibleGarageName, '']]));
        continue;
      }
      if (tab === 'GarageLevels' && levels.length > 0) {
        const levelRows = levels.map((level, index) =>
          buildGarageLevelSheetRow(garage || { name: garageName, internalName: garageName }, level, index + 1),
        );
        await writeTabValues(spreadsheetId, tab, tabRowsWithHeaders(tab, levelRows));
        continue;
      }
      await writeTabValues(spreadsheetId, tab, tabRowsWithHeaders(tab));
    }
  } catch (err) {
    if (spreadsheetId) {
      try {
        await trashDriveFile(spreadsheetId);
      } catch {
        // Best-effort rollback; surface the original create error.
      }
    }
    throw err;
  }

  return {
    spreadsheetId,
    spreadsheetUrl: url,
    spreadsheetTitle: title,
  };
}

/**
 * Sync top-level customer card fields to the Customer tab (single row).
 */
export async function syncCustomerToSheet({ customer }) {
  if (!customer) return;
  const spreadsheetId = await spreadsheetIdForSync(customer);
  requireSpreadsheetForWrite(spreadsheetId);
  const config = normalizeCustomerConfig(customer);

  return enqueueSync(spreadsheetId, async () => {
    const row = buildCustomerSheetRow(customer, config);
    await replaceTabValues(spreadsheetId, 'Customer', tabRowsWithHeaders('Customer', [row]));
  });
}

/**
 * Populate a spreadsheet from parsed xlsx rawData.
 * Preserves exact tab order and column headers from the source workbook.
 * Writes tabs sequentially to reduce Sheets rate-limit storms.
 * @param {string} spreadsheetId
 * @param {object} rawData
 * @param {string[]} [sheetNames]
 * @param {{ signal?: AbortSignal }} [options]
 */
async function populateSpreadsheetFromRawData(spreadsheetId, rawData, sheetNames, options = {}) {
  const signal = options.signal;
  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  };

  const sourceTabs = sheetNames?.length
    ? [...sheetNames]
    : (rawData.sheets ? Object.keys(rawData.sheets) : [...CONFIG_SHEET_TABS]);

  const tabs = sourceTabs.includes('Customer')
    ? sourceTabs
    : ['Customer', ...sourceTabs.filter((tab) => tab !== 'Customer')];

  throwIfAborted();
  await setupSpreadsheetTabs(spreadsheetId, tabs, { signal });

  const legacyTabDataMap = {
    Networking: rawData.networking,
    Garages: rawData.garages,
    GarageLevels: rawData.garageLevels,
    DisplayGroups: rawData.displayGroups,
    DisplayControllers: rawData.displayControllers,
    DisplayLevels: rawData.displayLevels,
    DisplaySchedules: rawData.displaySchedules,
    Cameras: rawData.cameras,
    FLICameras: rawData.fliCameras,
    LPRCameras: rawData.lprCameras,
    SensorGroups: rawData.sensorGroups,
    Sensors: rawData.sensors,
  };

  for (const tab of tabs) {
    throwIfAborted();
    const parsedValues = sheetValuesFromParsedTab(rawData.sheets?.[tab]);
    if (parsedValues) {
      await writeTabValues(spreadsheetId, tab, parsedValues, { signal });
      continue;
    }
    const legacyRows = legacyTabDataMap[tab];
    if (legacyRows?.length) {
      await writeTabValues(spreadsheetId, tab, sheetValuesFromLegacyRows(tab, legacyRows), { signal });
      continue;
    }
    await writeTabValues(spreadsheetId, tab, tabRowsWithHeaders(tab), { signal });
  }
}

/**
 * Link a native Google Sheet import to the selected Drive file (no copy created).
 */
export function linkImportToSourceFile({ friendlyName, sourceFile }) {
  if (!sourceFile?.id) {
    throw new Error('No source file selected for import.');
  }

  const title = configSheetTitle(friendlyName);
  const isNativeSheet = sourceFile.mimeType === SPREADSHEET_MIME;

  if (!isNativeSheet) {
    throw new Error('Use prepareImportFromDriveFile for Excel imports.');
  }

  return {
    spreadsheetId: sourceFile.id,
    spreadsheetUrl: sourceFile.webViewLink || spreadsheetUrl(sourceFile.id),
    spreadsheetTitle: title,
    sourceFileId: sourceFile.id,
    sourceFileName: sourceFile.name,
  };
}

/**
 * Prepare sheet metadata for a Drive import.
 * - Native Google Sheet: reuse the same file for sync.
 * - Excel (.xlsx): create (or refresh) a native Google Sheet with matching tabs/data;
 *   keep the original xlsx on Drive as the import source only.
 */
export async function prepareImportFromDriveFile({
  friendlyName,
  sourceFile,
  rawData,
  sheetNames,
  existingSpreadsheetId = null,
  signal = null,
}) {
  if (!sourceFile?.id) {
    throw new Error('No source file selected for import.');
  }
  if (!isSignedIn()) {
    throw new Error('Sign in with Google to import configuration files.');
  }
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const title = configSheetTitle(friendlyName);
  const isNativeSheet = sourceFile.mimeType === SPREADSHEET_MIME;

  const baseMeta = {
    spreadsheetTitle: title,
    sourceFileId: sourceFile.id,
    sourceFileName: sourceFile.name,
  };

  if (isNativeSheet) {
    return {
      ...baseMeta,
      spreadsheetId: sourceFile.id,
      spreadsheetUrl: sourceFile.webViewLink || spreadsheetUrl(sourceFile.id),
    };
  }

  if (!rawData) {
    throw new Error('Excel import is missing parsed workbook data.');
  }

  let spreadsheetId = existingSpreadsheetId || null;
  if (!spreadsheetId) {
    // Reuse a Sheet left over from a previous/hung open attempt instead of failing.
    const existingSheet = await findConfigSheetInFolder(title, { spreadsheetsOnly: true });
    if (existingSheet?.id) {
      spreadsheetId = existingSheet.id;
    }
  }

  if (spreadsheetId) {
    await populateSpreadsheetFromRawData(spreadsheetId, rawData, sheetNames, { signal });
  } else {
    const created = await createSpreadsheetInFolder(title);
    spreadsheetId = created.spreadsheetId;
    try {
      await populateSpreadsheetFromRawData(spreadsheetId, rawData, sheetNames, { signal });
    } catch (err) {
      if (err?.name === 'AbortError') {
        try { await trashDriveFile(spreadsheetId); } catch { /* best-effort */ }
      }
      throw err;
    }
  }

  return {
    ...baseMeta,
    spreadsheetId,
    spreadsheetUrl: spreadsheetUrl(spreadsheetId),
  };
}

/**
 * True when a converted Sheet already contains config data (any Garages row).
 * Open/reload uses this to avoid re-seeding a healthy Sheet from its companion
 * xlsx, which would overwrite newer tab edits made through the app.
 */
export async function sheetHasConfigData(spreadsheetId) {
  const rows = await readTabValues(spreadsheetId, 'Garages');
  return rows.slice(1).some(isNonemptyDataRow);
}

/** @deprecated Use prepareImportFromDriveFile. */
export async function importConfigSheetFromSource(params) {
  return prepareImportFromDriveFile(params);
}

/** @deprecated Use prepareImportFromDriveFile. */
export async function createConfigSheetFromRawData({ friendlyName, rawData, sheetNames }) {
  const title = configSheetTitle(friendlyName);
  await assertConfigSheetNameAvailable(title, { importMode: true });
  const { spreadsheetId, spreadsheetUrl: url } = await createSpreadsheetInFolder(title);
  await populateSpreadsheetFromRawData(spreadsheetId, rawData, sheetNames);
  return { spreadsheetId, spreadsheetUrl: url, spreadsheetTitle: title };
}

function garageSheetKeys(garage) {
  const keys = new Set();
  for (const value of [garage?.internalName, garage?.name]) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized) keys.add(normalized);
  }
  return keys;
}

function collectLocalGarageSheetDeviceKeys(garage) {
  const cameraKeys = [];
  const signKeys = [];
  const sensorKeys = [];
  const displayGroupNames = [];

  for (const level of garage?.levels || []) {
    for (const device of level.devices || []) {
      if (device?.type?.startsWith('cam-')) {
        for (const entry of expandCameraSyncEntries(device)) {
          if (entry.sheetName) cameraKeys.push(entry.sheetName);
        }
      } else if (device?.type?.startsWith('sign-')) {
        for (const name of allSignSheetDisplayNames(device)) {
          signKeys.push(name);
        }
      } else if (device?.type?.startsWith('sensor-')) {
        const entries = Array.isArray(device.sensors) && device.sensors.length
          ? device.sensors
          : [{ sensorName: device.name, sensorId: device.sensorId || '' }];
        for (const entry of entries) {
          const key = entry.sensorName || entry.name;
          if (key) sensorKeys.push(key);
        }
      }
    }
  }

  for (const group of garage?.displayGroups || []) {
    if (group?.name) displayGroupNames.push(group.name);
  }

  return { cameraKeys, signKeys, sensorKeys, displayGroupNames };
}

/** Remove data rows whose named column matches keysToRemove. Returns removed rows. */
async function removeRowsMatchingColumn(spreadsheetId, tabName, columnName, keysToRemove) {
  const targets = keySet(keysToRemove);
  if (!targets.size) return [];

  const ctx = await readTabView(spreadsheetId, tabName);
  if (ctx.previousRowCount <= 1) return [];
  const { view } = ctx;

  const removed = [];
  const kept = [];
  for (const row of view.dataRows) {
    if (!isNonemptyDataRow(row)) continue;
    if (targets.has(view.key(row, columnName))) removed.push(row);
    else kept.push(row);
  }

  if (removed.length) await writeTabView(spreadsheetId, ctx, kept);
  return removed;
}

/** Rewrite a named column's cells that match oldKeys to newValue. */
async function rewriteColumnMatchingKeys(spreadsheetId, tabName, columnName, oldKeys, newValue) {
  const targets = keySet(oldKeys);
  const nextValue = String(newValue || '').trim();
  if (!targets.size || !nextValue) return;

  const ctx = await readTabView(spreadsheetId, tabName);
  if (ctx.previousRowCount <= 1) return;
  const { view } = ctx;
  const column = view.indexOf(columnName);
  if (column === -1) return;

  let changed = false;
  const nextRows = view.dataRows.filter(isNonemptyDataRow).map((row) => {
    if (!targets.has(view.key(row, columnName))) return row;
    changed = true;
    const copy = [...row];
    copy[column] = nextValue;
    return copy;
  });

  if (!changed) return;
  await writeTabView(spreadsheetId, ctx, nextRows);
}

async function rewriteDisplayScheduleGarageColumns(spreadsheetId, oldKeys, newValue) {
  const targets = keySet(oldKeys);
  const nextValue = String(newValue || '').trim();
  if (!targets.size || !nextValue) return;

  const ctx = await readTabView(spreadsheetId, 'DisplaySchedules');
  if (ctx.previousRowCount <= 1) return;
  const { view } = ctx;
  const columns = ['Garage1', 'Garage2'].map((n) => view.indexOf(n)).filter((i) => i !== -1);

  let changed = false;
  const nextRows = view.dataRows.filter(isNonemptyDataRow).map((row) => {
    const copy = [...row];
    for (const col of columns) {
      if (targets.has(String(copy[col] ?? '').trim().toLowerCase())) {
        copy[col] = nextValue;
        changed = true;
      }
    }
    return copy;
  });

  if (!changed) return;
  await writeTabView(spreadsheetId, ctx, nextRows);
}

async function removeDisplaySchedulesForGarage(spreadsheetId, garageKeys, signKeys) {
  const garageSet = keySet(garageKeys);
  const signSet = keySet(signKeys);
  if (!garageSet.size && !signSet.size) return;

  const ctx = await readTabView(spreadsheetId, 'DisplaySchedules');
  if (ctx.previousRowCount <= 1) return;
  const { view } = ctx;

  const kept = view.dataRows.filter((row) => {
    if (!isNonemptyDataRow(row)) return false;
    if (signSet.has(view.key(row, 'DisplayName'))) return false;
    if (garageSet.has(view.key(row, 'Garage1'))) return false;
    if (garageSet.has(view.key(row, 'Garage2'))) return false;
    return true;
  });

  await writeTabView(spreadsheetId, ctx, kept);
}

async function removeGarageLevelsForKeys(spreadsheetId, keysToRemove) {
  const targets = keySet(keysToRemove);
  if (!targets.size) return;
  const ctx = await readTabView(spreadsheetId, 'GarageLevels');
  const kept = ctx.view.dataRows.filter((row) =>
    isNonemptyDataRow(row) && !targets.has(ctx.view.key(row, 'Garage')),
  );
  await writeTabView(spreadsheetId, ctx, kept);
}

async function syncGarageLevelsTabForGarage(spreadsheetId, garage, { extraKeysToRemove = null } = {}) {
  const garageName = garage.internalName || garage.name || '';
  const targets = keySet(extraKeysToRemove || []);
  targets.add(garageName.trim().toLowerCase());

  const ctx = await readTabView(spreadsheetId, 'GarageLevels');
  const { view } = ctx;
  const otherGarageRows = view.dataRows.filter((row) =>
    isNonemptyDataRow(row) && !targets.has(view.key(row, 'Garage')),
  );
  const levelRows = (garage.levels || []).map((level, index) =>
    view.rowFromSchemaValues(buildGarageLevelSheetRow(garage, level, index + 1)),
  );
  await writeTabView(spreadsheetId, ctx, [...otherGarageRows, ...levelRows]);
}

/**
 * Remove a garage and all related rows (levels, cameras, signs, sensors, schedules).
 * Pass `otherGarages` (remaining sites) so display groups whose names are still
 * used by another site are kept — the DisplayGroups tab is keyed by name only.
 */
export async function deleteGarageFromSheet({ customer, garage, otherGarages = [] }) {
  if (!garage) return;
  const spreadsheetId = await spreadsheetIdForSync(customer);
  requireSpreadsheetForWrite(spreadsheetId);
  const garageKeys = garageSheetKeys(garage);
  const local = collectLocalGarageSheetDeviceKeys(garage);

  // Keep display groups shared (by name) with other sites.
  const groupNamesInOtherGarages = new Set();
  for (const other of otherGarages) {
    for (const group of other?.displayGroups || []) {
      const name = String(group?.name || '').trim().toLowerCase();
      if (name) groupNamesInOtherGarages.add(name);
    }
  }
  local.displayGroupNames = local.displayGroupNames.filter(
    (name) => !groupNamesInOtherGarages.has(String(name).trim().toLowerCase()),
  );

  return enqueueSync(spreadsheetId, async () => {
    // Capture sheet-side camera / sensor-group keys before removing rows.
    const cameraNamesFromSheet = [];
    for (const tab of ['FLICameras', 'LPRCameras']) {
      const { view } = await readTabView(spreadsheetId, tab);
      for (const row of view.dataRows) {
        if (!isNonemptyDataRow(row)) continue;
        const name = view.get(row, 'CameraName');
        if (garageKeys.has(view.key(row, 'Garage')) && name) cameraNamesFromSheet.push(name);
      }
    }

    // Group IDs are not unique across garages (e.g. "Group1", "NWAVE"), so
    // only delete Sensors rows for group IDs no other garage still uses.
    const { view: sensorGroupView } = await readTabView(spreadsheetId, 'SensorGroups');
    const sensorGroupIds = new Set();
    const otherGarageGroupIds = new Set();
    for (const row of sensorGroupView.dataRows) {
      if (!isNonemptyDataRow(row)) continue;
      const groupId = sensorGroupView.key(row, 'GroupID');
      if (!groupId) continue;
      if (garageKeys.has(sensorGroupView.key(row, 'Garage'))) sensorGroupIds.add(groupId);
      else otherGarageGroupIds.add(groupId);
    }
    for (const groupId of otherGarageGroupIds) {
      sensorGroupIds.delete(groupId);
    }

    await deleteRowsByKeys(spreadsheetId, 'Garages', 'Garage', [...garageKeys]);
    await removeGarageLevelsForKeys(spreadsheetId, garageKeys);

    await removeRowsMatchingColumn(spreadsheetId, 'FLICameras', 'Garage', garageKeys);
    await removeRowsMatchingColumn(spreadsheetId, 'LPRCameras', 'Garage', garageKeys);

    const allCameraKeys = [...local.cameraKeys, ...cameraNamesFromSheet];
    if (allCameraKeys.length) {
      await deleteRowsByKeys(spreadsheetId, 'Cameras', 'Name', allCameraKeys);
    }

    await removeRowsMatchingColumn(spreadsheetId, 'SensorGroups', 'Garage', garageKeys);
    if (local.sensorKeys.length) {
      await deleteRowsByKeys(spreadsheetId, 'Sensors', 'SensorName', local.sensorKeys);
    }
    if (sensorGroupIds.size) {
      await removeRowsMatchingColumn(spreadsheetId, 'Sensors', 'SensorGroupID', sensorGroupIds);
    }

    await removeRowsMatchingColumn(spreadsheetId, 'DisplayLevels', 'Garage', garageKeys);
    if (local.signKeys.length) {
      await deleteRowsByKeys(spreadsheetId, 'DisplayLevels', 'DisplayName', local.signKeys);
      await deleteRowsByKeys(spreadsheetId, 'DisplayControllers', 'DisplayName', local.signKeys);
    }
    await removeDisplaySchedulesForGarage(spreadsheetId, garageKeys, local.signKeys);

    if (local.displayGroupNames.length) {
      await deleteRowsByKeys(spreadsheetId, 'DisplayGroups', 'Name', local.displayGroupNames);
    }
  });
}

/**
 * Sync a garage row to the Garages tab and all its levels to GarageLevels.
 * On rename, retargets garage-keyed device rows to the new garage name.
 */
export async function syncGarageToSheet({ customer, garage, previousGarage = null }) {
  if (!garage) return;
  const spreadsheetId = await spreadsheetIdForSync(customer);
  requireSpreadsheetForWrite(spreadsheetId);

  return enqueueSync(spreadsheetId, async () => {
    const previousKeys = previousGarage ? garageSheetKeys(previousGarage) : new Set();

    if (previousGarage) {
      const oldGarageKey = previousGarage.internalName || previousGarage.name;
      const newGarageKey = garage.internalName || garage.name;
      if (oldGarageKey && newGarageKey && String(oldGarageKey).trim() !== String(newGarageKey).trim()) {
        await deleteRowsByKeys(spreadsheetId, 'Garages', 'Garage', [oldGarageKey]);
        // Retarget device rows that still reference the old garage name.
        await rewriteColumnMatchingKeys(spreadsheetId, 'FLICameras', 'Garage', previousKeys, newGarageKey);
        await rewriteColumnMatchingKeys(spreadsheetId, 'LPRCameras', 'Garage', previousKeys, newGarageKey);
        await rewriteColumnMatchingKeys(spreadsheetId, 'SensorGroups', 'Garage', previousKeys, newGarageKey);
        await rewriteColumnMatchingKeys(spreadsheetId, 'DisplayLevels', 'Garage', previousKeys, newGarageKey);
        await rewriteDisplayScheduleGarageColumns(spreadsheetId, previousKeys, newGarageKey);
      }
      // Always remove prior garage level rows (old internalName, visible name, or stale sheet keys).
      await removeGarageLevelsForKeys(spreadsheetId, previousKeys);
    }

    const garageKey = garage.internalName || garage.name;
    await upsertRowsByKey(spreadsheetId, 'Garages', 'Garage', [{
      key: garageKey,
      row: buildGarageSheetRow(garage),
    }]);
    try {
      await syncGarageLevelsTabForGarage(spreadsheetId, garage, { extraKeysToRemove: previousKeys });
    } catch (err) {
      if (!previousGarage) {
        // New add: best-effort removal of the Garages row written above so a
        // failed add does not leave a partial garage on the Sheet.
        try {
          await deleteRowsByKeys(spreadsheetId, 'Garages', 'Garage', [garageKey]);
        } catch { /* surface the original error */ }
      }
      throw err;
    }
  });
}

/**
 * Sync all levels for the current garage to the GarageLevels tab.
 */
export async function syncGarageLevelsToSheet({ customer, garage }) {
  if (!garage) return;
  const spreadsheetId = await spreadsheetIdForSync(customer);
  requireSpreadsheetForWrite(spreadsheetId);
  return enqueueSync(spreadsheetId, () => syncGarageLevelsTabForGarage(spreadsheetId, garage));
}

/**
 * Sync a camera device to the config sheet (Cameras + FLICameras/LPRCameras).
 * @returns {Promise<{ configSheetNames: string[] }>} sheet names written
 */
export async function deleteCameraFromSheet({ customer, device }) {
  if (!device?.type?.startsWith('cam-')) return;

  const spreadsheetId = await spreadsheetIdForSync(customer);
  requireSpreadsheetForWrite(spreadsheetId);

  return enqueueSync(spreadsheetId, async () => {
    const entries = expandCameraSyncEntries(device);
    const keys = entries.map((e) => e.sheetName);
    if (!keys.length) return;
    await deleteRowsByKeys(spreadsheetId, 'Cameras', 'Name', keys);
    await deleteRowsByKeys(spreadsheetId, 'FLICameras', 'CameraName', keys);
    await deleteRowsByKeys(spreadsheetId, 'LPRCameras', 'CameraName', keys);
  });
}

/** Remove a sign from DisplayControllers and DisplayLevels tabs. */
export async function deleteSignFromSheet({ customer, device }) {
  const displayNames = allSignSheetDisplayNames(device);
  if (!device?.type?.startsWith('sign-') || !displayNames.length) return;

  const spreadsheetId = await spreadsheetIdForSync(customer);
  requireSpreadsheetForWrite(spreadsheetId);

  const nameKeys = new Set(displayNames.map((n) => n.trim().toLowerCase()));

  return enqueueSync(spreadsheetId, async () => {
    await deleteRowsByKeys(spreadsheetId, 'DisplayControllers', 'DisplayName', displayNames);
    const ctx = await readTabView(spreadsheetId, 'DisplayLevels');
    const kept = ctx.view.dataRows.filter((row) => {
      if (!isNonemptyDataRow(row)) return false;
      const name = ctx.view.key(row, 'DisplayName');
      return !name || !nameKeys.has(name);
    });
    await writeTabView(spreadsheetId, ctx, kept);
  });
}

/**
 * Sync multiple new camera devices (e.g. bulk add on Edit Level).
 * @returns {Promise<object[]>} levels array with configSheetName applied to synced cameras
 */
export async function syncBulkCamerasToSheet({
  customer,
  garage,
  level,
  devices,
  servers = [],
}) {
  const cameras = (devices || []).filter((d) => d.type?.startsWith('cam-'));
  if (!cameras.length || !level) return devices;

  for (const device of cameras) {
    await syncCameraToSheet({
      customer,
      garage,
      level,
      device,
      servers,
    });
  }

  const syncedIds = new Set(cameras.map((d) => d.id));
  return (devices || []).map((d) =>
    syncedIds.has(d.id) && d.type?.startsWith('cam-') ? deviceAfterCameraSync(d) : d,
  );
}

/**
 * Sync multiple new sign devices to DisplayControllers + DisplayLevels.
 * Mirrors syncBulkCamerasToSheet for signs.
 * @returns {Promise<object[]>} devices (unchanged shape)
 */
export async function syncBulkSignsToSheet({
  customer,
  garage,
  level,
  devices,
  servers = [],
  displayGroups,
  garages,
}) {
  const signs = (devices || []).filter((d) => d.type?.startsWith('sign-'));
  if (!signs.length || !level) return devices;

  const groups = displayGroups || garage?.displayGroups || [];
  const garageForSync = garage ? { ...garage, displayGroups: groups } : { displayGroups: groups };
  const garageList = garages?.length ? garages : (garage ? [garage] : []);

  for (const device of signs) {
    await syncSignGroupAssignmentToSheet({
      customer,
      garage: garageForSync,
      device,
      servers,
    });
    await syncSignDisplayLevelsToSheet({
      customer,
      device,
      garages: garageList,
    });
  }

  return devices;
}

/**
 * Sync multiple sensor devices to SensorGroups + Sensors tabs.
 * Auto-assigns a protocol sensor group when configSensorGroupId is missing.
 * @returns {Promise<{ devices: object[], garage: object }>}
 */
export async function syncBulkSensorsToSheet({
  customer,
  garage,
  level,
  devices,
}) {
  const sensors = (devices || []).filter((d) => d.type?.startsWith('sensor-'));
  if (!sensors.length || !level) {
    return { devices: devices || [], garage };
  }

  let workingGarage = garage;
  const byId = new Map((devices || []).map((d) => [d.id, d]));

  for (const device of sensors) {
    const result = await syncSensorGroupAssignmentToSheet({
      customer,
      garage: workingGarage,
      level,
      device: byId.get(device.id) || device,
    });
    if (result?.device) {
      byId.set(result.device.id, result.device);
    }
    if (result?.garage) {
      workingGarage = result.garage;
    }
  }

  const nextDevices = (devices || []).map((d) => byId.get(d.id) || d);
  return { devices: nextDevices, garage: workingGarage };
}

/**
 * Sync a single sensor device (SensorGroups rebuild + Sensors upsert).
 * Auto-assigns a protocol sensor group when configSensorGroupId is missing.
 * @returns {Promise<{ device: object, garage: object }|null>}
 */
export async function syncSensorToSheet({ customer, garage, level, device }) {
  return syncSensorGroupAssignmentToSheet({ customer, garage, level, device });
}

/**
 * Remove a sensor device's rows from the Sensors tab.
 * Pass garage (with the device already removed from levels) and call
 * syncSensorGroupsToSheet afterward if SensorGroups membership should refresh —
 * or pass garage here to rebuild SensorGroups in the same sync.
 */
export async function deleteSensorFromSheet({ customer, device, garage = null }) {
  if (!device?.type?.startsWith('sensor-')) return;

  const spreadsheetId = await spreadsheetIdForSync(customer);
  requireSpreadsheetForWrite(spreadsheetId);

  const sensorEntries = Array.isArray(device.sensors) && device.sensors.length
    ? device.sensors
    : [{ sensorName: device.name, sensorId: device.sensorId || '' }];
  const keys = sensorEntries
    .map((s) => s.sensorName || s.name)
    .filter((k) => String(k || '').trim());

  return enqueueSync(spreadsheetId, async () => {
    if (keys.length) {
      await deleteRowsByKeys(spreadsheetId, 'Sensors', 'SensorName', keys);
    }
    if (!garage) return;

    const garageName = garage.internalName || garage.name || '';
    const garageKey = garageName.trim().toLowerCase();
    const ctx = await readTabView(spreadsheetId, 'SensorGroups');
    const otherRows = ctx.view.dataRows.filter((row) => (
      isNonemptyDataRow(row) && ctx.view.key(row, 'Garage') !== garageKey
    ));
    const groupRows = collectSensorGroupRowsForGarage(garage)
      .map((row) => ctx.view.rowFromSchemaValues(row));
    await writeTabView(spreadsheetId, ctx, [...otherRows, ...groupRows]);
  });
}

/**
 * Remove many cameras / signs / sensors from config tabs in one sync turn.
 * Pass garage (with those devices already removed) when sensors are included so
 * SensorGroups can be rebuilt for that garage.
 */
export async function deleteDevicesFromSheet({ customer, devices = [], garage = null }) {
  const list = (devices || []).filter(Boolean);
  if (!list.length) return;

  const cameras = list.filter((d) => d.type?.startsWith('cam-'));
  const signs = list.filter((d) => d.type?.startsWith('sign-'));
  const sensors = list.filter((d) => d.type?.startsWith('sensor-'));
  if (!cameras.length && !signs.length && !sensors.length) return;

  const spreadsheetId = await spreadsheetIdForSync(customer);
  requireSpreadsheetForWrite(spreadsheetId);

  return enqueueSync(spreadsheetId, async () => {
    const cameraKeys = [];
    for (const device of cameras) {
      for (const entry of expandCameraSyncEntries(device)) {
        if (entry?.sheetName) cameraKeys.push(entry.sheetName);
      }
    }
    if (cameraKeys.length) {
      await deleteRowsByKeys(spreadsheetId, 'Cameras', 'Name', cameraKeys);
      await deleteRowsByKeys(spreadsheetId, 'FLICameras', 'CameraName', cameraKeys);
      await deleteRowsByKeys(spreadsheetId, 'LPRCameras', 'CameraName', cameraKeys);
    }

    const displayNames = [];
    for (const device of signs) {
      displayNames.push(...allSignSheetDisplayNames(device));
    }
    if (displayNames.length) {
      await deleteRowsByKeys(spreadsheetId, 'DisplayControllers', 'DisplayName', displayNames);
      const nameKeys = new Set(displayNames.map((n) => String(n).trim().toLowerCase()).filter(Boolean));
      const ctx = await readTabView(spreadsheetId, 'DisplayLevels');
      const kept = ctx.view.dataRows.filter((row) => {
        if (!isNonemptyDataRow(row)) return false;
        const name = ctx.view.key(row, 'DisplayName');
        return !name || !nameKeys.has(name);
      });
      await writeTabView(spreadsheetId, ctx, kept);
    }

    const sensorKeys = [];
    for (const device of sensors) {
      const sensorEntries = Array.isArray(device.sensors) && device.sensors.length
        ? device.sensors
        : [{ sensorName: device.name, sensorId: device.sensorId || '' }];
      for (const entry of sensorEntries) {
        const key = entry.sensorName || entry.name;
        if (String(key || '').trim()) sensorKeys.push(key);
      }
    }
    if (sensorKeys.length) {
      await deleteRowsByKeys(spreadsheetId, 'Sensors', 'SensorName', sensorKeys);
    }

    if (garage && sensors.length) {
      const garageName = garage.internalName || garage.name || '';
      const garageKey = garageName.trim().toLowerCase();
      const ctx = await readTabView(spreadsheetId, 'SensorGroups');
      const otherRows = ctx.view.dataRows.filter((row) => (
        isNonemptyDataRow(row) && ctx.view.key(row, 'Garage') !== garageKey
      ));
      const groupRows = collectSensorGroupRowsForGarage(garage)
        .map((row) => ctx.view.rowFromSchemaValues(row));
      await writeTabView(spreadsheetId, ctx, [...otherRows, ...groupRows]);
    }
  });
}

/**
 * Sync a camera device to the config sheet (Cameras + FLICameras/LPRCameras).
 * @returns {Promise<{ configSheetNames: string[] }>} sheet names written
 */
export async function syncCameraToSheet({
  customer,
  garage,
  level,
  device,
  previousDevice = null,
  servers = [],
}) {
  if (!device?.type?.startsWith('cam-')) {
    return { configSheetNames: [] };
  }

  const spreadsheetId = await spreadsheetIdForSync(customer);
  requireSpreadsheetForWrite(spreadsheetId);

  return enqueueSync(spreadsheetId, async () => {
    const entries = expandCameraSyncEntries(device);
    const previousEntries = previousDevice ? expandCameraSyncEntries(previousDevice) : [];

    // Rename: delete rows keyed under the previous device name(s)
    if (previousDevice) {
      const oldBase = previousDevice.configSheetName || previousDevice.name;
      const newBase = device.name;
      if (oldBase && newBase && oldBase !== newBase) {
        const oldEntries = expandCameraSyncEntries({ ...previousDevice, name: oldBase });
        const oldKeys = oldEntries.map((e) => e.sheetName);
        await deleteRowsByKeys(spreadsheetId, 'Cameras', 'Name', oldKeys);
        await deleteRowsByKeys(spreadsheetId, 'FLICameras', 'CameraName', oldKeys);
        await deleteRowsByKeys(spreadsheetId, 'LPRCameras', 'CameraName', oldKeys);
      }
    }

    // Remove stale type-tab rows when detection type changed per stream
    if (previousDevice) {
      for (const prevEntry of previousEntries) {
        const prevTab = typeTabForDetection(prevEntry.detectionType);
        const newEntry = entries.find((e) => e.sheetName === prevEntry.sheetName);
        const newTab = newEntry ? typeTabForDetection(newEntry.detectionType) : null;
        if (prevTab && prevTab !== newTab) {
          await deleteRowsByKeys(spreadsheetId, prevTab, 'CameraName', [prevEntry.sheetName]);
        }
      }
    }

    const cameraRows = entries.map((entry) => ({
      key: entry.sheetName,
      row: buildCameraRow(entry, device, servers),
      // The generated fallback embeds the current year, so re-syncing an
      // untouched camera in a new year silently rewrote its RTSPURL — and would
      // equally overwrite a URL someone typed into the sheet by hand.
      preserveColumns: rtspUrlIsGenerated(device, entry) ? ['RTSPURL'] : [],
    }));
    await upsertRowsByKey(spreadsheetId, 'Cameras', 'Name', cameraRows);

    for (const entry of entries) {
      const typeTab = typeTabForDetection(entry.detectionType);
      if (!typeTab) continue;
      await upsertRowsByKey(spreadsheetId, typeTab, 'CameraName', [{
        key: entry.sheetName,
        row: buildTypeTabRow(entry, garage, level, device),
      }]);
    }

    // Dual-lens reduced to single stream: remove only THIS device's stale stream
    // rows. Never delete a sheet key still owned by another camera on the level.
    if (previousEntries.length > entries.length) {
      const currentKeys = new Set(entries.map((e) => e.sheetName.toLowerCase()));
      const peerKeys = cameraSheetKeysOwnedByPeers(level?.devices, device.id);
      const stale = previousEntries
        .map((e) => e.sheetName)
        .filter((k) => {
          const key = String(k || '').trim().toLowerCase();
          return key && !currentKeys.has(key) && !peerKeys.has(key);
        });
      if (stale.length) {
        await deleteRowsByKeys(spreadsheetId, 'Cameras', 'Name', stale);
        await deleteRowsByKeys(spreadsheetId, 'FLICameras', 'CameraName', stale);
        await deleteRowsByKeys(spreadsheetId, 'LPRCameras', 'CameraName', stale);
      }
    }

    return {
      configSheetNames: entries.map((e) => e.sheetName),
      spreadsheetUrl: customer.spreadsheetUrl || spreadsheetUrl(spreadsheetId),
    };
  });
}

/**
 * Apply post-sync device fields (configSheetName tracking).
 */
export function deviceAfterCameraSync(device) {
  return {
    ...device,
    configSheetName: device.name,
  };
}

export function customerSheetQuickLink(spreadsheetTitle, spreadsheetUrl) {
  return {
    id: 1,
    name: spreadsheetTitle || 'Configuration Sheet',
    url: spreadsheetUrl,
    icon: 'sheets',
  };
}

function collectSensorGroupRowsForGarage(garage) {
  const groupsById = new Map((garage.sensorGroups || []).map((g) => [g.id, g]));
  const seen = new Set();
  const rows = [];
  for (const level of garage.levels || []) {
    for (const device of level.devices || []) {
      if (!device.type?.startsWith('sensor-') || device.configSensorGroupId == null) continue;
      const group = groupsById.get(device.configSensorGroupId);
      if (!group) continue;
      const key = `${group.groupId}::${level.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(buildSensorGroupSheetRow(garage, level, group));
    }
  }
  return rows;
}

/**
 * Upsert one display group row on DisplayGroups (by group name).
 */
export async function upsertDisplayGroupToSheet({ customer, group }) {
  const name = String(group?.name || '').trim();
  if (!name) return;
  const spreadsheetId = await spreadsheetIdForSync(customer);
  requireSpreadsheetForWrite(spreadsheetId);

  return enqueueSync(spreadsheetId, async () => {
    await upsertRowsByKey(spreadsheetId, 'DisplayGroups', 'Name', [{
      key: name,
      row: buildDisplayGroupSheetRow(group),
    }]);
  });
}

/**
 * Sync display update groups to the DisplayGroups tab (merges by group name).
 */
export async function syncDisplayGroupsToSheet({ customer, garage, garages = null }) {
  if (!garage && !garages?.length) return;
  const spreadsheetId = await spreadsheetIdForSync(customer);
  requireSpreadsheetForWrite(spreadsheetId);

  // Display groups are keyed by name across the whole customer, so a single
  // garage cannot tell a group it just deleted from one another site still
  // owns. Given every site, the tab is mirrored and a deleted group's row goes
  // with it; given only one, the old merge is kept so another site's groups are
  // never collateral damage.
  const mirroring = Boolean(garages?.length);
  const sourceGarages = mirroring ? garages : [garage];
  const groupsByName = new Map();
  for (const g of sourceGarages) {
    for (const group of g?.displayGroups || []) {
      const name = String(group?.name || '').trim().toLowerCase();
      if (name && !groupsByName.has(name)) groupsByName.set(name, group);
    }
  }

  const myRows = [...groupsByName.values()].map((g) => buildDisplayGroupSheetRow(g));
  const myNames = new Set(groupsByName.keys());

  return enqueueSync(spreadsheetId, async () => {
    const ctx = await readTabView(spreadsheetId, 'DisplayGroups');
    // Mirroring: nothing is kept, so a deleted group's row goes too.
    const kept = mirroring ? [] : ctx.view.dataRows.filter((row) => {
      if (!isNonemptyDataRow(row)) return false;
      const name = ctx.view.key(row, 'Name');
      return !name || !myNames.has(name);
    });
    const mine = myRows.map((row) => ctx.view.rowFromSchemaValues(row));
    await writeTabView(spreadsheetId, ctx, [...kept, ...mine]);
  });
}

/**
 * Rebuild SensorGroups rows for the current garage (preserves other garages).
 */
export async function syncSensorGroupsToSheet({ customer, garage }) {
  if (!garage) return;
  const spreadsheetId = await spreadsheetIdForSync(customer);
  requireSpreadsheetForWrite(spreadsheetId);
  const garageName = garage.internalName || garage.name || '';
  const garageKey = garageName.trim().toLowerCase();

  return enqueueSync(spreadsheetId, async () => {
    const ctx = await readTabView(spreadsheetId, 'SensorGroups');
    const otherRows = ctx.view.dataRows.filter((row) => (
      isNonemptyDataRow(row) && ctx.view.key(row, 'Garage') !== garageKey
    ));
    const groupRows = collectSensorGroupRowsForGarage(garage)
      .map((row) => ctx.view.rowFromSchemaValues(row));
    await writeTabView(spreadsheetId, ctx, [...otherRows, ...groupRows]);
  });
}

/**
 * Upsert a sign's row(s) on DisplayControllers (all mapped fields).
 * Multi-insert monuments write one row per insert DisplayName.
 */
export async function syncSignGroupAssignmentToSheet({
  customer,
  garage,
  device,
  servers = [],
  previousDevice = null,
}) {
  const keyedRows = buildDisplayControllerSheetRows(device, {
    displayGroups: garage?.displayGroups || [],
    servers,
  });
  if (!device?.type?.startsWith('sign-') || !keyedRows.length) return;
  const spreadsheetId = await spreadsheetIdForSync(customer);
  requireSpreadsheetForWrite(spreadsheetId);

  const nextKeys = new Set(keyedRows.map((r) => r.key.trim().toLowerCase()));
  const prevNames = previousDevice ? allSignSheetDisplayNames(previousDevice) : [];
  const staleKeys = prevNames.filter((n) => !nextKeys.has(n.trim().toLowerCase()));

  return enqueueSync(spreadsheetId, async () => {
    if (staleKeys.length) {
      await deleteRowsByKeys(spreadsheetId, 'DisplayControllers', 'DisplayName', staleKeys);
    }
    await upsertRowsByKey(spreadsheetId, 'DisplayControllers', 'DisplayName', keyedRows);
  });
}

/**
 * Sync a sign's rows on DisplayLevels (replaces all rows for this display name / inserts).
 */
export async function syncSignDisplayLevelsToSheet({
  customer,
  device,
  garages = [],
  previousDevice = null,
}) {
  const displayNames = allSignSheetDisplayNames(device);
  if (!device?.type?.startsWith('sign-')) return;
  const spreadsheetId = await spreadsheetIdForSync(customer);
  requireSpreadsheetForWrite(spreadsheetId);
  const prevNames = previousDevice ? allSignSheetDisplayNames(previousDevice) : [];
  const namesToClear = new Set(
    [...prevNames, ...displayNames].filter(Boolean).map((n) => n.trim().toLowerCase()),
  );
  // Always clear prior rows for this sign's keys — even when newRows is empty
  // (e.g. display levels unassigned / garage cleared).
  const newRows = buildSignDisplayLevelSheetRows(device, garages);

  return enqueueSync(spreadsheetId, async () => {
    const ctx = await readTabView(spreadsheetId, 'DisplayLevels');
    const kept = ctx.view.dataRows.filter((row) => {
      if (!isNonemptyDataRow(row)) return false;
      const name = ctx.view.key(row, 'DisplayName');
      return !name || !namesToClear.has(name);
    });
    const mine = newRows.map((row) => ctx.view.rowFromSchemaValues(row));
    await writeTabView(spreadsheetId, ctx, [...kept, ...mine]);
  });
}

/**
 * Update sensor group assignment on SensorGroups + Sensors tabs.
 * Ensures the device has a protocol sensor group before writing Sensors rows
 * (previously a missing configSensorGroupId silently skipped the Sensors tab).
 * @returns {Promise<{ device: object, garage: object }|null>}
 */
export async function syncSensorGroupAssignmentToSheet({
  customer,
  garage,
  level,
  device,
}) {
  if (!device?.type?.startsWith('sensor-') || !level) return null;
  const spreadsheetId = await spreadsheetIdForSync(customer);
  requireSpreadsheetForWrite(spreadsheetId);

  const ensured = ensureDeviceSensorGroup(garage, level, device);
  const workingGarage = ensured.garage;
  const workingDevice = ensured.device;
  const groupId = sensorGroupIdForDevice(workingDevice, workingGarage.sensorGroups || []);
  const garageName = workingGarage.internalName || workingGarage.name || '';
  const garageKey = garageName.trim().toLowerCase();

  await enqueueSync(spreadsheetId, async () => {
    const ctx = await readTabView(spreadsheetId, 'SensorGroups');
    const otherRows = ctx.view.dataRows.filter((row) => (
      isNonemptyDataRow(row) && ctx.view.key(row, 'Garage') !== garageKey
    ));
    const groupRows = collectSensorGroupRowsForGarage(workingGarage)
      .map((row) => ctx.view.rowFromSchemaValues(row));
    await writeTabView(spreadsheetId, ctx, [...otherRows, ...groupRows]);

    const sensorEntries = Array.isArray(workingDevice.sensors) && workingDevice.sensors.length
      ? workingDevice.sensors
      : [{ sensorName: workingDevice.name, sensorId: workingDevice.sensorId || '' }];

    const keyedRows = sensorEntries
      .filter((s) => s.sensorName || s.name)
      .map((s) => ({
        key: s.sensorName || s.name,
        row: buildSensorSheetRow(s, groupId),
      }));

    if (keyedRows.length) {
      await upsertRowsByKey(spreadsheetId, 'Sensors', 'SensorName', keyedRows);
    }
  });

  return { device: workingDevice, garage: workingGarage };
}

/**
 * Tabs a full resync rebuilds. DisplaySchedules and Networking are absent on
 * purpose: the app has no row builder for DisplaySchedules at all, and
 * buildNetworkingSheetRow is explicitly best-effort — several Networking
 * columns have no equivalent in the app's model. Rewriting either from state
 * would drop detail the app cannot represent, so they keep their existing
 * targeted updates.
 */
export const RESYNCED_CONFIG_TABS = Object.freeze([
  'Garages', 'GarageLevels', 'Cameras', 'FLICameras', 'LPRCameras',
  'DisplayControllers', 'DisplayLevels', 'SensorGroups', 'Sensors', 'DisplayGroups',
]);

/** Collect every row the app owns, per tab, from current state. */
function collectOwnedRows(garages, servers) {
  const owned = {
    Garages: [], Cameras: [], FLICameras: [], LPRCameras: [],
    DisplayControllers: [], Sensors: [], DisplayGroups: [],
  };
  const garageLevelRows = [];
  const sensorGroupRows = [];
  const displayLevelRows = [];
  const signNames = new Set();
  const garageKeys = new Set();

  for (const garage of garages) {
    const garageKey = String(garage.internalName || garage.name || '').trim().toLowerCase();
    if (garageKey) garageKeys.add(garageKey);

    owned.Garages.push({ key: garage.internalName || garage.name, row: buildGarageSheetRow(garage) });

    (garage.levels || []).forEach((level, index) => {
      garageLevelRows.push(buildGarageLevelSheetRow(garage, level, index + 1));
    });

    for (const group of garage.displayGroups || []) {
      if (group?.name) {
        owned.DisplayGroups.push({ key: group.name, row: buildDisplayGroupSheetRow(group) });
      }
    }

    sensorGroupRows.push(...collectSensorGroupRowsForGarage(garage));

    const serverList = servers.length ? servers : (garage.servers || []);
    for (const level of garage.levels || []) {
      for (const device of level.devices || []) {
        if (device?.type?.startsWith('cam-')) {
          for (const entry of expandCameraSyncEntries(device)) {
            if (!entry.sheetName) continue;
            owned.Cameras.push({
              key: entry.sheetName,
              row: buildCameraRow(entry, device, serverList),
              preserveColumns: rtspUrlIsGenerated(device, entry) ? ['RTSPURL'] : [],
            });
            const typeTab = typeTabForDetection(entry.detectionType);
            if (typeTab) {
              owned[typeTab].push({
                key: entry.sheetName,
                row: buildTypeTabRow(entry, garage, level, device),
              });
            }
          }
        } else if (device?.type?.startsWith('sign-')) {
          const controllerRows = buildDisplayControllerSheetRows(device, {
            displayGroups: garage.displayGroups || [],
            servers: serverList,
          });
          if (!controllerRows.length) continue;
          for (const entry of controllerRows) {
            signNames.add(entry.key.trim().toLowerCase());
            owned.DisplayControllers.push(entry);
          }
          displayLevelRows.push(...buildSignDisplayLevelSheetRows(device, garages));
        } else if (device?.type?.startsWith('sensor-')) {
          const groupId = sensorGroupIdForDevice(device, garage.sensorGroups || []);
          const entries = Array.isArray(device.sensors) && device.sensors.length
            ? device.sensors
            : [{ sensorName: device.name, sensorId: device.sensorId || '' }];
          for (const sensor of entries) {
            const key = sensor.sensorName || sensor.name;
            if (key) owned.Sensors.push({ key, row: buildSensorSheetRow(sensor, groupId) });
          }
        }
      }
    }
  }

  return { owned, garageLevelRows, sensorGroupRows, displayLevelRows, signNames, garageKeys };
}

/**
 * Columns forming a row's identity on each mirrored tab. Several tabs carry
 * more than one row per primary key (a garage has many levels, a sign has many
 * display levels), so identity is composite there.
 */
const RESYNC_KEY_COLUMNS = Object.freeze({
  Garages: ['Garage'],
  GarageLevels: ['Garage', 'Level'],
  Cameras: ['Name'],
  FLICameras: ['CameraName'],
  LPRCameras: ['CameraName'],
  DisplayControllers: ['DisplayName'],
  DisplayLevels: ['DisplayName', 'Garage', 'Level'],
  SensorGroups: ['GroupID', 'Garage', 'Level'],
  Sensors: ['SensorName'],
  DisplayGroups: ['Name'],
});

function compositeKeyFromRow(view, row, columns) {
  return columns.map((c) => view.key(row, c)).join('\u0000');
}

function compositeKeyFromSchemaRow(tabName, row, columns) {
  const schema = CONFIG_TAB_HEADERS[tabName] || [];
  return columns
    .map((c) => String(row[schema.indexOf(c)] ?? '').trim().toLowerCase())
    .join('\u0000');
}

/**
 * Make a tab hold exactly the rows the app has, and nothing else.
 *
 * Rows the app no longer has are removed. Most of those are ghosts — a device
 * deleted or renamed while its sheet write failed — and leaving them meant the
 * sheet and the app disagreed permanently.
 *
 * A row that survives keeps any column outside the schema, so a column added by
 * hand is not collateral damage.
 * @returns {Promise<boolean>} whether a write was issued
 */
async function mirrorTab(spreadsheetId, tabName, prefetched, rows) {
  const columns = RESYNC_KEY_COLUMNS[tabName];
  const ctx = await readTabView(spreadsheetId, tabName, prefetched);
  const { view } = ctx;

  const existingByKey = new Map();
  for (const row of view.dataRows) {
    if (!isNonemptyDataRow(row)) continue;
    const key = compositeKeyFromRow(view, row, columns);
    if (!existingByKey.has(key)) existingByKey.set(key, row);
  }

  const nextRows = rows.map(({ row, preserveColumns }) => {
    const existing = existingByKey.get(compositeKeyFromSchemaRow(tabName, row, columns)) || null;
    const next = view.rowFromSchemaValues(row, existing);
    for (const column of preserveColumns || []) {
      const current = existing ? String(view.get(existing, column) ?? '').trim() : '';
      const index = view.indexOf(column);
      if (current && index !== -1) next[index] = view.get(existing, column);
    }
    return next;
  });

  const sorted = CAMERA_NAME_TABS.has(tabName)
    ? sortDataRowsByCameraName(view, nextRows, columns[0])
    : nextRows;

  return writeTabView(spreadsheetId, ctx, sorted);
}

/**
 * Rewrite every config tab the app owns so it holds exactly what the app holds.
 *
 * This is what keeps the sheet and the app showing the same thing. Devices the
 * tabs never received are added, values mangled by an older build are rewritten,
 * and rows the app no longer has are removed — without anyone having to find
 * the affected rows.
 *
 * Only runs from a hydrated state (see saveCustomerSetupToSheet), which is what
 * makes "the app's contents win" safe: before the hydration gate, app state
 * could be an empty stub from a failed read.
 *
 * @returns {Promise<{ changedTabs: string[] }>}
 */
export async function syncAllConfigTabsForCustomer({ customer, garages = [], servers = [] }) {
  const spreadsheetId = await spreadsheetIdForSync(customer);
  // No sites means nothing to mirror from; clearing every tab on an empty
  // state would be indistinguishable from a bug.
  if (!spreadsheetId || !garages.length) return { changedTabs: [] };

  const {
    owned, garageLevelRows, sensorGroupRows, displayLevelRows,
  } = collectOwnedRows(garages, servers);

  const byTab = {
    ...owned,
    GarageLevels: garageLevelRows.map((row) => ({ row })),
    SensorGroups: sensorGroupRows.map((row) => ({ row })),
    DisplayLevels: displayLevelRows.map((row) => ({ row })),
  };

  return enqueueSync(spreadsheetId, async () => {
    // One request for all ten tabs rather than ten round-trips. Tabs the sheet
    // does not have read back empty rather than failing the batch.
    const { values: prefetched, missing } = await readTabsValues(
      spreadsheetId, RESYNCED_CONFIG_TABS,
    );
    const changedTabs = [];

    for (const tab of RESYNCED_CONFIG_TABS) {
      const rows = byTab[tab] || [];
      // An empty set would blank the tab; treat it as "nothing to say" instead.
      if (!rows.length) continue;
      // Older sheets are short a tab or two. Create one only when there is
      // something to put in it — otherwise the app would hold devices the sheet
      // could never show — but never litter empty tabs onto every sheet.
      if (missing.includes(tab)) await ensureSpreadsheetTab(spreadsheetId, tab);
      if (await mirrorTab(spreadsheetId, tab, prefetched[tab], rows)) changedTabs.push(tab);
    }

    return { changedTabs };
  });
}

/**
 * Read a tab into header-keyed objects, preserving the sheet's own column names.
 */
async function readTabAsObjects(spreadsheetId, tabName) {
  let rows;
  try {
    rows = await readTabValues(spreadsheetId, tabName);
  } catch {
    return null;
  }
  if (!rows?.length) return [];
  const headers = rows[0].map((h) => String(h ?? '').trim());
  return rows.slice(1).filter(isNonemptyDataRow).map((row) => {
    const obj = {};
    headers.forEach((header, i) => {
      if (header) obj[header] = row?.[i] ?? '';
    });
    return obj;
  });
}

/**
 * Read the DisplaySchedules tab.
 *
 * Nothing in the app edits schedules — they are only carried through SetupJson,
 * so the copy in a snapshot goes stale the moment anyone edits the tab. Reading
 * them here makes the tab authoritative, which is what keeps the app and the
 * sheet showing the same schedules. It is also why DisplaySchedules is not part
 * of the write-side mirror: writing a stale copy back would overwrite the very
 * edits this read exists to pick up.
 *
 * @returns {Promise<object[]|null>} null when the tab could not be read
 */
export async function loadDisplaySchedulesFromTab(customer) {
  const spreadsheetId = await spreadsheetIdForSync(customer);
  if (!spreadsheetId) return null;
  return readTabAsObjects(spreadsheetId, 'DisplaySchedules');
}

/**
 * Read Networking tab → LevelSelector server objects (shared across garages).
 */
export async function loadServersFromNetworkingTab(customer) {
  const spreadsheetId = await spreadsheetIdForSync(customer);
  if (!spreadsheetId) return [];
  let rows;
  try {
    rows = await readTabValues(spreadsheetId, 'Networking');
  } catch {
    return [];
  }
  if (!rows?.length) return [];
  const headers = rows[0].map((h) => String(h ?? '').trim());
  const objects = rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((header, i) => {
      if (!header) return;
      obj[header] = row?.[i] ?? '';
    });
    return obj;
  });
  return serversFromNetworkingRows(objects);
}

/**
 * Write Networking tab rows from garage.servers (LevelSelector shape).
 * Upserts by Name; preserves other Networking rows not in this garage's server list.
 */
export async function syncServersToSheet({ customer, garage }) {
  if (!garage) return;
  const spreadsheetId = await spreadsheetIdForSync(customer);
  requireSpreadsheetForWrite(spreadsheetId);
  const servers = garage.servers || [];
  const myRows = servers.map((s) => buildNetworkingSheetRow(s));
  const myNames = new Set(
    servers.map((s) => String(s.name || '').trim().toLowerCase()).filter(Boolean),
  );

  return enqueueSync(spreadsheetId, async () => {
    const ctx = await readTabView(spreadsheetId, 'Networking');
    const kept = ctx.view.dataRows.filter((row) => {
      if (!isNonemptyDataRow(row)) return false;
      const name = ctx.view.key(row, 'Name');
      return !name || !myNames.has(name);
    });
    const mine = myRows.map((row) => ctx.view.rowFromSchemaValues(row));
    await writeTabView(spreadsheetId, ctx, [...kept, ...mine]);
  });
}

/**
 * Rebuild DisplayControllers rows for every sign device in the garage.
 */
export async function syncAllGarageSignsToSheet({
  customer,
  garage,
  servers = [],
}) {
  if (!garage) return;
  const spreadsheetId = await spreadsheetIdForSync(customer);
  requireSpreadsheetForWrite(spreadsheetId);
  const displayGroups = garage.displayGroups || [];
  const serverList = servers.length ? servers : (garage.servers || []);
  const signs = [];
  const seenLogical = new Set();
  for (const level of garage.levels || []) {
    for (const device of level.devices || []) {
      if (!device?.type?.startsWith('sign-')) continue;
      const names = allSignSheetDisplayNames(device);
      if (!names.length) continue;
      // Deduplicate multi-level copies of the same logical sign.
      const dedupeKey = names.map((n) => n.trim().toLowerCase()).sort().join('|');
      if (seenLogical.has(dedupeKey)) continue;
      seenLogical.add(dedupeKey);
      signs.push(device);
    }
  }

  return enqueueSync(spreadsheetId, async () => {
    if (!signs.length) return;
    const keyedRows = signs.flatMap((device) => buildDisplayControllerSheetRows(device, {
      displayGroups,
      servers: serverList,
    }));
    await upsertRowsByKey(spreadsheetId, 'DisplayControllers', 'DisplayName', keyedRows);
  });
}

/**
 * After deleting a display group (and unassigning it from signs locally),
 * rebuild DisplayControllers for all signs so cleared DisplayGroupName is written.
 * Prefer passing nextGarage with displayGroupId already cleared on devices.
 * Callers may pass groupName; it is not needed for the rebuild and is ignored.
 */
export async function clearDisplayGroupFromSignsOnSheet({
  customer,
  garage,
  servers = [],
}) {
  return syncAllGarageSignsToSheet({ customer, garage, servers });
}
