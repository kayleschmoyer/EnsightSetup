/**
 * addCustomer used to always append, so an optimistic add that lands after
 * loadCustomersFromSupabase's realtime-triggered merge already inserted the
 * same row (same id) left two entries with one id in `customers` — which
 * driveConfigCatalog.js's buildCustomerListRows turns into two React list
 * rows sharing the key `local:<id>`, a duplicate-key warning. addCustomer
 * must replace the existing row in place instead.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserEnv } from '../services/__fixtures__/browserEnv';

installBrowserEnv();

vi.mock('../services/CustomerRepository', () => ({
  loadCustomerFull: vi.fn(),
  saveCustomerFull: vi.fn(),
  listCustomers: vi.fn(),
  loadCustomerCard: vi.fn(),
}));

const { useAppStore } = await import('./useAppStore');

beforeEach(() => {
  useAppStore.setState({ customers: [] });
});

describe('addCustomer', () => {
  it('appends a new customer id', () => {
    useAppStore.getState().addCustomer({ id: 'cust-1', friendlyName: 'Acme' });
    expect(useAppStore.getState().customers.map((c) => c.id)).toEqual(['cust-1']);
  });

  it('replaces in place instead of duplicating when the id already exists', () => {
    useAppStore.setState({
      customers: [{ id: 'cust-1', friendlyName: 'Acme (pointer)', sites: null }],
    });

    useAppStore.getState().addCustomer({ id: 'cust-1', friendlyName: 'Acme', sites: [] });

    const { customers } = useAppStore.getState();
    expect(customers).toHaveLength(1);
    expect(customers[0].friendlyName).toBe('Acme');
  });
});
