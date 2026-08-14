import { describe, expect, it } from 'vitest';
import {
  MAX_WRITE_REQUEST_BYTES,
  isGridTooSmallError,
  isMissingSheetTabError,
  splitRowBatches,
} from './GoogleSheetsService';

describe('splitRowBatches', () => {
  it('keeps small datasets in a single request', () => {
    const rows = [['a', 'b'], ['c', 'd'], ['e', 'f']];
    expect(splitRowBatches(rows)).toEqual([rows]);
  });

  it('splits once the serialized rows exceed the budget', () => {
    const rows = Array.from({ length: 10 }, (_, i) => [i, 'x'.repeat(100)]);
    const batches = splitRowBatches(rows, 300);

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(rows);
    for (const batch of batches) {
      const bytes = batch.reduce((sum, row) => sum + JSON.stringify(row).length + 1, 0);
      // Only a batch of one row is allowed to exceed the budget.
      expect(bytes <= 300 || batch.length === 1).toBe(true);
    }
  });

  it('gives a single oversized row its own batch', () => {
    const huge = ['x'.repeat(1000)];
    const batches = splitRowBatches([['small'], huge, ['small']], 100);

    expect(batches).toEqual([[['small']], [huge], [['small']]]);
  });

  it('returns nothing for an empty dataset', () => {
    expect(splitRowBatches([])).toEqual([]);
  });

  it('stays well under the Sheets API 10 MB request limit by default', () => {
    expect(MAX_WRITE_REQUEST_BYTES).toBeLessThan(10 * 1024 * 1024);
  });
});

describe('sheet error classification', () => {
  it('recognizes a missing tab', () => {
    expect(isMissingSheetTabError("Unable to parse range: 'SetupJson'!A1")).toBe(true);
    expect(isMissingSheetTabError('Internal error')).toBe(false);
  });

  it('recognizes a grid that is too short for the write', () => {
    expect(isGridTooSmallError(
      "Requested writing within range ['SetupJson'!A1:C1000], but tried writing to row [1001]",
    )).toBe(true);
    expect(isGridTooSmallError('Range exceeds grid limits')).toBe(true);
    expect(isGridTooSmallError('Session expired. Please sign in again.')).toBe(false);
  });
});
