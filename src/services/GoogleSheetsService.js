/**
 * GoogleSheetsService - Native Google Sheets API operations, using the signed-in
 * user's browser OAuth token (see GoogleDriveService.js).
 *
 * Supabase is the app's source of truth now, and the "Export to Sheets" feature
 * runs server-side with its own Google service-account auth (api/export-to-sheets.js
 * talks to the Sheets/Drive REST APIs directly, not through this module, since it
 * needs a Node-safe client with no import.meta.env). What's left here is what the
 * optional/deferred "import a customer from an old Drive-linked spreadsheet" admin
 * flow (OpenConfigFromDriveService.js) still needs to read that old spreadsheet.
 */
import {
  getAccessToken,
  getFileMetadata,
  hadGoogleSession,
  isSignedIn,
  refreshAccessTokenSilently,
  fetchWithTimeout,
  invalidateGoogleAccessToken,
  SPREADSHEET_MIME,
} from './GoogleDriveService';

const SHARED_FOLDER_ID = import.meta.env.VITE_GOOGLE_SHARED_FOLDER_ID || '';

function assertConfig() {
  if (!SHARED_FOLDER_ID) {
    throw new Error('Google Drive folder is not configured. Set VITE_GOOGLE_SHARED_FOLDER_ID in your environment.');
  }
}

function parseSheetsApiError(status, errBody) {
  const msg = errBody?.error?.message || '';
  const reason = errBody?.error?.errors?.[0]?.reason || '';

  if (status === 403) {
    if (/has not been used|is disabled/i.test(msg)) {
      const projectMatch = msg.match(/project\s+(\d+)/i);
      const projectId = projectMatch?.[1];
      const enableUrl = projectId
        ? `https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=${projectId}`
        : 'https://console.cloud.google.com/apis/library/sheets.googleapis.com';
      return (
        'Google Sheets API is not enabled for your OAuth project. ' +
        `Enable it here: ${enableUrl} ` +
        'Then wait 1–2 minutes and try again.'
      );
    }
    if (
      reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'
      || /insufficient.*(authentication )?scopes/i.test(msg)
    ) {
      return (
        'Google sign-in is missing permissions needed for Excel configs (create Sheet copy). ' +
        'Sign out, remove EnSight Technologies at myaccount.google.com/permissions, ' +
        'sign in again, and approve all Drive and Sheets access.'
      );
    }
    if (reason === 'insufficientPermissions' || /permission|forbidden/i.test(msg)) {
      return (
        'Google Sheets access was denied. Sign out, sign in again, and approve Drive/Sheets permissions.'
      );
    }
    return msg || 'Google Sheets access denied (403).';
  }

  if (status === 401) {
    return 'Session expired. Please sign in again.';
  }

  if (status === 429 || /quota exceeded/i.test(msg)) {
    return 'Google Sheets rate limit reached. Your changes are saved in the app — try syncing again in about a minute.';
  }

  if (status === 503) {
    return 'Google Sheets is temporarily unavailable. Your changes are saved in the app — try again in a moment.';
  }

  if (status === 413 || /payload size exceeds/i.test(msg)) {
    return (
      'This setup is too large for a single Google Sheets write. '
      + 'Remove or re-upload the largest floor-plan backgrounds and try again.'
    );
  }

  if (status === 400 && /unable to parse range|not found|does not exist/i.test(msg)) {
    // Google reports a missing tab as e.g. "Unable to parse range: 'Garages'!A1".
    const tabMatch = msg.match(/unable to parse range:?\s*'?([^'!]+?)'?!/i);
    const tabName = tabMatch?.[1]?.trim();
    return tabName
      ? `The "${tabName}" tab is missing on the linked Google Sheet.`
      : 'A required tab is missing on the linked Google Sheet.';
  }

  return msg || `Google Sheets API error (${status})`;
}

export function isMissingSheetTabError(message) {
  return /unable to parse range|not found|does not exist|tab is missing on the linked/i
    .test(String(message || ''));
}

/** Sheets rejects writes past a tab's allocated grid instead of growing it. */
export function isGridTooSmallError(message) {
  return /exceeds grid limits|tried writing to row|above the grid limits/i
    .test(String(message || ''));
}

/**
 * Google rejects any single Sheets API request over 10 MB. SetupJson carries
 * base64 floor-plan backgrounds, so a customer with several levels can blow
 * past that in one write — split the rows into requests well under the cap.
 */
export const MAX_WRITE_REQUEST_BYTES = 4 * 1024 * 1024;

