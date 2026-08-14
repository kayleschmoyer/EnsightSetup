/**
 * fakeSheets - an in-memory Google Sheets v4 server for tests.
 *
 * This models the API semantics that actually bite us in production, not an
 * idealized key/value store. The behaviors below are the ones that turn a
 * "successful" write into corrupted data, so they are reproduced exactly:
 *
 *  1. `values.update` writes ONLY the cells supplied. A row shorter than the
 *     one currently occupying that position leaves the trailing cells intact,
 *     so they end up attached to whatever record now lives on that row.
 *  2. `values.get` trims trailing empty cells from each row and trailing empty
 *     rows from the range, so reads come back ragged.
 *  3. `valueInputOption=USER_ENTERED` reinterprets what we send: '04:00'
 *     becomes a time, '007' becomes 7, and a leading '=' / '+' / '-' becomes a
 *     formula (which for opaque data yields #ERROR!).
 *  4. `valueRenderOption=FORMATTED_VALUE` renders using the SPREADSHEET's
 *     locale (not the caller's), so it is deterministic across users.
 *
 * Cells are stored as { v, t } where t is 's' (string), 'n' (number),
 * 'b' (boolean), 'd' (date/time serial) or 'e' (error).
 */

const A1_RANGE_RE = /^(?:'((?:[^']|'')+)'|([^'!]+))!([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/;

const EMPTY = Object.freeze({ v: '', t: 's' });

function colToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Parse "'Tab Name'!A2:ZZ50" into { tab, startCol, startRow, endCol, endRow }. */
export function parseA1(range) {
  const match = A1_RANGE_RE.exec(String(range));
  if (!match) throw new Error(`fakeSheets: unable to parse range: ${range}`);
  const tab = (match[1] != null ? match[1].replace(/''/g, "'") : match[2]).trim();
  return {
    tab,
    startCol: colToIndex(match[3]),
    startRow: match[4] ? Number(match[4]) - 1 : 0,
    endCol: match[5] ? colToIndex(match[5]) : null,
    endRow: match[6] ? Number(match[6]) - 1 : null,
  };
}

function isBlankCell(cell) {
  return cell == null || cell.v === '' || cell.v == null;
}

/** Serial fraction of a day, matching how Sheets stores a bare time. */
function timeToSerial(hours, minutes, seconds = 0) {
  return (hours * 3600 + minutes * 60 + seconds) / 86400;
}

function serialToTimeString(serial) {
  const total = Math.round(serial * 86400);
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Reproduce Sheets' USER_ENTERED parsing closely enough to catch our bugs.
 * @param {unknown} raw
 * @returns {{ v: unknown, t: string }}
 */
export function coerceUserEntered(raw) {
  if (typeof raw === 'number') return { v: raw, t: 'n' };
  if (typeof raw === 'boolean') return { v: raw, t: 'b' };
  const s = raw == null ? '' : String(raw);
  if (s === '') return { v: '', t: 's' };

  const upper = s.trim().toUpperCase();
  if (upper === 'TRUE') return { v: true, t: 'b' };
  if (upper === 'FALSE') return { v: false, t: 'b' };

  // Bare times: '04:00' / '4:00:00' become a time serial, losing the literal.
  const time = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (time) {
    return {
      v: timeToSerial(Number(time[1]), Number(time[2]), Number(time[3] || 0)),
      t: 'd',
    };
  }

  // Numeric strings lose leading zeros and any grouping intent.
  if (/^-?\d+(\.\d+)?$/.test(s.trim())) return { v: Number(s.trim()), t: 'n' };

  // Formulas. Opaque payloads (base64 chunks, names) are not valid formulas.
  if (/^[=+]/.test(s) || /^-[^\d.]/.test(s)) {
    const expr = s.slice(1);
    if (/^-?\d+(\.\d+)?$/.test(expr)) {
      return { v: s[0] === '-' ? -Number(expr) : Number(expr), t: 'n' };
    }
    return { v: '#ERROR!', t: 'e' };
  }

  return { v: s, t: 's' };
}

/** RAW keeps exactly what was sent, as a string. */
export function coerceRaw(raw) {
  if (typeof raw === 'number') return { v: raw, t: 'n' };
  if (typeof raw === 'boolean') return { v: raw, t: 'b' };
  return { v: raw == null ? '' : String(raw), t: 's' };
}

function renderFormatted(cell) {
  if (isBlankCell(cell)) return '';
  switch (cell.t) {
    case 'b': return cell.v ? 'TRUE' : 'FALSE';
    case 'd': return serialToTimeString(cell.v);
    case 'n': return String(cell.v);
    case 'e': return String(cell.v);
    default: return String(cell.v);
  }
}

function renderUnformatted(cell) {
  if (isBlankCell(cell)) return '';
  return cell.v;
}

class FakeSpreadsheet {
  constructor(id, title) {
    this.id = id;
    this.title = title;
    this.nextSheetId = 1;
    /** @type {Map<string, { sheetId: number, rowCount: number, colCount: number, grid: Array }>} */
    this.tabs = new Map();
  }

  addTab(title, { rowCount = 1000, colCount = 26 } = {}) {
    if (this.tabs.has(title)) return this.tabs.get(title);
    const tab = { sheetId: this.nextSheetId++, rowCount, colCount, grid: [] };
    this.tabs.set(title, tab);
    return tab;
  }

  tabBySheetId(sheetId) {
    for (const [title, tab] of this.tabs) {
      if (tab.sheetId === sheetId) return { title, tab };
    }
    return null;
  }
}

/**
 * @param {{ failures?: Array }} [options]
 */
export function createFakeSheets(options = {}) {
  const spreadsheets = new Map();
  let nextId = 1;
  /** Queued failures: { match?: (ctx) => boolean, status, message, times } */
  const failures = [...(options.failures || [])];
  const requests = [];

  function createSpreadsheet({ title = 'Untitled', tabs = [] } = {}) {
    const id = `sheet-${nextId++}`;
    const ss = new FakeSpreadsheet(id, title);
    for (const t of tabs) ss.addTab(t);
    spreadsheets.set(id, ss);
    return ss;
  }

  function requireSpreadsheet(id) {
    const ss = spreadsheets.get(id);
    if (!ss) {
      throw apiError(404, `Requested entity was not found.`);
    }
    return ss;
  }

  function apiError(status, message, reason = '') {
    const err = new Error(message);
    err.__status = status;
    err.__body = { error: { message, status, errors: reason ? [{ reason }] : [] } };
    return err;
  }

  /** Read a rectangular window, then apply Sheets' trailing-blank trimming. */
  function readRange(ss, spec) {
    const tab = ss.tabs.get(spec.tab);
    if (!tab) {
      throw apiError(400, `Unable to parse range: '${spec.tab}'!A1`);
    }
    const endRow = spec.endRow != null ? spec.endRow : tab.grid.length - 1;
    const endCol = spec.endCol != null ? spec.endCol : tab.colCount - 1;

    const rows = [];
    for (let r = spec.startRow; r <= endRow; r += 1) {
      const source = tab.grid[r] || [];
      const row = [];
      for (let c = spec.startCol; c <= endCol; c += 1) row.push(source[c] ?? null);
      rows.push(row);
    }

    // Sheets trims trailing empty cells per row, and trailing empty rows.
    while (rows.length && rows[rows.length - 1].every(isBlankCell)) rows.pop();
    return rows.map((row) => {
      const copy = [...row];
      while (copy.length && isBlankCell(copy[copy.length - 1])) copy.pop();
      return copy;
    });
  }

  /**
   * values.update semantics: write only the cells supplied. Anything to the
   * right of a short row is left exactly as it was.
   */
  function writeValues(ss, spec, values, valueInputOption) {
    const tab = ss.tabs.get(spec.tab);
    if (!tab) throw apiError(400, `Unable to parse range: '${spec.tab}'!A1`);

    const coerce = valueInputOption === 'RAW' ? coerceRaw : coerceUserEntered;
    const lastRow = spec.startRow + values.length - 1;
    if (lastRow >= tab.rowCount) {
      throw apiError(
        400,
        `Requested writing within range ['${spec.tab}'!A1:Z${tab.rowCount}], `
        + `but tried writing to row [${lastRow + 1}]`,
      );
    }

    let updatedCells = 0;
    values.forEach((row, i) => {
      const r = spec.startRow + i;
      if (!tab.grid[r]) tab.grid[r] = [];
      row.forEach((value, j) => {
        tab.grid[r][spec.startCol + j] = coerce(value);
        updatedCells += 1;
      });
    });
    return { updatedCells, updatedRows: values.length };
  }

  function clearRange(ss, spec) {
    const tab = ss.tabs.get(spec.tab);
    if (!tab) throw apiError(400, `Unable to parse range: '${spec.tab}'!A1`);
    const endRow = spec.endRow != null ? spec.endRow : tab.grid.length - 1;
    const endCol = spec.endCol != null ? spec.endCol : tab.colCount - 1;
    for (let r = spec.startRow; r <= endRow; r += 1) {
      if (!tab.grid[r]) continue;
      for (let c = spec.startCol; c <= endCol; c += 1) tab.grid[r][c] = null;
    }
  }

  function applyBatchUpdate(ss, body) {
    for (const request of body.requests || []) {
      if (request.addSheet) {
        const title = request.addSheet.properties?.title;
        if (ss.tabs.has(title)) throw apiError(400, `A sheet with the name "${title}" already exists.`);
        ss.addTab(title);
        continue;
      }
      if (request.deleteSheet) {
        const found = ss.tabBySheetId(request.deleteSheet.sheetId);
        if (!found) throw apiError(400, 'No sheet with the given ID.');
        ss.tabs.delete(found.title);
        continue;
      }
      if (request.updateSheetProperties) {
        const { properties, fields } = request.updateSheetProperties;
        const found = ss.tabBySheetId(properties.sheetId);
        if (!found) throw apiError(400, 'No sheet with the given ID.');
        if (fields?.includes('title') && properties.title) {
          if (ss.tabs.has(properties.title) && properties.title !== found.title) {
            throw apiError(400, `A sheet with the name "${properties.title}" already exists.`);
          }
          ss.tabs.delete(found.title);
          ss.tabs.set(properties.title, found.tab);
        }
        if (fields?.includes('gridProperties.rowCount') && properties.gridProperties?.rowCount) {
          found.tab.rowCount = properties.gridProperties.rowCount;
        }
        continue;
      }
      throw apiError(400, `fakeSheets: unsupported request ${Object.keys(request)[0]}`);
    }
  }

  /** Pop a queued failure matching this request, if any. */
  function nextFailure(ctx) {
    for (let i = 0; i < failures.length; i += 1) {
      const f = failures[i];
      if (f.match && !f.match(ctx)) continue;
      f.times = (f.times ?? 1) - 1;
      if (f.times <= 0) failures.splice(i, 1);
      return f;
    }
    return null;
  }

  function jsonResponse(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  /** Drop-in replacement for GoogleDriveService.fetchWithTimeout. */
  async function fetchWithTimeout(url, init = {}) {
    const parsed = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    const method = (init.method || 'GET').toUpperCase();
    const ctx = { url, method, path: parsed.pathname, body, search: parsed.searchParams };
    requests.push(ctx);

    const failure = nextFailure(ctx);
    if (failure) {
      return jsonResponse(failure.status, {
        error: {
          message: failure.message || 'Injected failure',
          status: failure.status,
          errors: failure.reason ? [{ reason: failure.reason }] : [],
        },
      });
    }

    try {
      return jsonResponse(200, route(ctx));
    } catch (err) {
      if (err.__status) return jsonResponse(err.__status, err.__body);
      throw err;
    }
  }

  function route(ctx) {
    const m = /^\/v4\/spreadsheets\/([^/:]+)(?::(\w+))?(?:\/values(?::(\w+))?\/?(.*))?$/
      .exec(ctx.path);
    if (!m) throw apiError(404, `fakeSheets: unrouted path ${ctx.path}`);

    const spreadsheetId = decodeURIComponent(m[1]);
    const spreadsheetVerb = m[2];
    const valuesVerb = m[3];
    const tail = m[4] ? decodeURIComponent(m[4]) : '';
    const ss = requireSpreadsheet(spreadsheetId);

    if (spreadsheetVerb === 'batchUpdate') {
      applyBatchUpdate(ss, ctx.body);
      return { spreadsheetId, replies: [] };
    }

    if (valuesVerb === 'batchGet') {
      const ranges = ctx.search.getAll('ranges');
      return {
        spreadsheetId,
        valueRanges: ranges.map((range) => renderRange(ss, range, ctx)),
      };
    }

    if (valuesVerb === 'batchUpdate') {
      const option = ctx.body?.valueInputOption || 'USER_ENTERED';
      for (const entry of ctx.body?.data || []) {
        writeValues(ss, parseA1(entry.range), entry.values, option);
      }
      return { spreadsheetId, totalUpdatedCells: 0 };
    }

    if (tail) {
      const clearMatch = /^(.*):clear$/.exec(tail);
      if (clearMatch || ctx.path.endsWith(':clear')) {
        clearRange(ss, parseA1(clearMatch ? clearMatch[1] : tail));
        return { spreadsheetId };
      }
      if (ctx.method === 'PUT') {
        const option = ctx.search.get('valueInputOption') || 'USER_ENTERED';
        const result = writeValues(ss, parseA1(tail), ctx.body.values, option);
        return { spreadsheetId, ...result };
      }
      return renderRange(ss, tail, ctx);
    }

    // spreadsheets.get
    return {
      spreadsheetId,
      properties: { title: ss.title },
      sheets: [...ss.tabs.entries()].map(([title, tab]) => ({
        properties: {
          sheetId: tab.sheetId,
          title,
          gridProperties: { rowCount: tab.rowCount, columnCount: tab.colCount },
        },
      })),
    };
  }

  function renderRange(ss, range, ctx) {
    const spec = parseA1(range);
    const option = ctx.search.get('valueRenderOption') || 'FORMATTED_VALUE';
    const render = option === 'FORMATTED_VALUE' ? renderFormatted : renderUnformatted;
    const rows = readRange(ss, spec);
    const values = rows.map((row) => row.map(render));
    return values.length ? { range, majorDimension: 'ROWS', values } : { range, majorDimension: 'ROWS' };
  }

  return {
    fetchWithTimeout,
    createSpreadsheet,
    getSpreadsheet: (id) => spreadsheets.get(id),
    /** Raw grid for assertions: 2D array of rendered strings, untrimmed. */
    dumpTab(id, tabName, { render = renderFormatted } = {}) {
      const tab = requireSpreadsheet(id).tabs.get(tabName);
      if (!tab) return null;
      const width = tab.grid.reduce((w, row) => Math.max(w, row?.length || 0), 0);
      return tab.grid.map((row) => {
        const out = [];
        for (let c = 0; c < width; c += 1) out.push(render(row?.[c] ?? EMPTY));
        return out;
      });
    },
    tabNames: (id) => [...requireSpreadsheet(id).tabs.keys()],
    failNext(failure) { failures.push(failure); },
    requests,
    reset() { spreadsheets.clear(); requests.length = 0; failures.length = 0; },
  };
}
