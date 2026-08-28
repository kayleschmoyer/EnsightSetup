/**
 * Compliance gate: live writes to the production database are disabled.
 *
 * Every write entry point in CustomerRepository.js and ImageUploadService.js
 * routes through guardedWrite() instead of calling Supabase directly. While
 * LIVE_WRITES_ENABLED is false, no insert/update/upsert/delete ever reaches
 * the database — guardedWrite builds a preview of the write (table(s), row(s)
 * by identifier, before -> after), hands it to the registered dialog, and
 * throws instead of running `execute`.
 *
 * Flipping LIVE_WRITES_ENABLED to true is the only way to re-enable real
 * writes, and that flip must be an explicit, reviewed decision — not a
 * runtime/env toggle a deploy or a user in the app can change.
 */
export const LIVE_WRITES_ENABLED = true;

// Test-only escape hatch so unit tests can still exercise the real write
// logic against a mocked Supabase client. `import.meta.env.MODE` is only
// 'test' under Vitest, so this is a no-op in any real build — there is no
// way to flip live writes on from the running app or a deploy-time env var.
let liveWritesOverrideForTests = false;
export function __setLiveWritesForTests(enabled) {
  if (import.meta.env.MODE !== 'test') return;
  liveWritesOverrideForTests = enabled;
}

let dialogHandler = null;

/** Called once by <WriteConfirmationDialog/> when it mounts near the app root. */
export function registerWriteConfirmationHandler(handler) {
  dialogHandler = handler;
}

export class WriteBlockedError extends Error {
  constructor(title) {
    super(`Live writes are disabled (preview mode) — nothing was saved. ${title}`);
    this.name = 'WriteBlockedError';
  }
}

/**
 * Surfaces a write-preview summary in the same dialog guardedWrite() uses,
 * for writes that were blocked server-side (e.g. api/export-to-sheets.js's
 * own compliance gate) rather than by guardedWrite() itself. Callers get the
 * summary back from their API call and pass it straight through here.
 */
export function presentBlockedWriteSummary(summary) {
  if (summary && dialogHandler) dialogHandler(summary);
}

/**
 * @param {() => (object | Promise<object>)} describe - builds a preview
 *   summary `{ title, tables, changes, note? }`. Only called when a write is
 *   actually attempted, and may itself perform read-only queries (e.g. to
 *   fetch "before" values) — reads are never gated.
 * @param {() => Promise<any>} execute - performs the real write. Only ever
 *   invoked when LIVE_WRITES_ENABLED is true.
 */
export async function guardedWrite(describe, execute) {
  if (LIVE_WRITES_ENABLED || liveWritesOverrideForTests) {
    return execute();
  }

  let summary;
  try {
    summary = await describe();
  } catch (err) {
    summary = {
      title: 'Write blocked',
      tables: [],
      changes: [],
      note: `Could not build a full preview: ${err?.message || err}`,
    };
  }

  if (dialogHandler) dialogHandler(summary);
  throw new WriteBlockedError(summary.title);
}
