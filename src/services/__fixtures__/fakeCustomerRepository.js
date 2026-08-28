/**
 * In-memory fake for CustomerRepository.js, used by store tests that used to
 * drive a fake Google Sheets HTTP backend (see the deleted fakeSheets fixture).
 * Mirrors loadCustomerFull/saveCustomerFull's real contract, including the
 * updated_at optimistic-concurrency conflict check.
 */
export function createFakeCustomerRepository() {
  const rows = new Map(); // customerId -> { customer, updatedAt }
  let counter = 0;
  const EPOCH = Date.parse('2026-01-01T00:00:00.000Z');
  const nextTimestamp = () => {
    counter += 1;
    return new Date(EPOCH + counter * 1000).toISOString();
  };

  return {
    /** Seed a customer as if it already existed in Postgres. */
    seed(id, customer) {
      rows.set(id, { customer: structuredClone(customer), updatedAt: nextTimestamp() });
    },

    async loadCustomerFull(id) {
      const row = rows.get(id);
      if (!row) return null;
      return { customer: structuredClone(row.customer), updatedAt: row.updatedAt };
    },

    async saveCustomerFull(id, customer, { expectedUpdatedAt } = {}) {
      const row = rows.get(id);
      if (row && expectedUpdatedAt != null && row.updatedAt !== expectedUpdatedAt) {
        return { status: 'conflict', remoteUpdatedAt: row.updatedAt };
      }
      const updatedAt = nextTimestamp();
      rows.set(id, { customer: structuredClone(customer), updatedAt });
      return { status: 'saved', updatedAt };
    },

    subscribeToCustomerChanges() {
      return () => {};
    },

    _rows: rows,
  };
}
