import { describe, expect, it } from 'vitest';
import { customerCanSyncToSheet, customerHasConfigFile } from './customerConfigUtils';

describe('customerConfigUtils', () => {
  it('treats xlsx-linked customers as having a config file but not sheet sync', () => {
    const customer = { sourceFileId: 'abc123' };
    expect(customerHasConfigFile(customer)).toBe(true);
    expect(customerCanSyncToSheet(customer)).toBe(false);
  });

  it('allows sheet sync only for native Google Sheets', () => {
    const customer = { spreadsheetId: 'sheet123', sourceFileId: 'abc123' };
    expect(customerHasConfigFile(customer)).toBe(true);
    expect(customerCanSyncToSheet(customer)).toBe(true);
  });
});
