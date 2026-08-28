import { describe, expect, it } from 'vitest';
import { SETUP_JSON_CHUNK_DATA_PREFIX } from '../lib/configSheetSchema';
import {
  LAYOUT_SCHEMA_VERSION,
  serializeCustomerLayout,
  validateLayoutPayload,
  parseLayoutJson,
  layoutFilename,
  setupJsonPayloadFromRows,
  validateSetupJsonChunkRows,
  decodeSetupJsonChunkData,
} from './LayoutPersistenceService';

const sampleCustomer = {
  id: 1,
  customerId: 'shc',
  code: 'SHC',
  friendlyName: 'Sample Hospital',
  config: { address: '1 Main St', city: 'Boston', state: 'MA', zip: '02101', mapsUrl: '' },
  sites: [{
    id: 10,
    name: 'Garage A',
    levels: [{
      id: 100,
      name: 'Level 1',
      devices: [{
        id: 1,
        name: '1.1F',
        type: 'cam-fli',
        x: 120,
        y: 240,
        rotation: 90,
        pendingPlacement: false,
      }],
      zones: [{ id: 'z1', points: [{ x: 0, y: 0 }] }],
      bgImage: 'data:image/png;base64,abc',
    }],
  }],
};

/**
 * Build SetupJson chunk rows by hand, the way an old (pre-Supabase) sheet write
 * once did — used only to exercise the read path this service still supports
 * for OpenConfigFromDriveService.js's legacy-import flow.
 */
function chunkPayloadForTest(payload, chunkSize = 40000) {
  const json = JSON.stringify(payload);
  const chunks = [];
  for (let i = 0; i < json.length; i += chunkSize) chunks.push(json.slice(i, i + chunkSize));
  const dataChunks = chunks.length ? chunks : ['{}'];
  return [
    ['ChunkIndex', 'ChunkTotal', 'Data', 'SavedAt', 'PayloadHash'],
    ...dataChunks.map((data, index) => [
      index,
      dataChunks.length,
      `${SETUP_JSON_CHUNK_DATA_PREFIX}${data}`,
      ...(index === 0 ? [payload.savedAt, 'test-hash'] : []),
    ]),
  ];
}

describe('serializeCustomerLayout', () => {
  it('produces a versioned payload with sites', () => {
    const payload = serializeCustomerLayout(sampleCustomer, {
      navigation: { siteId: 10, levelId: 100 },
    });
    expect(payload.schemaVersion).toBe(LAYOUT_SCHEMA_VERSION);
    expect(payload.customer.sites).toHaveLength(1);
    expect(payload.customer.sites[0].levels[0].devices[0].x).toBe(120);
    expect(payload.navigation).toEqual({ siteId: 10, levelId: 100 });
    expect(payload.customer.sites[0].levels[0].bgImage).toBe('data:image/png;base64,abc');
  });

  it('throws when customer is missing', () => {
    expect(() => serializeCustomerLayout(null)).toThrow(/No customer/);
  });
});

describe('validateLayoutPayload / parseLayoutJson', () => {
  it('round-trips through JSON text', () => {
    const payload = serializeCustomerLayout(sampleCustomer);
    const parsed = parseLayoutJson(JSON.stringify(payload));
    expect(parsed.customer.sites[0].levels[0].devices[0].rotation).toBe(90);
    expect(parsed.navigation).toBeNull();
  });

  it('rejects unsupported schema version', () => {
    expect(() => validateLayoutPayload({ schemaVersion: 99, customer: { sites: [] } }))
      .toThrow(/Unsupported setup version/);
  });

  it('rejects missing sites array', () => {
    expect(() => validateLayoutPayload({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      customer: {},
    })).toThrow(/sites must be an array/);
  });
});

describe('layoutFilename', () => {
  it('uses customerId in filename', () => {
    expect(layoutFilename(sampleCustomer)).toBe('shc-setup.json');
  });
});

