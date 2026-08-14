import { describe, expect, it } from 'vitest';
import {
  customersForLocalPersistence,
  slimCustomerForLocalPersistence,
} from './localPersistence';

describe('localPersistence', () => {
  it('leaves customers with no linked sheet unchanged (nothing to defer to)', () => {
    const localOnly = {
      id: 1,
      customerId: 'local',
      garages: [{
        id: 1,
        name: 'G1',
        levels: [{ id: 1, name: 'L1', bgImage: 'data:image/png;base64,abc', devices: [{ id: 'd1' }] }],
      }],
    };
    expect(slimCustomerForLocalPersistence(localOnly)).toBe(localOnly);

    // xlsx-only: resolveSpreadsheetId returns null, so there is no sheet to
    // re-read from. Dropping the layout here would destroy it outright.
    const xlsxOnly = { ...localOnly, sourceFileId: 'file1' };
    expect(slimCustomerForLocalPersistence(xlsxOnly)).toBe(xlsxOnly);
  });

  it('keeps only pointers for sheet-backed customers', () => {
    const sheetCustomer = {
      id: 2,
      customerId: 'methodist',
      code: 'METH',
      friendlyName: 'Methodist',
      spreadsheetId: 'sheet-abc',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-abc/edit',
      spreadsheetTitle: 'Methodist-config',
      sourceFileId: 'drive-1',
      sourceFileName: 'Methodist-config.xlsx',
      config: { support: { enterpriseSite: true } },
      lastSetupSavedAt: '2026-08-05T12:00:00.000Z',
      displaySchedules: [{ id: 'sched-1' }],
      garages: [{
        id: 10,
        name: 'Ogden Street',
        internalName: 'ogden',
        address: '123 Main',
        levels: [{
          id: 20,
          name: 'Ground L1',
          bgImage: `data:image/png;base64,${'A'.repeat(1000)}`,
          devices: [{ id: 'cam-1', type: 'cam-fli' }],
          zones: [{ id: 'z1' }],
          totalSpots: 50,
        }],
        servers: [{ id: 'srv' }],
        displayGroups: [{ name: 'Entry' }],
      }],
    };

    const slim = slimCustomerForLocalPersistence(sheetCustomer);

    expect(slim.spreadsheetId).toBe('sheet-abc');
    expect(slim.customerId).toBe('methodist');
    expect(slim.friendlyName).toBe('Methodist');
    expect(slim.sourceFileId).toBe('drive-1');

    // No layout survives, and no stub pretends to be one.
    expect(slim.garages).toBe(null);
    expect(slim.lastSetupSavedAt).toBe(null);
    expect(slim.displaySchedules).toBeUndefined();
    // config is owned by the Customer tab / SetupJson, not by this browser.
    expect(slim.config).toBeUndefined();

    // The in-memory customer must stay intact.
    expect(sheetCustomer.garages[0].levels[0].devices).toHaveLength(1);
    expect(sheetCustomer.config.support.enterpriseSite).toBe(true);
  });

  it('never serializes a floor-plan background for a sheet-backed customer', () => {
    const slim = slimCustomerForLocalPersistence({
      id: 3,
      customerId: 'c',
      spreadsheetId: 's',
      garages: [{ id: 1, levels: [{ id: 1, bgImage: 'data:image/png;base64,AAAA' }] }],
    });
    expect(JSON.stringify(slim)).not.toContain('base64');
  });

  it('maps a mixed customer list', () => {
    const list = [
      { id: 1, customerId: 'a', garages: [{ id: 1, levels: [{ bgImage: 'x' }] }] },
      { id: 2, customerId: 'b', spreadsheetId: 's1', garages: [{ id: 1, name: 'G' }] },
    ];
    const out = customersForLocalPersistence(list);
    expect(out[0]).toBe(list[0]);
    expect(out[1].garages).toBe(null);
  });
});
