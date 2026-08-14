/**
 * Browser localStorage helpers for "remember opened customers".
 *
 * The Google Sheet is the database. For any customer backed by one, localStorage
 * holds *pointers only* — who they are and where their sheet lives — never
 * layout. Anything the sheet does not contain must not appear in the app, and
 * the surest way to guarantee that is to have no local copy to fall back on.
 *
 * Earlier versions kept garage/level "stubs" so deep links could resolve before
 * SetupJson arrived. That is what let the app render levels the sheet had never
 * heard of, and — because a stub looks like a real (empty) layout — what let a
 * failed load get written back over good data. Route restore now defers slug
 * resolution until after hydrate instead.
 *
 * Customers with no linked sheet are stored whole: there is no remote copy to
 * defer to, so dropping their layout would destroy it.
 */
import { customerCanSyncToSheet } from './customerConfigUtils';

/**
 * Fields that identify a customer and locate its config. Everything else is
 * owned by the sheet and must be re-read.
 */
const POINTER_FIELDS = Object.freeze([
  'id',
  'customerId',
  'code',
  'friendlyName',
  'spreadsheetId',
  'spreadsheetUrl',
  'spreadsheetTitle',
  'sourceFileId',
  'sourceFileName',
]);

/**
 * @param {object} customer
 * @returns {object}
 */
export function slimCustomerForLocalPersistence(customer) {
  if (!customer || typeof customer !== 'object') return customer;
  if (!customerCanSyncToSheet(customer)) return customer;

  const pointer = {};
  for (const field of POINTER_FIELDS) {
    if (customer[field] !== undefined) pointer[field] = customer[field];
  }

  return {
    ...pointer,
    // `null` means "not loaded" and is what tells the store to hydrate and the
    // UI to wait. An empty array would mean "loaded, and this customer has no
    // sites" — a claim we cannot make without reading the sheet.
    garages: null,
    lastSetupSavedAt: null,
  };
}

/**
 * @param {object[]} customers
 * @returns {object[]}
 */
export function customersForLocalPersistence(customers) {
  if (!Array.isArray(customers)) return [];
  return customers.map(slimCustomerForLocalPersistence);
}