/**
 * Group rows into batches whose serialized size stays under maxBytes.
 * A single row larger than the budget still gets its own batch.
 * @param {any[][]} values
 * @param {number} [maxBytes]
 * @returns {any[][][]}
 */
export function splitRowBatches(values, maxBytes = MAX_WRITE_REQUEST_BYTES) {
  const batches = [];
  let current = [];
  let currentBytes = 0;

  for (const row of values) {
    const rowBytes = JSON.stringify(row ?? []).length + 1;
    if (current.length && currentBytes + rowBytes > maxBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(row);
    currentBytes += rowBytes;
  }

  if (current.length) batches.push(current);
  return batches;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Widest row in a 2D array. */
export function valuesWidth(values) {
  return (values || []).reduce((max, row) => Math.max(max, row?.length ?? 0), 0);
}

/**
 * Pad every row to the same width.
 *
 * Both directions of the Sheets API make this necessary. On read, Sheets trims
 * trailing empty cells so rows arrive ragged, and callers index by column. On
 * write, `values.update` only touches the cells supplied — a row shorter than
 * the one currently in that position leaves the trailing cells intact, so they
 * end up attached to whichever record shifted into the row. Padding with ''
 * makes every write clear the full row.
 *
 * @param {any[][]} values
 * @param {number} [width] - defaults to the widest row
 * @returns {any[][]}
 */
export function rectangularize(values, width = valuesWidth(values)) {
  if (!values?.length) return [];
  return values.map((row) => {
    const source = row || [];
    if (source.length === width) return source;
    const padded = new Array(width);
    for (let i = 0; i < width; i += 1) padded[i] = source[i] ?? '';
    return padded;
  });
}

function isRetryableSheetsError(status, errBody) {
  const msg = errBody?.error?.message || '';
  return status === 429 || status === 503 || /quota exceeded/i.test(msg);
}

async function resolveAccessToken() {
  if (isSignedIn()) return getAccessToken();
  if (hadGoogleSession()) {
    try {
      await refreshAccessTokenSilently();
      return getAccessToken();
    } catch {
      // Fall through to the standard not-signed-in error.
    }
  }
  return getAccessToken();
}

async function sheetsFetch(path, options = {}, attempt = 0, refreshed = false) {
  const token = await resolveAccessToken();
  const { signal, ...fetchOptions } = options;
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  const response = await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets${path}`, {
    ...fetchOptions,
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(fetchOptions.headers || {}),
    },
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    if (response.status === 401) {
      // A token can expire part-way through a multi-request write. Invalidating
      // immediately failed every queued sync for every spreadsheet, turning one
      // expiry into a wave of errors. Try a silent refresh once first.
      if (!refreshed && hadGoogleSession()) {
        invalidateGoogleAccessToken();
        try {
          await refreshAccessTokenSilently();
          return sheetsFetch(path, options, attempt, true);
        } catch {
          // Fall through — the session really is gone.
        }
      } else {
        invalidateGoogleAccessToken();
      }
      throw new Error(parseSheetsApiError(response.status, err));
    }
    if (isRetryableSheetsError(response.status, err) && attempt < 4) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      // Jitter: without it, every tab that hit the same rate limit retries in
      // lockstep and trips it again.
      const base = Math.min(30000, 1000 * (2 ** attempt));
      await sleep(base / 2 + Math.random() * (base / 2));
      return sheetsFetch(path, options, attempt + 1, refreshed);
    }
    throw new Error(parseSheetsApiError(response.status, err));
  }

  if (response.status === 204) return null;
  return response.json();
}

async function driveFetch(path, options = {}) {
  const token = await resolveAccessToken();
  const { signal, ...fetchOptions } = options;
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  const response = await fetchWithTimeout(`https://www.googleapis.com/drive/v3${path}`, {
    ...fetchOptions,
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(fetchOptions.headers || {}),
    },
  });

  if (response.status === 401) {
    invalidateGoogleAccessToken();
    throw new Error('Session expired. Please sign in again.');
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const msg = err.error?.message || `Google Drive API error (${response.status})`;
    const reason = err.error?.errors?.[0]?.reason || '';
    if (
      response.status === 403
      && (reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'
        || /insufficient.*(authentication )?scopes/i.test(msg))
    ) {
      throw new Error(parseSheetsApiError(response.status, err));
    }
    throw new Error(msg);
  }

  if (response.status === 204) return null;
  return response.json();
}

