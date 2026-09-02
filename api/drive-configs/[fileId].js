/**
 * GET /api/drive-configs/[fileId] — download one site-config file from the
 * shared Drive folder as xlsx bytes, for src/services/ExcelParserService.js.
 *
 * Native Google Sheets are exported as xlsx (Drive files.export); real .xlsx
 * files are streamed as-is (alt=media). The file must be a direct child of
 * the shared folder — a valid id for a file elsewhere on Drive is refused, so
 * this route can never be used to pull arbitrary files the service account
 * happens to see. Read-only scope, same session gate as api/customers/*.
 */
/* global Buffer */
import { json } from '../_http.js';
import { requireEnsightSession, UnauthorizedError } from '../_auth.js';
import {
  DRIVE_API, DRIVE_READONLY_SCOPES, SPREADSHEET_MIME, XLSX_MIME,
  googleAccessToken, googleFetch, sharedFolderId, isValidDriveFileId, GoogleApiError,
} from '../_google.js';

/** Same ceiling the old browser-side downloader enforced. */
export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

export class DriveFileError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'DriveFileError';
    this.statusCode = status;
  }
}

/**
 * @returns {Promise<{ name: string, mimeType: string, bytes: Buffer }>}
 */
export async function downloadDriveConfigFile(fileId, { token, folderId = sharedFolderId() } = {}) {
  if (!isValidDriveFileId(fileId)) throw new DriveFileError(400, 'Invalid file id.');
  const accessToken = token || await googleAccessToken(DRIVE_READONLY_SCOPES);

  const meta = await googleFetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,parents&supportsAllDrives=true`,
    accessToken,
  );
  if (!(meta.parents || []).includes(folderId)) {
    throw new DriveFileError(403, 'File is not in the shared Site-configs folder.');
  }
  if (meta.mimeType !== SPREADSHEET_MIME && meta.mimeType !== XLSX_MIME) {
    throw new DriveFileError(415, 'Only Excel (.xlsx) files and Google Sheets can be imported.');
  }
  const size = Number.parseInt(meta.size, 10);
  if (Number.isFinite(size) && size > MAX_FILE_SIZE_BYTES) {
    throw new DriveFileError(413, `File too large. Maximum size is ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB.`);
  }

  const isNativeSheet = meta.mimeType === SPREADSHEET_MIME;
  const url = isNativeSheet
    ? `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(XLSX_MIME)}&supportsAllDrives=true`
    : `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new GoogleApiError(response.status, `Google API error (${response.status}): ${text.slice(0, 300)}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_FILE_SIZE_BYTES) {
    throw new DriveFileError(413, `File too large. Maximum size is ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB.`);
  }
  return { name: meta.name || '', mimeType: meta.mimeType, bytes };
}

export default async function handler(req, res) {
  const { fileId } = req.query;
  try {
    await requireEnsightSession(req);
    if (req.method !== 'GET') {
      json(res, 405, { error: 'Method not allowed.' });
      return;
    }
    const { name, mimeType, bytes } = await downloadDriveConfigFile(fileId);
    res.statusCode = 200;
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'no-store');
    // Original Drive name + type, so the client can key the customer off the
    // filename exactly as the catalog does (customerIdFromFileName).
    res.setHeader('X-Drive-File-Name', encodeURIComponent(name));
    res.setHeader('X-Drive-Mime-Type', mimeType);
    res.end(bytes);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      json(res, 401, { error: err.message });
      return;
    }
    if (err instanceof DriveFileError) {
      json(res, err.statusCode, { error: err.message });
      return;
    }
    if (err instanceof GoogleApiError) {
      json(res, 502, { error: err.message });
      return;
    }
    json(res, 500, { error: err.message || 'Server error.' });
  }
}
