/**
 * importCustomerFromDrive — the one path that turns a Drive file into database
 * rows. What it must never do: create a second customers row for a file that
 * already has one, hand the store a tree the database did not accept, or
 * leave a freshly imported customer un-hydrated (auto-save would then refuse
 * to write it). Drive and the repository are faked; the parser and mapper are
 * real, running on the sample workbook.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSampleWorkbookBuffer, SAMPLE_FILE } from './__fixtures__/sampleWorkbook';

const drive = vi.hoisted(() => ({
  downloadConfigFile: vi.fn(),
}));
const repo = vi.hoisted(() => ({
  createCustomer: vi.fn(),
  saveCustomerFull: vi.fn(),
}));
vi.mock('./GoogleDriveService', () => drive);
vi.mock('./CustomerRepository', () => repo);

const { importCustomerFromDrive, findCustomerForDriveFile } = await import('./ImportCustomerFromDriveService');

function makeStore() {
  const customers = [];
  return {
    customers,
    addCustomer: vi.fn((customer) => {
      const entry = { sites: [], ...customer, id: customer.id ?? `local-${customers.length + 1}` };
      customers.push(entry);
      return entry;
    }),
    updateCustomer: vi.fn(),
    selectCustomer: vi.fn(),
    setHydration: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  drive.downloadConfigFile.mockResolvedValue(buildSampleWorkbookBuffer());
  repo.createCustomer.mockImplementation(async (payload) => ({
    customer: { ...payload, id: 'row-1' },
    updatedAt: '2026-09-02T10:00:00.000Z',
  }));
  repo.saveCustomerFull.mockResolvedValue({ status: 'saved', updatedAt: '2026-09-02T11:00:00.000Z' });
});
afterEach(() => vi.restoreAllMocks());

describe('importCustomerFromDrive — new customer', () => {
  it('creates the row with the whole tree, hydrates the store and opens it', async () => {
    const store = makeStore();

    const result = await importCustomerFromDrive({ file: SAMPLE_FILE, customers: [], store });

    expect(drive.downloadConfigFile).toHaveBeenCalledWith(SAMPLE_FILE.id, { signal: null });
    expect(repo.createCustomer).toHaveBeenCalledTimes(1);
    const payload = repo.createCustomer.mock.calls[0][0];
    expect(payload).toMatchObject({
      customerId: 'acme', code: 'ACME', friendlyName: 'Acme Parking',
      spreadsheetId: SAMPLE_FILE.id, spreadsheetUrl: SAMPLE_FILE.webViewLink,
    });
    expect(payload.sites).toHaveLength(1);
    expect(payload.displaySchedules).toHaveLength(1);
    expect(payload.warnings).toBeUndefined();
    expect(payload.summary).toBeUndefined();
    expect(repo.saveCustomerFull).not.toHaveBeenCalled();

    expect(store.addCustomer).toHaveBeenCalledTimes(1);
    expect(store.addCustomer.mock.calls[0][0]).toMatchObject({ id: 'row-1', lastSetupSavedAt: '2026-09-02T10:00:00.000Z' });
    expect(store.setHydration).toHaveBeenCalledWith('row-1', 'hydrated');
    expect(store.selectCustomer).toHaveBeenCalledWith('row-1');
    expect(result).toMatchObject({ customerId: 'row-1', mode: 'created', friendlyName: 'Acme Parking' });
    expect(result.summary).toEqual({ sites: 1, levels: 2, zones: 1, devices: 6, servers: 2 });
    expect(result.warnings).toEqual([]);
  });

  it('does not open the customer when select is false', async () => {
    const store = makeStore();
    await importCustomerFromDrive({ file: SAMPLE_FILE, customers: [], store, select: false });
    expect(store.selectCustomer).not.toHaveBeenCalled();
    expect(store.setHydration).toHaveBeenCalledWith('row-1', 'hydrated');
  });

  it('uses the file exactly as the catalog gave it, with no metadata refill from the download', async () => {
    // listAllConfigFilesInFolder always returns full file objects (id/name/mimeType/webViewLink),
    // so downloadConfigFile (which returns only bytes) never needs to fill in the name.
    const store = makeStore();
    await importCustomerFromDrive({ file: SAMPLE_FILE, customers: [], store });
    const payload = repo.createCustomer.mock.calls[0][0];
    expect(payload.sites[0].quickLinks[0].name).toBe('Acme-config');
    expect(payload.spreadsheetUrl).toBe(SAMPLE_FILE.webViewLink);
  });
});

describe('importCustomerFromDrive — existing customer', () => {
  it('replaces the tree of the customer matched by Drive file id, forced', async () => {
    const store = makeStore();
    const existing = { id: 'row-9', customerId: 'old-slug', friendlyName: 'Old Name', spreadsheetId: SAMPLE_FILE.id };

    const result = await importCustomerFromDrive({ file: SAMPLE_FILE, customers: [existing], store });

    expect(repo.createCustomer).not.toHaveBeenCalled();
    expect(repo.saveCustomerFull).toHaveBeenCalledTimes(1);
    const [id, customer, options] = repo.saveCustomerFull.mock.calls[0];
    expect(id).toBe('row-9');
    expect(options).toEqual({ expectedUpdatedAt: null });
    expect(customer.friendlyName).toBe('Acme Parking');
    expect(customer.spreadsheetId).toBe(SAMPLE_FILE.id);
    expect(store.updateCustomer).toHaveBeenCalledWith('row-9', expect.objectContaining({
      sites: expect.any(Array), lastSetupSavedAt: '2026-09-02T11:00:00.000Z',
    }));
    expect(store.setHydration).toHaveBeenCalledWith('row-9', 'hydrated');
    expect(store.selectCustomer).toHaveBeenCalledWith('row-9');
    expect(result.mode).toBe('replaced');
  });

  it('matches on the sheet\'s CustomerId so a second file for "acme" never inserts a duplicate', async () => {
    const store = makeStore();
    const existing = { id: 'row-2', customerId: 'acme', friendlyName: 'Acme (manual)' };

    await importCustomerFromDrive({ file: { ...SAMPLE_FILE, id: 'another-file-id' }, customers: [existing], store });

    expect(repo.createCustomer).not.toHaveBeenCalled();
    expect(repo.saveCustomerFull.mock.calls[0][0]).toBe('row-2');
  });

  it('uses the caller\'s explicit existingCustomer over any lookup', async () => {
    const store = makeStore();
    const explicit = { id: 'row-3', customerId: 'zzz', friendlyName: 'Zed' };
    await importCustomerFromDrive({ file: SAMPLE_FILE, customers: [], store, existingCustomer: explicit });
    expect(repo.saveCustomerFull.mock.calls[0][0]).toBe('row-3');
  });

  it('throws and leaves the store alone when the save reports a conflict', async () => {
    const store = makeStore();
    repo.saveCustomerFull.mockResolvedValueOnce({ status: 'conflict', remoteUpdatedAt: 'x' });
    await expect(importCustomerFromDrive({
      file: SAMPLE_FILE, customers: [], store, existingCustomer: { id: 'row-4', customerId: 'q' },
    })).rejects.toThrow(/could not be replaced/);
    expect(store.updateCustomer).not.toHaveBeenCalled();
    expect(store.setHydration).not.toHaveBeenCalled();
  });
});

describe('importCustomerFromDrive — guards', () => {
  it('needs a file and the store actions', async () => {
    await expect(importCustomerFromDrive({ file: null, store: makeStore() })).rejects.toThrow(/No Drive file/);
    await expect(importCustomerFromDrive({ file: SAMPLE_FILE, store: {} })).rejects.toThrow(/store actions/);
  });

  it('stops before writing when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(importCustomerFromDrive({ file: SAMPLE_FILE, store: makeStore(), signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(repo.createCustomer).not.toHaveBeenCalled();
  });
});

describe('findCustomerForDriveFile', () => {
  it('prefers the Drive file link, then the customer id', () => {
    const byFile = { id: 'a', customerId: 'x', spreadsheetId: 'file-1' };
    const byKey = { id: 'b', customerId: 'acme' };
    expect(findCustomerForDriveFile([byKey, byFile], { id: 'file-1' }, { customerId: 'acme' })).toBe(byFile);
    expect(findCustomerForDriveFile([byKey], { id: 'file-2' }, { customerId: 'acme' })).toBe(byKey);
    expect(findCustomerForDriveFile([byKey], { id: 'file-2' }, { customerId: 'other' })).toBeNull();
  });
});
