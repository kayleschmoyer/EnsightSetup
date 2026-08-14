import { describe, expect, it } from 'vitest';
import { SETUP_JSON_CHUNK_DATA_PREFIX } from '../lib/configSheetSchema';
import {
  LAYOUT_SCHEMA_VERSION,
  serializeCustomerLayout,
  validateLayoutPayload,
  parseLayoutJson,
  layoutFilename,
  setupJsonChunksFromPayload,
  setupContentHash,
  setupJsonPayloadFromRows,
  validateSetupJsonChunkRows,
  encodeSetupJsonChunkData,
  decodeSetupJsonChunkData,
} from './LayoutPersistenceService';

const sampleCustomer = {
  id: 1,
  customerId: 'shc',
  code: 'SHC',
  friendlyName: 'Sample Hospital',
  config: { address: '1 Main St', city: 'Boston', state: 'MA', zip: '02101', mapsUrl: '' },
  garages: [{
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

describe('serializeCustomerLayout', () => {
  it('produces a versioned payload with garages', () => {
    const payload = serializeCustomerLayout(sampleCustomer, {
      navigation: { garageId: 10, levelId: 100 },
    });
    expect(payload.schemaVersion).toBe(LAYOUT_SCHEMA_VERSION);
    expect(payload.customer.garages).toHaveLength(1);
    expect(payload.customer.garages[0].levels[0].devices[0].x).toBe(120);
    expect(payload.navigation).toEqual({ garageId: 10, levelId: 100 });
    expect(payload.customer.garages[0].levels[0].bgImage).toBe('data:image/png;base64,abc');
  });

  it('throws when customer is missing', () => {
    expect(() => serializeCustomerLayout(null)).toThrow(/No customer/);
  });
});

describe('validateLayoutPayload / parseLayoutJson', () => {
  it('round-trips through JSON text', () => {
    const payload = serializeCustomerLayout(sampleCustomer);
    const parsed = parseLayoutJson(JSON.stringify(payload));
    expect(parsed.customer.garages[0].levels[0].devices[0].rotation).toBe(90);
    expect(parsed.navigation).toBeNull();
  });

  it('rejects unsupported schema version', () => {
    expect(() => validateLayoutPayload({ schemaVersion: 99, customer: { garages: [] } }))
      .toThrow(/Unsupported setup version/);
  });

  it('rejects missing garages array', () => {
    expect(() => validateLayoutPayload({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      customer: {},
    })).toThrow(/garages must be an array/);
  });
});

describe('layoutFilename', () => {
  it('uses customerId in filename', () => {
    expect(layoutFilename(sampleCustomer)).toBe('shc-setup.json');
  });
});

describe('setupJsonChunksFromPayload / setupJsonPayloadFromRows', () => {
  it('round-trips through chunked sheet rows', () => {
    const payload = serializeCustomerLayout(sampleCustomer);
    const rows = setupJsonChunksFromPayload(payload);
    expect(rows[0]).toEqual(['ChunkIndex', 'ChunkTotal', 'Data', 'SavedAt', 'PayloadHash']);
    // The revision rides on the first data row so it can be read on its own.
    expect(rows[1][3]).toBe(payload.savedAt);
    expect(rows[1][4]).toBe(setupContentHash(payload));
    const parsed = setupJsonPayloadFromRows(rows);
    expect(parsed?.customer.garages[0].levels[0].devices[0].x).toBe(120);
  });

  it('handles large payloads across multiple chunks', () => {
    const bigCustomer = {
      ...sampleCustomer,
      garages: [{
        ...sampleCustomer.garages[0],
        levels: [{
          ...sampleCustomer.garages[0].levels[0],
          bgImage: `data:image/png;base64,${'A'.repeat(50000)}`,
        }],
      }],
    };
    const rows = setupJsonChunksFromPayload(serializeCustomerLayout(bigCustomer));
    expect(rows.length).toBeGreaterThan(2);
    const parsed = setupJsonPayloadFromRows(rows);
    expect(parsed?.customer.garages[0].levels[0].bgImage.length).toBeGreaterThan(50000);
  });

  it('rejects incomplete chunk sets', () => {
    const bigCustomer = {
      ...sampleCustomer,
      garages: [{
        ...sampleCustomer.garages[0],
        levels: [{
          ...sampleCustomer.garages[0].levels[0],
          bgImage: `data:image/png;base64,${'A'.repeat(50000)}`,
        }],
      }],
    };
    const rows = setupJsonChunksFromPayload(serializeCustomerLayout(bigCustomer));
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

  it('prefixes chunk data so leading +/= cannot become sheet formulas', () => {
    const payload = serializeCustomerLayout(sampleCustomer);
    const rows = setupJsonChunksFromPayload(payload);
    const dataCell = String(rows[1][2]);
    expect(dataCell.startsWith(SETUP_JSON_CHUNK_DATA_PREFIX)).toBe(true);
    expect(encodeSetupJsonChunkData('+base64Chunk')).toBe(`${SETUP_JSON_CHUNK_DATA_PREFIX}+base64Chunk`);
    expect(decodeSetupJsonChunkData(`${SETUP_JSON_CHUNK_DATA_PREFIX}+base64Chunk`)).toBe('+base64Chunk');
    expect(decodeSetupJsonChunkData('{"legacy":true}')).toBe('{"legacy":true}');
  });

  it('round-trips payloads that include formula-leading + inside base64', () => {
    const bigCustomer = {
      ...sampleCustomer,
      garages: [{
        ...sampleCustomer.garages[0],
        levels: [{
          ...sampleCustomer.garages[0].levels[0],
          bgImage: `data:image/png;base64,${'A'.repeat(50000)}+KEEP_PLUS${'B'.repeat(1000)}`,
        }],
      }],
    };
    const rows = setupJsonChunksFromPayload(serializeCustomerLayout(bigCustomer));
    expect(rows.slice(1).every((row) => String(row[2]).startsWith(SETUP_JSON_CHUNK_DATA_PREFIX))).toBe(true);
    // Simulate Sheets USER_ENTERED: unprefixed "+..." would become #ERROR!; prefixed stays text.
    const plusLed = rows.slice(1).find((row) => decodeSetupJsonChunkData(row[2]).startsWith('+'));
    if (plusLed) {
      expect(String(plusLed[2]).startsWith(`${SETUP_JSON_CHUNK_DATA_PREFIX}+`)).toBe(true);
    }
    const parsed = setupJsonPayloadFromRows(rows);
    expect(parsed?.customer.garages[0].levels[0].bgImage).toContain('+KEEP_PLUS');
  });
});
