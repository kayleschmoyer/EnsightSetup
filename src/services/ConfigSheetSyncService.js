/**
 * ConfigSheetSyncService - legacy-data import from Google Sheets / Excel.
 *
 * The database (see CustomerRepository.js) is the app's source of truth now,
 * so this module no longer syncs live edits to Google Sheets config tabs.
 * What's left is the one-time import path used when opening a customer from
 * a Drive-linked spreadsheet or Excel file (SiteImporter.jsx, CustomerSelector.jsx,
 * OpenConfigFromDriveService.js) so its legacy data can be carried into the database.
 */
import {
  CONFIG_SHEET_TABS,
  CONFIG_TAB_HEADERS,
  configSheetTitle,
  formatSheetCellValue,
} from '../lib/configSheetSchema';
import { isNonemptyRow } from '../lib/sheetTabView';
import {
  createSpreadsheetInFolder,
  setupSpreadsheetTabs,
  writeTabValues,
  readTabValues,
  spreadsheetUrl,
} from './GoogleSheetsService';
import { isSignedIn, findConfigSheetInFolder, trashDriveFile, SPREADSHEET_MIME } from './GoogleDriveService';

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
  return rows.slice(1).some(isNonemptyRow);
}

export function customerSheetQuickLink(spreadsheetTitle, spreadsheetUrl) {
  return {
    id: 1,
    name: spreadsheetTitle || 'Configuration Sheet',
    url: spreadsheetUrl,
    icon: 'sheets',
  };
}
