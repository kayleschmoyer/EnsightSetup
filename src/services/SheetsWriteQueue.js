/**
 * SheetsWriteQueue - one serialization point per spreadsheet.
 *
 * Two independent pipelines write to the same spreadsheet: per-action config
 * tab syncs, and the debounced SetupJson snapshot. They used to be uncoordinated
 * — only the config syncs were queued — which was survivable while every write
 * was an isolated full-tab overwrite.
 *
 * It stopped being survivable once SetupJson began committing through a staging
 * tab. Two overlapping snapshot saves share one staging tab name, so the second
 * would delete the first's half-written scratch tab underneath it. Both flows
 * now share this queue, so a spreadsheet only ever has one write in flight.
 *
 * This serializes within a browser tab. Cross-client safety comes from the
 * revision checks at the callers, not from here.
 */

const queues = new Map();
const lastRunAt = new Map();

/** Floor between consecutive writes to one spreadsheet, to stay under quota. */
export const MIN_WRITE_INTERVAL_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` once every earlier write to this spreadsheet has settled.
 * @param {string} spreadsheetId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
export function enqueueSheetWrite(spreadsheetId, fn) {
  // A rejected predecessor must not cancel the rest of the queue.
  const prev = (queues.get(spreadsheetId) || Promise.resolve()).catch(() => {});
  const next = prev.then(async () => {
    const waitMs = MIN_WRITE_INTERVAL_MS - (Date.now() - (lastRunAt.get(spreadsheetId) || 0));
    if (waitMs > 0) await sleep(waitMs);
    lastRunAt.set(spreadsheetId, Date.now());
    return fn();
  });

  const chain = next.catch(() => {});
  queues.set(spreadsheetId, chain);
  chain.then(() => {
    // Only the tail clears the slot; a later write may already have claimed it.
    if (queues.get(spreadsheetId) === chain) queues.delete(spreadsheetId);
  });
  return next;
}

/** Test helper: drop all queue state. */
export function __resetSheetsWriteQueue() {
  queues.clear();
  lastRunAt.clear();
}
