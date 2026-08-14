/**
 * sheetTabView - address config tab columns by header NAME, not position.
 *
 * The sync helpers used to read and write fixed column indices (row[0], row[4],
 * row[9], row[11]) while building row content in the order of
 * CONFIG_TAB_HEADERS. That is only correct while the sheet's columns exactly
 * match the schema. People do edit these tabs by hand, and the moment someone
 * inserts, removes or reorders a column, every later write lands in the wrong
 * one — silently, because the header row itself was preserved.
 *
 * A view resolves the sheet's actual header row to indices once, then:
 *   - reads and writes cells by name,
 *   - preserves any column the schema does not know about, so a column someone
 *     added by hand survives a rewrite instead of being blanked,
 *   - reports schema columns the sheet is missing, so a caller can refuse to
 *     write rather than guess.
 */
import { CONFIG_TAB_HEADERS } from './configSheetSchema';

/** Header text differing only by case or surrounding whitespace is the same column. */
export function normalizeHeaderName(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * @param {string} tabName
 * @param {any[][]} rows - as returned by readTabValues (row 0 is the header)
 * @returns {object} view
 */
export function buildTabView(tabName, rows) {
  const schema = CONFIG_TAB_HEADERS[tabName] || [];
  const hasSheetHeader = Boolean(rows?.[0]?.some((cell) => String(cell ?? '').trim() !== ''));
  const header = hasSheetHeader ? [...rows[0]] : [...schema];

  const indexByName = new Map();
  header.forEach((name, i) => {
    const key = normalizeHeaderName(name);
    // First occurrence wins, so a duplicated header cannot silently retarget.
    if (key && !indexByName.has(key)) indexByName.set(key, i);
  });

  // Schema columns the sheet lacks are appended rather than assumed present —
  // that keeps a sheet missing a column usable instead of writing into the
  // wrong one, and the next write repairs the header.
  const missingHeaders = [];
  for (const name of schema) {
    const key = normalizeHeaderName(name);
    if (indexByName.has(key)) continue;
    missingHeaders.push(name);
    indexByName.set(key, header.length);
    header.push(name);
  }

  const width = header.length;

  const indexOf = (name) => {
    const i = indexByName.get(normalizeHeaderName(name));
    return i == null ? -1 : i;
  };

  const blankRow = () => new Array(width).fill('');

  const dataRows = (rows || []).slice(1).map((row) => {
    const out = blankRow();
    for (let i = 0; i < Math.min(row?.length ?? 0, width); i += 1) out[i] = row[i] ?? '';
    return out;
  });

  return {
    tabName,
    header,
    width,
    dataRows,
    missingHeaders,
    indexOf,
    blankRow,

    /** Cell value by header name ('' when the column is absent). */
    get(row, name) {
      const i = indexOf(name);
      return i === -1 ? '' : (row?.[i] ?? '');
    },

    /** Normalized comparison key for a cell — how every row lookup is keyed. */
    key(row, name) {
      return String(this.get(row, name) ?? '').trim().toLowerCase();
    },

    /**
     * Place schema-ordered values into the sheet's actual column layout.
     * Any column the schema does not cover is carried over from `existingRow`,
     * so hand-added columns survive a rewrite of the row.
     * @param {any[]} values - in CONFIG_TAB_HEADERS[tabName] order
     * @param {any[]} [existingRow]
     */
    rowFromSchemaValues(values, existingRow = null) {
      const out = existingRow ? [...existingRow] : blankRow();
      while (out.length < width) out.push('');
      schema.forEach((name, i) => {
        const target = indexOf(name);
        if (target !== -1) out[target] = values[i] ?? '';
      });
      return out.slice(0, width);
    },

    /** Rows plus header, ready for replaceTabValues. */
    toValues(nextDataRows) {
      return [header, ...nextDataRows.map((row) => {
        const out = [...row];
        while (out.length < width) out.push('');
        return out.slice(0, width);
      })];
    },
  };
}

/** True when any cell in the row holds something. */
export function isNonemptyRow(row) {
  return Boolean(row?.some((cell) => String(cell ?? '').trim() !== ''));
}
