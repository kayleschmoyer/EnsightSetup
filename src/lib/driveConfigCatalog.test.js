import { describe, expect, it } from 'vitest';
import {
  mergeConfigFilesIntoCatalog,
  findLocalCustomerForCatalogRow,
  findLocalOrphanCustomers,
  buildCustomerListRows,
  buildConfigFileAppProperties,
  configFileMetaFromAppProperties,
} from './driveConfigCatalog';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SHEET = 'application/vnd.google-apps.spreadsheet';

describe('mergeConfigFilesIntoCatalog', () => {
  it('prefers the Google Sheet when both exist for the same stem', () => {
    const rows = mergeConfigFilesIntoCatalog([
      { id: 'x1', name: 'Visionary Garage.xlsx', mimeType: XLSX },
      { id: 's1', name: 'Visionary Garage-config', mimeType: SHEET },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].file.id).toBe('s1');
    expect(rows[0].isNativeSheet).toBe(true);
    expect(rows[0].sourceXlsxFile.id).toBe('x1');
    expect(rows[0].key).toBe('visionary-garage');
  });

  it('keeps xlsx-only rows without a sheet', () => {
    const rows = mergeConfigFilesIntoCatalog([
      { id: 'x1', name: 'Newport News.xlsx', mimeType: XLSX },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].isNativeSheet).toBe(false);
    expect(rows[0].file.id).toBe('x1');
  });
});

describe('local matching / orphans', () => {
  it('matches local customers by spreadsheetId, or by customerId only when unlinked', () => {
    const catalog = mergeConfigFilesIntoCatalog([
      { id: 's1', name: 'SHC-config', mimeType: SHEET },
    ]);
    const bySheet = findLocalCustomerForCatalogRow(
      [{ id: 1, customerId: 'other', spreadsheetId: 's1' }],
      catalog[0],
    );
    expect(bySheet.id).toBe(1);

    const byKey = findLocalCustomerForCatalogRow(
      [{ id: 2, customerId: 'shc' }],
      catalog[0],
    );
    expect(byKey.id).toBe(2);

    const conflicting = findLocalCustomerForCatalogRow(
      [{ id: 3, customerId: 'shc', spreadsheetId: 'other-sheet' }],
      catalog[0],
    );
    expect(conflicting).toBeNull();
  });

  it('records same-stem duplicate files', () => {
    const rows = mergeConfigFilesIntoCatalog([
      { id: 's1', name: 'Fresno-config', mimeType: SHEET },
      { id: 's2', name: 'Fresno', mimeType: SHEET },
      { id: 'x1', name: 'Fresno-Config.xlsx', mimeType: XLSX },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].isNativeSheet).toBe(true);
    expect(rows[0].sourceXlsxFile.id).toBe('x1');
    expect(rows[0].duplicateFiles.map((f) => f.id)).toContain('s2');
  });

  it('keeps local orphans not present in Drive catalog', () => {
    const catalog = mergeConfigFilesIntoCatalog([
      { id: 's1', name: 'SHC-config', mimeType: SHEET },
    ]);
    const orphans = findLocalOrphanCustomers([
      { id: 1, customerId: 'shc', spreadsheetId: 's1' },
      { id: 2, customerId: 'local-only', friendlyName: 'Local Only' },
    ], catalog);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].customerId).toBe('local-only');
  });

  it('round-trips shared catalog metadata through appProperties', () => {
    const customer = {
      config: { support: { enterpriseSite: true, support24Hour: false } },
      sites: [
        { levels: [{ devices: [{}, {}] }, { devices: [{}] }] },
      ],
    };
    const props = buildConfigFileAppProperties(customer, '2026-07-23T21:00:00.000Z');
    expect(props.gleEnterprise).toBe('true');
    expect(props.gleSupport24h).toBe('false');

    const meta = configFileMetaFromAppProperties(props);
    expect(meta).toEqual({
      enterpriseSite: true,
      support24Hour: false,
      siteCount: 1,
      levelCount: 2,
      deviceCount: 3,
      savedAt: '2026-07-23T21:00:00.000Z',
    });
  });

  it('returns null metadata for files without stamped appProperties', () => {
    expect(configFileMetaFromAppProperties(undefined)).toBeNull();
    expect(configFileMetaFromAppProperties({})).toBeNull();
    expect(configFileMetaFromAppProperties({ unrelated: 'x' })).toBeNull();
  });

  it('builds combined list rows with blue-outline flag for native sheets', () => {
    const catalog = mergeConfigFilesIntoCatalog([
      { id: 's1', name: 'SHC-config', mimeType: SHEET },
      { id: 'x2', name: 'Excel Only.xlsx', mimeType: XLSX },
    ]);
    const rows = buildCustomerListRows(
      [{ id: 9, customerId: 'orphan', friendlyName: 'Orphan Site' }],
      catalog,
    );
    expect(rows.map((r) => r.key).sort()).toEqual(['excel-only', 'orphan', 'shc']);
    expect(rows.find((r) => r.key === 'shc').isNativeSheet).toBe(true);
    expect(rows.find((r) => r.key === 'excel-only').isNativeSheet).toBe(false);
    expect(rows.find((r) => r.key === 'orphan').isLocalOnly).toBe(true);
  });
});
