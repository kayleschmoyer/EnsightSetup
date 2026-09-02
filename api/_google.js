/**
 * Shared server-side Google access for the Vercel functions — the service
 * account (GOOGLE_SERVICE_ACCOUNT_KEY) plus the shared customer-config Drive
 * folder id. Used by api/export-to-sheets.js (Sheets/Drive writes) and
 * api/drive-configs/* (read-only folder listing + file download for the
 * site-config import). Nothing here is ever exposed as a VITE_ variable: the
 * browser never talks to Google Drive directly for these flows, it goes
 * through these routes with its normal app session cookie.
 */
/* global process */
import { GoogleAuth } from 'google-auth-library';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';

/**
 * The "Site-configs" shared Drive folder. Overridable per environment, but the
 * production folder is fixed and not a secret, so it doubles as the default
 * rather than making every deploy fail closed on a missing env var.
 */
export const DEFAULT_SHARED_FOLDER_ID = '1OZXQcKjsZY59gnPFDThSZehJzxsvtjPU';

export const DRIVE_READONLY_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
export const SHEETS_WRITE_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

export function sharedFolderId() {
  return String(process.env.GOOGLE_SHARED_FOLDER_ID || '').trim() || DEFAULT_SHARED_FOLDER_ID;
}

/** Drive file ids are opaque but always URL-safe; reject anything else before it reaches a URL. */
export function isValidDriveFileId(fileId) {
  return typeof fileId === 'string' && /^[a-zA-Z0-9_-]{10,100}$/.test(fileId);
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