/** URL to open a spreadsheet in the browser. */
export function spreadsheetUrl(spreadsheetId) {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

/**
 * Create a native Google Spreadsheet in the shared folder.
 * @param {string} title
 * @returns {Promise<{ spreadsheetId: string, spreadsheetUrl: string }>}
 */
export async function createSpreadsheetInFolder(title) {
  assertConfig();
  const safeTitle = String(title || 'config').trim().slice(0, 200) || 'config';

  const metadata = await driveFetch('/files?supportsAllDrives=true&fields=id,name,webViewLink', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: safeTitle,
      mimeType: SPREADSHEET_MIME,
      parents: [SHARED_FOLDER_ID],
    }),
  });

  return {
    spreadsheetId: metadata.id,
    spreadsheetUrl: metadata.webViewLink || spreadsheetUrl(metadata.id),
  };
}

/**
 * Get spreadsheet metadata including sheet IDs.
 * @param {string} spreadsheetId
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function getSpreadsheet(spreadsheetId, options = {}) {
  return sheetsFetch(
    `/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties`,
    { signal: options.signal },
  );
}

/**
 * Ensure spreadsheet has the requested tabs. Idempotent: only renames a default
 * Sheet1 (when needed) and adds tabs that are missing.
 * @param {string} spreadsheetId
 * @param {string[]} tabNames - ordered tab names
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function setupSpreadsheetTabs(spreadsheetId, tabNames, options = {}) {
  if (!tabNames?.length) return;
  const meta = await getSpreadsheet(spreadsheetId, options);
  const existing = meta.sheets || [];
  const existingTitles = new Set(
    existing.map((s) => s.properties?.title).filter(Boolean),
  );
  const requests = [];

  if (!existingTitles.has(tabNames[0]) && existing.length > 0) {
    const renameCandidate =
      existing.find((s) => /^Sheet\d+$/i.test(String(s.properties?.title || '')))
      || (!tabNames.includes(existing[0]?.properties?.title) ? existing[0] : null);
    if (renameCandidate?.properties?.sheetId != null) {
      requests.push({
        updateSheetProperties: {
          properties: {
            sheetId: renameCandidate.properties.sheetId,
            title: tabNames[0],
          },
          fields: 'title',
        },
      });
      existingTitles.delete(renameCandidate.properties?.title);
      existingTitles.add(tabNames[0]);
    }
  }

  for (const title of tabNames) {
    if (existingTitles.has(title)) continue;
    requests.push({ addSheet: { properties: { title } } });
    existingTitles.add(title);
  }

  if (requests.length === 0) return;

  await sheetsFetch(`/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests }),
    signal: options.signal,
  });
}

/**
 * Ensure a tab exists on the spreadsheet, adding it if missing.
 * @param {string} spreadsheetId
 * @param {string} tabName
 */
export async function ensureSpreadsheetTab(spreadsheetId, tabName) {
  const meta = await getSpreadsheet(spreadsheetId);
  const exists = (meta.sheets || []).some((s) => s.properties?.title === tabName);
  if (exists) return;
  await sheetsFetch(`/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: tabName } } }],
    }),
  });
}

/**
 * Grow a tab so it can hold at least rowCount rows.
 * @param {string} spreadsheetId
 * @param {string} tabName
 * @param {number} rowCount
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function ensureTabRowCount(spreadsheetId, tabName, rowCount, options = {}) {
  const meta = await getSpreadsheet(spreadsheetId, options);
  const sheet = (meta.sheets || []).find((s) => s.properties?.title === tabName);
  const sheetId = sheet?.properties?.sheetId;
  if (sheetId == null) return;
  const currentRows = sheet.properties?.gridProperties?.rowCount ?? 0;
  if (currentRows >= rowCount) return;

  await sheetsFetch(`/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { rowCount } },
          fields: 'gridProperties.rowCount',
        },
      }],
    }),
    signal: options.signal,
  });
}

/**
 * Write a 2D array to a tab starting at A1 (overwrites existing cells in range).
 * Large datasets are split across several requests so no single request trips
 * the Sheets API payload limit.
 * @param {string} spreadsheetId
 * @param {string} tabName
 * @param {any[][]} values
 * @param {{ signal?: AbortSignal, valueInputOption?: 'USER_ENTERED' | 'RAW' }} [options]
 *   RAW is the default and the only safe option for config data. USER_ENTERED
 *   asks Sheets to reinterpret every cell: '04:00' becomes a time serial, '007'
 *   becomes 7, and anything starting with =, +, or - becomes a formula (usually
 *   #ERROR!). Under RAW the type is decided by what we send — a JS number is
 *   stored as a number so humans can still sort and sum the column, and a
 *   string is stored verbatim. Pass USER_ENTERED only to write real formulas.
 */
