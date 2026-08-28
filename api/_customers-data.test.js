/**
 * Unit test for saveCustomerFull's optimistic-concurrency guard. This logic
 * moved server-side during the MySQL migration — CustomerRepository.js is now
 * a thin fetch() wrapper with no guard logic of its own (see its module
 * header). Mocks the MySQL pool just enough to exercise the guard's
 * SELECT ... FOR UPDATE + conditional UPDATE and its two outcomes.
 */
import { describe, expect, it, vi } from 'vitest';

// This test exercises saveCustomerFull's real write logic against a mocked
// pool — enable the test-only override so it isn't blocked by the production
// compliance gate (see _customers-data.js / WriteGuard.js).
const { __setLiveDbWritesForTests } = await import('./_customers-data.js');
__setLiveDbWritesForTests(true);

function makeFakePool(initialUpdatedAt) {
  const state = { updatedAt: initialUpdatedAt };

  async function runQuery(sql) {
    if (sql.includes('FOR UPDATE')) return [[{ updated_at: state.updatedAt }]];
    if (sql.startsWith('UPDATE customers SET')) {
      // A real write bumps updated_at via ON UPDATE CURRENT_TIMESTAMP.
      state.updatedAt = '2026-01-01T00:00:01.000Z';
      return [{ affectedRows: 1 }];
    }
    if (sql === 'SELECT updated_at FROM customers WHERE id = ?') return [[{ updated_at: state.updatedAt }]];
    if (sql.startsWith('SELECT id FROM')) return [[]];
    if (sql.startsWith('INSERT INTO')) return [{ affectedRows: 1 }];
    return [[]];
  }

  const fakeConn = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    query: runQuery,
  };

  return {
    async getConnection() { return fakeConn; },
    query: runQuery,
  };
}

const h = vi.hoisted(() => ({ pool: null }));
vi.mock('./_db.js', () => ({ getPool: () => h.pool }));

const { saveCustomerFull } = await import('./_customers-data.js');

const CUSTOMER = {
  code: 'ACME', friendlyName: 'Acme', config: {}, sites: [], displaySchedules: [],
};

describe('saveCustomerFull optimistic concurrency', () => {
  it('saves when expectedUpdatedAt matches the current row', async () => {
    h.pool = makeFakePool('2026-01-01T00:00:00.000Z');
    const result = await saveCustomerFull('cust-1', CUSTOMER, '2026-01-01T00:00:00.000Z');
    expect(result.status).toBe('saved');
    expect(result.updatedAt).toBe('2026-01-01T00:00:01.000Z');
  });

  it('reports a conflict when expectedUpdatedAt is stale', async () => {
    h.pool = makeFakePool('2026-01-01T00:00:00.000Z');
    const result = await saveCustomerFull('cust-1', CUSTOMER, '2020-01-01T00:00:00.000Z');
    expect(result.status).toBe('conflict');
    expect(result.remoteUpdatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('skips the guard entirely when expectedUpdatedAt is null (force write)', async () => {
    h.pool = makeFakePool('2026-01-01T00:00:00.000Z');
    const result = await saveCustomerFull('cust-1', CUSTOMER, null);
    expect(result.status).toBe('saved');
  });
});
