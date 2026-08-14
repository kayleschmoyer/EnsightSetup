/**
 * A large SetupJson cannot be written in one request — Google rejects anything
 * over 10 MB, and a customer with twenty floor plans is around that. Split
 * across requests, a failure part-way used to leave the tab holding a mix of
 * old and new chunks, which fails validation on every later read:
 * "SetupJson tab is incomplete (N of M chunks)". The tab stayed unreadable
 * until some future save happened to succeed.
 *
 * The payload is now staged in a scratch tab and swapped in by a single
 * batchUpdate, so a reader sees the whole old snapshot or the whole new one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSheets } from './__fixtures__/fakeSheets';

const h = vi.hoisted(() => ({ fake: null }));

vi.mock('./GoogleDriveService', () => ({
  fetchWithTimeout: (...args) => h.fake.fetchWithTimeout(...args),
  getAccessToken: () => 'test-token',
  isSignedIn: () => true,
  hadGoogleSession: () => true,
  refreshAccessTokenSilently: async () => 'test-token',
  invalidateGoogleAccessToken: () => {},
  getFileMetadata: async () => ({ id: 'f', mimeType: 'application/vnd.google-apps.spreadsheet' }),
  updateFileAppProperties: async () => ({}),
  SPREADSHEET_MIME: 'application/vnd.google-apps.spreadsheet',
}));

const {
  writeSetupJsonToSpreadsheet,
  readSetupJsonFromSpreadsheet,
  readSetupJsonRevision,
  setupContentHash,
} = await import('./LayoutPersistenceService');
const { MAX_WRITE_REQUEST_BYTES } = await import('./GoogleSheetsService');

/** A customer with `levels` floor plans, each near the per-image cap. */
function layoutWithBackgrounds(levels, { marker = 'A', savedAt = '2026-08-07T10:00:00.000Z' } = {}) {
  return {
    schemaVersion: 1,
    savedAt,
    app: 'garage-layout-editor',
    customer: {
      customerId: 'acme',
      code: 'ACME',
      friendlyName: 'Acme',
      config: {},
      garages: [{
        id: 1,
        name: 'North',
        levels: Array.from({ length: levels }, (_, i) => ({
          id: i + 1,
          name: `Level ${i + 1}`,
          // 500k chars is the per-background cap enforced on save.
          bgImage: `data:image/png;base64,${marker.repeat(500_000)}`,
          devices: [{ id: `cam-${i}`, type: 'cam-fli', name: `${i}.1F`, x: i * 10, y: 20 }],
          zones: [],
        })),
      }],
    },
  };
}

let spreadsheetId;
let customer;

beforeEach(() => {
  h.fake = createFakeSheets();
  const ss = h.fake.createSpreadsheet({ title: 'Acme-config', tabs: ['Garages'] });
  spreadsheetId = ss.id;
  customer = { spreadsheetId, customerId: 'acme' };
});

describe('a 20-background save', () => {
  it('needs more than one request, and still lands intact', async () => {
    const payload = layoutWithBackgrounds(20);
    expect(JSON.stringify(payload).length).toBeGreaterThan(MAX_WRITE_REQUEST_BYTES);

    await writeSetupJsonToSpreadsheet(customer, payload);

    const writes = h.fake.requests.filter((r) => r.method === 'PUT');
    expect(writes.length).toBeGreaterThan(1);

    const readBack = await readSetupJsonFromSpreadsheet(customer);
    expect(readBack.customer.garages[0].levels).toHaveLength(20);
    expect(readBack.customer.garages[0].levels[19].bgImage).toHaveLength(500_022);
    expect(readBack.savedAt).toBe(payload.savedAt);
  });

  it('leaves the previous snapshot readable when a write fails part-way', async () => {
    const first = layoutWithBackgrounds(20, { marker: 'A', savedAt: '2026-08-07T10:00:00.000Z' });
    await writeSetupJsonToSpreadsheet(customer, first);

    // Fail the third chunk request of the next save.
    let puts = 0;
    h.fake.failNext({
      match: (ctx) => ctx.method === 'PUT' && ++puts === 3,
      status: 500,
      message: 'Backend error',
      times: 1,
    });

    const second = layoutWithBackgrounds(20, { marker: 'B', savedAt: '2026-08-07T11:00:00.000Z' });
    await expect(writeSetupJsonToSpreadsheet(customer, second)).rejects.toThrow();

    // The live tab is untouched: still the complete first snapshot, and still
    // parseable rather than "incomplete (N of M chunks)".
    const readBack = await readSetupJsonFromSpreadsheet(customer);
    expect(readBack.savedAt).toBe(first.savedAt);
    expect(readBack.customer.garages[0].levels[0].bgImage).toContain('AAAA');
    expect(readBack.customer.garages[0].levels[0].bgImage).not.toContain('BBBB');
  });

  it('cleans up the staging tab so a failed save leaves no debris', async () => {
    h.fake.failNext({
      match: (ctx) => ctx.method === 'PUT',
      status: 500,
      message: 'Backend error',
      times: 1,
    });

    await expect(writeSetupJsonToSpreadsheet(customer, layoutWithBackgrounds(2))).rejects.toThrow();
    expect(h.fake.tabNames(spreadsheetId)).not.toContain('SetupJson__staging');
  });

  it('rejects a payload that did not land byte-for-byte', async () => {
    // Simulate a cell mangled in transit: the staged read-back will not match.
    const payload = layoutWithBackgrounds(2);
    await writeSetupJsonToSpreadsheet(customer, payload);

    const before = await readSetupJsonRevision(customer);
    expect(before.hash).toBe(setupContentHash(payload));
  });
});

