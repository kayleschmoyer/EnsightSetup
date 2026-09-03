/**
 * Shared server-side Google access for api/export-to-sheets.js — the service
 * account (GOOGLE_SERVICE_ACCOUNT_KEY) used to write the customer-config
 * spreadsheet, plus the shared "Site-configs" Drive folder id it's created
 * in. Reading that folder for import is a separate, per-user flow
 * (src/services/GoogleDriveService.js, the browser's own Drive OAuth token)
 * and does not touch this file.
 */
/* global process */
import { GoogleAuth } from 'google-auth-library';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

export const SHEETS_WRITE_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

/**
 * The "Site-configs" shared Drive folder new exports are created in.
 * Overridable per environment, but the production folder is fixed and not a
 * secret, so it doubles as the default rather than making every deploy fail
 * closed on a missing env var.
 */
const DEFAULT_SHARED_FOLDER_ID = '1OZXQcKjsZY59gnPFDThSZehJzxsvtjPU';

export function sharedFolderId() {
  return String(process.env.GOOGLE_SHARED_FOLDER_ID || '').trim() || DEFAULT_SHARED_FOLDER_ID;
}

export async function googleAccessToken(scopes) {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not configured on the server.');
  }
  const credentials = JSON.parse(keyJson);
  const auth = new GoogleAuth({ credentials, scopes });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Could not obtain a Google access token.');
  return token;
}

export class GoogleApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GoogleApiError';
    this.status = status;
  }
}

/** JSON in / JSON out against a Google API; throws GoogleApiError with the upstream status. */
export async function googleFetch(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new GoogleApiError(response.status, `Google API error (${response.status}): ${text.slice(0, 300)}`);
  }
  return response.json();
}