// Read-side coverage for OpenConfigFromDriveService.js's legacy-import flow —
// this service no longer writes SetupJson chunks (Supabase is the source of
// truth), but it still reads them out of an old Drive-linked spreadsheet.
describe('setupJsonPayloadFromRows (legacy read path)', () => {
  it('round-trips through chunked sheet rows', () => {
    const payload = serializeCustomerLayout(sampleCustomer);
    const rows = chunkPayloadForTest(payload);
    const parsed = setupJsonPayloadFromRows(rows);
    expect(parsed?.customer.sites[0].levels[0].devices[0].x).toBe(120);
  });

  it('handles large payloads across multiple chunks', () => {
    const bigCustomer = {
      ...sampleCustomer,
      sites: [{
        ...sampleCustomer.sites[0],
        levels: [{
          ...sampleCustomer.sites[0].levels[0],
          bgImage: `data:image/png;base64,${'A'.repeat(50000)}`,
        }],
      }],
    };
    const rows = chunkPayloadForTest(serializeCustomerLayout(bigCustomer));
    expect(rows.length).toBeGreaterThan(2);
    const parsed = setupJsonPayloadFromRows(rows);
    expect(parsed?.customer.sites[0].levels[0].bgImage.length).toBeGreaterThan(50000);
  });

  it('rejects incomplete chunk sets', () => {
    const bigCustomer = {
      ...sampleCustomer,
      sites: [{
        ...sampleCustomer.sites[0],
        levels: [{
          ...sampleCustomer.sites[0].levels[0],
          bgImage: `data:image/png;base64,${'A'.repeat(50000)}`,
        }],
      }],
    };
    const rows = chunkPayloadForTest(serializeCustomerLayout(bigCustomer));
    expect(rows.length).toBeGreaterThan(2);
    const incomplete = [rows[0], rows[1]];
    expect(() => validateSetupJsonChunkRows(incomplete)).toThrow(/incomplete/i);
  });

  it('rejects missing chunk indices', () => {
    const header = ['ChunkIndex', 'ChunkTotal', 'Data'];
    const rows = [
      header,
      [0, 2, '{"a":1'],
      [2, 2, '}'],
    ];
    expect(() => validateSetupJsonChunkRows(rows)).toThrow(/missing chunk 1/i);
  });

  it('rejects spreadsheet formula error cells that corrupt floor-plan chunks', () => {
    const header = ['ChunkIndex', 'ChunkTotal', 'Data'];
    const rows = [
      header,
      [0, 3, '{"bg":"data:image/png;base64,aaa'],
      [1, 3, '#ERROR!'],
      [2, 3, 'bbb"}'],
    ];
    expect(() => validateSetupJsonChunkRows(rows)).toThrow(/corrupted by the spreadsheet/i);
    expect(() => setupJsonPayloadFromRows(rows)).toThrow(/corrupted by the spreadsheet/i);
  });

  it('decodes the SJ1: prefix used to stop leading +/= from becoming sheet formulas', () => {
    expect(decodeSetupJsonChunkData(`${SETUP_JSON_CHUNK_DATA_PREFIX}+base64Chunk`)).toBe('+base64Chunk');
    expect(decodeSetupJsonChunkData('{"legacy":true}')).toBe('{"legacy":true}');
  });

  it('round-trips payloads that include formula-leading + inside base64', () => {
    const bigCustomer = {
      ...sampleCustomer,
      sites: [{
        ...sampleCustomer.sites[0],
        levels: [{
          ...sampleCustomer.sites[0].levels[0],
          bgImage: `data:image/png;base64,${'A'.repeat(50000)}+KEEP_PLUS${'B'.repeat(1000)}`,
        }],
      }],
    };
    const rows = chunkPayloadForTest(serializeCustomerLayout(bigCustomer));
    const parsed = setupJsonPayloadFromRows(rows);
    expect(parsed?.customer.sites[0].levels[0].bgImage).toContain('+KEEP_PLUS');
  });
});