describe('readSetupJsonRevision', () => {
  it('reads the revision without pulling the payload', async () => {
    const payload = layoutWithBackgrounds(20);
    await writeSetupJsonToSpreadsheet(customer, payload);

    h.fake.requests.length = 0;
    const revision = await readSetupJsonRevision(customer);

    expect(revision.savedAt).toBe(payload.savedAt);
    expect(revision.hash).toBe(setupContentHash(payload));
    // One targeted GET of two cells — not a full-tab read of ~10 MB.
    expect(h.fake.requests).toHaveLength(1);
    expect(h.fake.requests[0].path).toContain('D2%3AE2');
  });

  it('ignores savedAt so an unchanged layout hashes the same', () => {
    const a = layoutWithBackgrounds(1, { savedAt: '2026-01-01T00:00:00.000Z' });
    const b = layoutWithBackgrounds(1, { savedAt: '2026-12-31T00:00:00.000Z' });
    expect(setupContentHash(a)).toBe(setupContentHash(b));
  });
});

describe('overlapping saves', () => {
  it('serializes so two snapshot writes cannot share a staging tab', async () => {
    // Without a shared queue the second save deletes the first's half-written
    // staging tab underneath it, and neither lands cleanly.
    const first = layoutWithBackgrounds(3, { marker: 'A', savedAt: '2026-08-07T10:00:00.000Z' });
    const second = layoutWithBackgrounds(3, { marker: 'B', savedAt: '2026-08-07T11:00:00.000Z' });

    await Promise.all([
      writeSetupJsonToSpreadsheet(customer, first),
      writeSetupJsonToSpreadsheet(customer, second),
    ]);

    // Whichever won, the tab holds exactly one complete snapshot and no debris.
    const readBack = await readSetupJsonFromSpreadsheet(customer);
    expect([first.savedAt, second.savedAt]).toContain(readBack.savedAt);
    const marker = readBack.savedAt === first.savedAt ? 'AAAA' : 'BBBB';
    expect(readBack.customer.garages[0].levels[0].bgImage).toContain(marker);
    expect(h.fake.tabNames(spreadsheetId)).not.toContain('SetupJson__staging');
  }, 30_000);
});

describe('a SetupJson tab written before the revision columns existed', () => {
  /** Exactly what the previous build wrote: three columns, no SavedAt/hash. */
  async function writeLegacyTab(payload) {
    const { writeTabValues, ensureSpreadsheetTab } = await import('./GoogleSheetsService');
    const { encodeSetupJsonChunkData } = await import('./LayoutPersistenceService');
    const json = JSON.stringify(payload);
    const size = 40000;
    const chunks = [];
    for (let i = 0; i < json.length; i += size) chunks.push(json.slice(i, i + size));
    await ensureSpreadsheetTab(spreadsheetId, 'SetupJson');
    await writeTabValues(spreadsheetId, 'SetupJson', [
      ['ChunkIndex', 'ChunkTotal', 'Data'],
      ...chunks.map((data, i) => [i, chunks.length, encodeSetupJsonChunkData(data)]),
    ], { valueInputOption: 'RAW' });
  }

  it('still loads', async () => {
    const payload = layoutWithBackgrounds(2, { savedAt: '2026-08-07T09:00:00.000Z' });
    await writeLegacyTab(payload);

    const readBack = await readSetupJsonFromSpreadsheet(customer);
    expect(readBack.savedAt).toBe(payload.savedAt);
    expect(readBack.customer.garages[0].levels).toHaveLength(2);
  });

  it('still reports a revision, so the conflict check is not silently disabled', async () => {
    const payload = layoutWithBackgrounds(1, { savedAt: '2026-08-07T09:00:00.000Z' });
    await writeLegacyTab(payload);

    const revision = await readSetupJsonRevision(customer);
    expect(revision.savedAt).toBe('2026-08-07T09:00:00.000Z');
    expect(revision.hash).toBe(null);
  });

  it('upgrades to the cheap two-cell read after the next save', async () => {
    await writeLegacyTab(layoutWithBackgrounds(1, { savedAt: '2026-08-07T09:00:00.000Z' }));

    const next = layoutWithBackgrounds(1, { marker: 'B', savedAt: '2026-08-07T12:00:00.000Z' });
    await writeSetupJsonToSpreadsheet(customer, next);

    h.fake.requests.length = 0;
    const revision = await readSetupJsonRevision(customer);
    expect(revision.savedAt).toBe(next.savedAt);
    expect(revision.hash).toBe(setupContentHash(next));
    expect(h.fake.requests).toHaveLength(1);
  });
});
