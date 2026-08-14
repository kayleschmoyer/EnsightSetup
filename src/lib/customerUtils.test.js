import { describe, it, expect, afterEach } from 'vitest';
import { safeExternalUrl, customerLocationFields, mapsOpenUrl } from './customerUtils';

describe('safeExternalUrl', () => {
  const originalDev = import.meta.env.DEV;

  afterEach(() => {
    import.meta.env.DEV = originalDev;
  });

  it('accepts https URLs', () => {
    expect(safeExternalUrl('https://example.com/path')).toBe('https://example.com/path');
  });

  it('prefixes bare domains with https', () => {
    expect(safeExternalUrl('maps.google.com')).toBe('https://maps.google.com/');
  });

  it('rejects relative paths that would resolve against the app origin', () => {
    expect(safeExternalUrl('/maps.google.com')).toBeNull();
    expect(safeExternalUrl('//evil.example')).toBeNull();
  });

  it('rejects javascript: and other non-http(s) protocols', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,hi')).toBeNull();
  });

  it('rejects http in production', () => {
    import.meta.env.DEV = false;
    expect(safeExternalUrl('http://example.com')).toBeNull();
  });

  it('allows http in development', () => {
    import.meta.env.DEV = true;
    expect(safeExternalUrl('http://localhost:3000')).toBe('http://localhost:3000/');
  });

  it('allows explicit http URLs when allowHttp is set (quick links)', () => {
    import.meta.env.DEV = false;
    expect(safeExternalUrl('http://internal-server', { allowHttp: true })).toBe('http://internal-server/');
  });

  it('still rejects unsafe protocols with allowHttp', () => {
    expect(safeExternalUrl('javascript:alert(1)', { allowHttp: true })).toBeNull();
    expect(safeExternalUrl('/relative', { allowHttp: true })).toBeNull();
  });

  it('rejects bare single words that are probably typos, not URLs', () => {
    expect(safeExternalUrl('exam')).toBeNull();
    expect(safeExternalUrl('internal-server', { allowHttp: true })).toBeNull();
  });

  it('accepts explicit schemes for single-label internal hosts', () => {
    expect(safeExternalUrl('https://internal-server')).toBe('https://internal-server/');
  });

  it('returns null for empty input', () => {
    expect(safeExternalUrl('')).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
    expect(safeExternalUrl('   ')).toBeNull();
  });
});

describe('customerLocationFields', () => {
  it('reads location from customer.config', () => {
    const fields = customerLocationFields({
      config: { city: 'Newport News', state: 'VA', address: '', zip: '', mapsUrl: '' },
    });
    expect(fields.city).toBe('Newport News');
    expect(fields.state).toBe('VA');
  });
});

describe('mapsOpenUrl', () => {
  it('builds a search URL from address when mapsUrl is missing', () => {
    const url = mapsOpenUrl('', 'Newport News, VA');
    expect(url).toContain('google.com/maps/search');
    expect(url).toContain(encodeURIComponent('Newport News, VA'));
  });
});