export async function writeTabValues(spreadsheetId, tabName, values, options = {}) {
  if (!values?.length) return;
  const escapedTab = tabName.replace(/'/g, "''");
  const valueInputOption = options.valueInputOption === 'USER_ENTERED' ? 'USER_ENTERED' : 'RAW';
  // A short row would leave the previous occupant's trailing cells in place.
  values = rectangularize(values);

  const writeBatch = (batch, startRow) => {
    const range = `'${escapedTab}'!A${startRow}`;
    return sheetsFetch(`/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=${valueInputOption}`, {
      method: 'PUT',
      body: JSON.stringify({
        range,
        majorDimension: 'ROWS',
        values: batch,
      }),
      signal: options.signal,
    });
  };

  let startRow = 1;
  for (const batch of splitRowBatches(values)) {
    try {
      await writeBatch(batch, startRow);
    } catch (err) {
      // Self-heal: recreate a tab that was deleted/renamed on the Sheet, or grow
      // one whose grid is too short for a long SetupJson, then retry once.
      if (isMissingSheetTabError(err?.message)) {
        await ensureSpreadsheetTab(spreadsheetId, tabName);
      } else if (isGridTooSmallError(err?.message)) {
        await ensureTabRowCount(spreadsheetId, tabName, values.length, options);
      } else {
        throw err;
      }
      await writeBatch(batch, startRow);
    }
    startRow += batch.length;
  }
}

/**
 * Read all values from a tab (header + data rows), padded to a rectangle.
 *
 * FORMATTED_VALUE is deliberate: it renders using the spreadsheet's own locale
 * (not the caller's), so every user reads identical strings, and it is the only
 * render option that can recover a legacy cell Sheets already coerced — a time
 * written before RAW reads back as '4:00:00' rather than the serial 0.1666….
 */
export async function readTabValues(spreadsheetId, tabName) {
  const range = `'${tabName.replace(/'/g, "''")}'!A:ZZ`;
  try {
    const data = await sheetsFetch(
      `/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
    );
    return rectangularize(data.values || []);
  } catch (err) {
    if (isMissingSheetTabError(err?.message)) return [];
    throw err;
  }
}

/**
 * Clear a single row by zeroing cell contents (keeps row structure).
 */
export async function clearRow(spreadsheetId, tabName, rowNumber) {
  const range = `'${tabName.replace(/'/g, "''")}'!A${rowNumber}:ZZ${rowNumber}`;
  await sheetsFetch(`/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:clear`, {
    method: 'POST',
    body: '{}',
  });
}

/**
 * Clear a contiguous row range (inclusive).
 */
export async function clearRowRange(spreadsheetId, tabName, startRow, endRow) {
  if (startRow > endRow) return;
  const range = `'${tabName.replace(/'/g, "''")}'!A${startRow}:ZZ${endRow}`;
  await sheetsFetch(`/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:clear`, {
    method: 'POST',
    body: '{}',
  });
}

/** Convert a 0-based column index to A1 letters (0 → A, 26 → AA). */
export function columnLetters(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * Clear every column from startColumn (0-based) rightwards, for rows 1..endRow.
 */
export async function clearColumnsFrom(spreadsheetId, tabName, startColumn, endRow) {
  if (startColumn < 0 || endRow < 1) return;
  const range = `'${tabName.replace(/'/g, "''")}'!${columnLetters(startColumn)}1:ZZ${endRow}`;
  await sheetsFetch(`/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:clear`, {
    method: 'POST',
    body: '{}',
  });
}

/**
 * Replace tab contents, clearing anything the new dataset does not cover —
 * both rows below it and columns to the right of it. Without the column clear,
 * shrinking a tab leaves a band of orphaned cells that reads back as real data.
 *
 * Pass previousRowCount / previousColumnCount when the caller already read the
 * tab, to avoid a duplicate API read.
 * @param {{ previousRowCount?: number, previousColumnCount?: number,
 *           signal?: AbortSignal, valueInputOption?: 'USER_ENTERED' | 'RAW' }} [options]
 */
export async function replaceTabValues(spreadsheetId, tabName, values, options = {}) {
  if (!values?.length) return;
  let previousCount = options.previousRowCount;
  let previousWidth = options.previousColumnCount;
  if (previousCount == null || previousWidth == null) {
    const previousRows = await readTabValues(spreadsheetId, tabName);
    if (previousCount == null) previousCount = previousRows.length;
    if (previousWidth == null) previousWidth = valuesWidth(previousRows);
  }

  const width = valuesWidth(values);
  await writeTabValues(spreadsheetId, tabName, values, options);

  if (values.length < previousCount) {
    await clearRowRange(spreadsheetId, tabName, values.length + 1, previousCount);
  }
  if (width < previousWidth) {
    await clearColumnsFrom(spreadsheetId, tabName, width, Math.max(values.length, previousCount));
  }
}

/**
 * Read several tabs in one request.
 *
 * A full-sheet resync touches eleven tabs; one round-trip each is the
 * difference between a comfortable margin under the read quota and sitting on
 * top of it.
 * @param {string} spreadsheetId
 * @param {string[]} tabNames
 * @returns {Promise<Record<string, any[][]>>} rectangular rows keyed by tab name
 */
export async function readTabsValues(spreadsheetId, tabNames, options = {}) {
  const names = [...new Set((tabNames || []).filter(Boolean))];
  if (!names.length) return { values: {}, missing: [] };

  const batchGet = async (wanted) => {
    const query = wanted
      .map((tab) => `ranges=${encodeURIComponent(`'${tab.replace(/'/g, "''")}'!A:ZZ`)}`)
      .join('&');
    return sheetsFetch(
      `/${encodeURIComponent(spreadsheetId)}/values:batchGet?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE&${query}`,
      { signal: options.signal },
    );
  };

  const collect = (data, wanted) => {
    const out = {};
    for (const name of names) out[name] = [];
    (data.valueRanges || []).forEach((range, i) => {
      out[wanted[i]] = rectangularize(range?.values || []);
    });
    return out;
  };

  try {
    return { values: collect(await batchGet(names), names), missing: [] };
  } catch (err) {
    // batchGet fails the WHOLE request when any single range names a sheet that
    // does not exist — it does not skip the missing one and return the rest.
    // Real sheets predate the schema and are routinely short a tab, so asking
    // blindly took every other tab's read down with it. Only pay for the
    // metadata lookup on the sheets that actually need it: a healthy sheet
    // stays at one request, which is what keeps a no-op save cheap.
    if (!isMissingSheetTabError(err?.message)) throw err;

    const meta = await getSpreadsheet(spreadsheetId, options);
    const existing = new Set(
      (meta.sheets || []).map((s) => s.properties?.title).filter(Boolean),
    );
    const present = names.filter((name) => existing.has(name));
    const missing = names.filter((name) => !existing.has(name));

    if (!present.length) {
      const out = {};
      for (const name of names) out[name] = [];
      return { values: out, missing };
    }
    return { values: collect(await batchGet(present), present), missing };
  }
}

/** Read a specific A1 range (cheap targeted read, e.g. a metadata row). */
export async function readRangeValues(spreadsheetId, range) {
  try {
    const data = await sheetsFetch(
      `/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
    );
    return data.values || [];
  } catch (err) {
    if (isMissingSheetTabError(err?.message)) return [];
    throw err;
  }
}

/** Delete a tab if it exists. */
export async function deleteSpreadsheetTab(spreadsheetId, tabName, options = {}) {
  const meta = await getSpreadsheet(spreadsheetId, options);
  const sheet = (meta.sheets || []).find((s) => s.properties?.title === tabName);
  const sheetId = sheet?.properties?.sheetId;
  if (sheetId == null) return false;
  await sheetsFetch(`/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: [{ deleteSheet: { sheetId } }] }),
    signal: options.signal,
  });
  return true;
}

/**
 * Resolve spreadsheet ID from customer fields.
 * Accepts native spreadsheet mimeType on sourceFileId or spreadsheetId.
 */
export async function resolveSpreadsheetId({
  spreadsheetId,
  sourceFileId,
}) {
  if (spreadsheetId) return spreadsheetId;
  if (!sourceFileId) {
    throw new Error('No configuration sheet linked to this customer. Create or import a config sheet first.');
  }

  const meta = await getFileMetadata(sourceFileId, 'id,name,mimeType,parents,webViewLink');
  if (meta.mimeType === SPREADSHEET_MIME) {
    return meta.id;
  }

  // Excel (.xlsx) on Drive is linked for import/read; Sheets API sync is not available.
  return null;
}
