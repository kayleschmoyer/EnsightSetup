import { describe, expect, it } from 'vitest';
import {
  LAYOUT_SCHEMA_VERSION,
  serializeCustomerLayout,
  validateLayoutPayload,
  parseLayoutJson,
  layoutFilename,
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
