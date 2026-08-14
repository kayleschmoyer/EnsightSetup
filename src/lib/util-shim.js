// Minimal browser shim for Node.js 'util' module used by xml-js/sax
export function debuglog() {
  return function () {};
}
export function inspect(obj) {
  return JSON.stringify(obj);
}
export default { debuglog, inspect };
