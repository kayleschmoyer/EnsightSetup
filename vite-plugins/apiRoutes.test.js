import { describe, expect, it } from 'vitest';
import { buildRoutes, matchRoute } from './apiRoutes.js';

/** The real api/ layout, so the cases here track what actually ships. */
const API_FILES = [
  '_auth.js',
  '_customers-data.js',
  '_customers-data.test.js',
  '_db.js',
  '_google.js',
  '_http.js',
  '_s3.js',
  'auth-google.js',
  'auth-logout.js',
  'auth-session.js',
  'create-clickup-task.js',
  'customers/[id].js',
  'customers/[id]/card.js',
  'customers/[id]/full.js',
  'customers/index.js',
  'export-to-sheets.js',
  'export-to-sheets.test.js',
  'health-db.js',
  'storage-image-url.js',
];

const routes = buildRoutes(API_FILES);

describe('buildRoutes', () => {
  it('leaves out shared helpers and tests, which are not routes', () => {
    const files = routes.map((route) => route.file);
    expect(files).not.toContain('_auth.js');
    expect(files).not.toContain('_customers-data.js');
    expect(files).not.toContain('export-to-sheets.test.js');
    expect(files).not.toContain('_customers-data.test.js');
  });

  it('keeps every real route file', () => {
    expect(routes.map((route) => route.file).sort()).toEqual([
      'auth-google.js',
      'auth-logout.js',
      'auth-session.js',
      'create-clickup-task.js',
      'customers/[id].js',
      'customers/[id]/card.js',
      'customers/[id]/full.js',
      'customers/index.js',
      'export-to-sheets.js',
      'health-db.js',
      'storage-image-url.js',
    ].sort());
  });

  it('orders literal routes ahead of dynamic ones that could also match', () => {
    const dynamicCounts = routes.map((r) => r.segments.filter((s) => s.param).length);
    expect(dynamicCounts).toEqual([...dynamicCounts].sort((a, b) => a - b));
  });
});

describe('matchRoute', () => {
  it('routes the flat endpoints the app calls', () => {
    expect(matchRoute(routes, '/api/auth-google')).toEqual({
      file: 'auth-google.js', params: {},
    });
    expect(matchRoute(routes, '/api/storage-image-url')).toEqual({
      file: 'storage-image-url.js', params: {},
    });
    expect(matchRoute(routes, '/api/health-db')).toEqual({
      file: 'health-db.js', params: {},
    });
  });

  it('serves a directory index without a trailing segment', () => {
    expect(matchRoute(routes, '/api/customers')).toEqual({
      file: 'customers/index.js', params: {},
    });
  });

  it('pulls the dynamic segment out as a param', () => {
    expect(matchRoute(routes, '/api/customers/12')).toEqual({
      file: 'customers/[id].js', params: { id: '12' },
    });
  });

  it('matches a nested route under a dynamic segment', () => {
    expect(matchRoute(routes, '/api/customers/12/card')).toEqual({
      file: 'customers/[id]/card.js', params: { id: '12' },
    });
    expect(matchRoute(routes, '/api/customers/12/full')).toEqual({
      file: 'customers/[id]/full.js', params: { id: '12' },
    });
  });

  it('decodes an encoded id rather than handing the handler the raw escape', () => {
    expect(matchRoute(routes, '/api/customers/acme%2Fwest')).toEqual({
      file: 'customers/[id].js', params: { id: 'acme/west' },
    });
  });

  it('prefers the literal route when a dynamic one is the same shape', () => {
    // /api/customers/index would be reachable as [id]="index"; the literal wins.
    const withCollision = buildRoutes(['customers/[id].js', 'customers/active.js']);
    expect(matchRoute(withCollision, '/api/customers/active')).toEqual({
      file: 'customers/active.js', params: {},
    });
  });

  it('returns null for anything outside /api and for unknown routes', () => {
    expect(matchRoute(routes, '/customers/12')).toBeNull();
    expect(matchRoute(routes, '/api')).toBeNull();
    expect(matchRoute(routes, '/api/')).toBeNull();
    expect(matchRoute(routes, '/api/nope')).toBeNull();
    // A helper must not be reachable as a route just because it sits in api/.
    expect(matchRoute(routes, '/api/_auth')).toBeNull();
    // Depth has to match too — no falling back to a shorter route.
    expect(matchRoute(routes, '/api/customers/12/card/extra')).toBeNull();
  });
});
