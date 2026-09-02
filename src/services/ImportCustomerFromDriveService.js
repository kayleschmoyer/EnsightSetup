/**
 * Import a customer from a site-config spreadsheet in the shared Drive folder
 * and land it in the database — the replacement for OpenConfigFromDriveService
 * (which hydrated memory only and needed a per-user Drive token).
 *
 *   Drive file (via api/drive-configs) → parseExcelFile → buildCustomerFromWorkbook
 *     → CustomerRepository.createCustomer | saveCustomerFull → store
 *
 * A first import creates the customers row (and the whole tree) in one POST; a
 * re-import of an already imported customer replaces its tree with what the
 * sheet says now (forced, no updated_at guard — the caller has already asked
 * the user to confirm). Either way the store is hydrated from the response,
 * marked 'hydrated', and the customer is opened.
 */
import { downloadDriveConfigFile } from './DriveConfigService';
import { parseExcelFile } from './ExcelParserService';
import { createCustomer, saveCustomerFull } from './CustomerRepository';
import { buildCustomerFromWorkbook } from '../lib/importedWorkbookMapping';
import { findLocalCustomerForCatalogRow } from '../lib/driveConfigCatalog';

function assertNotAborted(signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

/**
 * Which local customer (if any) a Drive file maps onto: by Drive file id first
 * (a customer keeps its source file), then by the customer id the sheet /
 * file name yields. Exported for the selector, which needs the same answer to
 * decide whether to show the "replace" confirmation before importing.
 */
export function findCustomerForDriveFile(customers = [], file, { customerId = null } = {}) {
  const byFile = findLocalCustomerForCatalogRow(customers, file ? { key: customerId || '', file } : null);
  if (byFile) return byFile;
  if (!customerId) return null;
  return customers.find((c) => c.customerId === customerId) || null;
}

/**
 * @param {object} params
 * @param {{ id: string, name: string, mimeType?: string, webViewLink?: string }} params.file
 * @param {object[]} params.customers - current store customers
 * @param {{ addCustomer: Function, updateCustomer: Function, selectCustomer: Function,
 *   setHydration?: Function }} params.store
 * @param {object|null} [params.existingCustomer] - the customer to replace, when the caller
 *   already matched one (falls back to findCustomerForDriveFile)
 * @param {boolean} [params.select] - open the customer once imported (default true); the
 *   selector passes false so it can show the import summary first
 * @param {AbortSignal|null} [params.signal]
 * @returns {Promise<{ customerId: string, mode: 'created'|'replaced', summary: object,
 *   warnings: string[], friendlyName: string }>}
 */
export async function importCustomerFromDrive({
  file,
  customers = [],
  store,
  existingCustomer = null,
  select = true,
  signal = null,
}) {
  if (!file?.id) throw new Error('No Drive file selected.');
  if (!store?.addCustomer || !store?.updateCustomer || !store?.selectCustomer) {
    throw new Error('App store actions are required to import a configuration.');
  }
  assertNotAborted(signal);

  const downloaded = await downloadDriveConfigFile(file.id, { signal });
  assertNotAborted(signal);
  const sourceFile = { ...file, name: file.name || downloaded.name, mimeType: file.mimeType || downloaded.mimeType };

  const parsed = parseExcelFile(downloaded.buffer);
  // Match on the sheet's own customer id before deciding create vs replace —
  // customers.customer_id is unique, so importing a second file that names an
  // existing id must land on that row, never on a duplicate insert.
  const preview = buildCustomerFromWorkbook(parsed, { file: sourceFile, existingCustomer });
  const target = existingCustomer
    || findCustomerForDriveFile(customers, sourceFile, { customerId: preview.customerId });
  const built = target === existingCustomer
    ? preview
    : buildCustomerFromWorkbook(parsed, { file: sourceFile, existingCustomer: target });
  assertNotAborted(signal);

  const { warnings, summary, sourceFileName, ...customer } = built;

  if (!target) {
    const created = await createCustomer(customer);
    const entry = store.addCustomer({
      ...created.customer,
      sourceFileName,
      lastSetupSavedAt: created.updatedAt,
    });
    store.setHydration?.(entry.id, 'hydrated');
    if (select) store.selectCustomer(entry.id);
    return { customerId: entry.id, mode: 'created', summary, warnings, friendlyName: customer.friendlyName };
  }

  const result = await saveCustomerFull(target.id, customer, { expectedUpdatedAt: null });
  if (result.status !== 'saved') {
    throw new Error('The customer could not be replaced — someone else is saving it right now. Try again.');
  }
  store.updateCustomer(target.id, {
    ...customer,
    sourceFileName,
    lastSetupSavedAt: result.updatedAt,
  });
  store.setHydration?.(target.id, 'hydrated');
  if (select) store.selectCustomer(target.id);
  return { customerId: target.id, mode: 'replaced', summary, warnings, friendlyName: customer.friendlyName };
}
