/**
 * Minimal browser globals for testing the store under vitest's `node`
 * environment. Only what useAppStore touches at module scope and during
 * navigation — enough to exercise real store logic without pulling in jsdom.
 */

function createStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    __map: map,
  };
}

/**
 * Install localStorage / sessionStorage / window / history shims.
 * @param {{ pathname?: string }} [options]
 */
export function installBrowserEnv({ pathname = '/' } = {}) {
  const localStorage = createStorage();
  const sessionStorage = createStorage();
  const listeners = new Map();

  const location = { pathname, href: `https://example.test${pathname}`, origin: 'https://example.test' };
  const history = {
    entries: [pathname],
    pushState(_state, _title, url) { location.pathname = url; history.entries.push(url); },
    replaceState(_state, _title, url) { location.pathname = url; history.entries[history.entries.length - 1] = url; },
    back() {},
    forward() {},
  };

  const window = {
    localStorage,
    sessionStorage,
    location,
    history,
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => { listeners.get(type)?.delete(fn); },
    dispatchEvent: (event) => {
      for (const fn of listeners.get(event.type) || []) fn(event);
      return true;
    },
  };

  globalThis.window = window;
  globalThis.localStorage = localStorage;
  globalThis.sessionStorage = sessionStorage;
  globalThis.document = globalThis.document || {
    documentElement: { classList: { toggle: () => {} } },
  };

  return { window, localStorage, sessionStorage, location, history };
}
