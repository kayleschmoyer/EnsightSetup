/**
 * Test setup. Runs for every test file; the browser shims below no-op under the
 * default `node` environment and only apply to files opting into jsdom via
 * `// @vitest-environment jsdom`.
 *
 * jsdom implements the DOM but not the browser APIs around it, so anything a
 * component calls on mount has to be provided here or the render throws before
 * a single assertion runs.
 */

if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    window.matchMedia = (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  }

  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    globalThis.ResizeObserver = window.ResizeObserver;
  }

  if (!window.IntersectionObserver) {
    window.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    };
    globalThis.IntersectionObserver = window.IntersectionObserver;
  }

  // Radix UI primitives call these on open/close.
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};

  if (!window.URL.createObjectURL) window.URL.createObjectURL = () => 'blob:test';
  if (!window.URL.revokeObjectURL) window.URL.revokeObjectURL = () => {};
}
