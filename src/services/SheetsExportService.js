import { getSession } from './GoogleAuthService';

const EXPORT_URL = import.meta.env.VITE_SHEETS_EXPORT_URL || '/api/export-to-sheets';

/**
 * Trigger the one-way "Export to Sheets" serverless function (api/export-to-sheets.js)
 * for one customer. Requires a signed-in session — the endpoint verifies the session
 * cookie server-side before touching Google Sheets (see api/_auth.js).
 * @param {string} customerId
 * @returns {Promise<{ spreadsheetId: string, spreadsheetUrl: string, changedTabs: string[], blockedWrite: object|null }>}
 */
export async function exportCustomerToSheets(customerId) {
  const session = await getSession();
  if (!session) throw new Error('Sign in to export to Google Sheets.');

  const response = await fetch(EXPORT_URL, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerId }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || `Export failed (${response.status}).`);
  }
  return data;
}
