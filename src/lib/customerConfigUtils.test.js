import { describe, expect, it } from 'vitest';
import { customerCanSyncToSheet, customerHasConfigFile } from './customerConfigUtils';

describe('customerConfigUtils', () => {
  it('treats any customer with a Supabase row id as syncable', () => {
    const customer = { id: 'abc123' };
    expect(customerHasConfigFile(customer)).toBe(true);
    expect(customerCanSyncToSheet(customer)).toBe(true);
  });

  it('treats a customer with no row id yet (not created in Supabase) as not syncable', () => {
    const customer = { friendlyName: 'Draft, not saved yet' };
    expect(customerHasConfigFile(customer)).toBe(false);
    expect(customerCanSyncToSheet(customer)).toBe(false);
  });
});
