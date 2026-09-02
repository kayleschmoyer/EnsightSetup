/**
 * GET /api/drive-configs — list the site-config spreadsheets (xlsx or native
 * Google Sheets) sitting directly in the shared "Site-configs" Drive folder.
 *
 * Read with the service account (see api/_google.js), so a signed-in
 * @ensight-technologies.com user needs no Drive consent of their own and the
 * folder id never ships to the browser. Pages through files.list to the end
 * and returns a flat list the client feeds into
 * src/lib/driveConfigCatalog.js (mergeConfigFilesIntoCatalog).
 */
import { json } from '../_http.js';
import { requireEnsightSession, UnauthorizedError } from '../_auth.js';
import {
  DRIVE_API, DRIVE_READONLY_SCOPES, SPREADSHEET_MIME, XLSX_MIME,
  googleAccessToken, googleFetch, sharedFolderId, GoogleApiError,
} from '../_google.js';

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,webViewLink,appProperties';

/** Every config file directly under the shared folder, newest first. */
export async function listDriveConfigFiles({ token, folderId = sharedFolderId() } = {}) {
  const accessToken = token || await googleAccessToken(DRIVE_READONLY_SCOPES);
  const q = `'${folderId}' in parents and trashed=false and (mimeType='${XLSX_MIME}' or mimeType='${SPREADSHEET_MIME}')`;
  const files = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({
      q,
      pageSize: '100',
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      orderBy: 'modifiedTime desc',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await googleFetch(`${DRIVE_API}/files?${params.toString()}`, accessToken);
    files.push(...(page.files || []));
    pageToken = page.nextPageToken || null;
  } while (pageToken);
  return files;
}

export default async function handler(req, res) {
  try {
    await requireEnsightSession(req);
    if (req.method !== 'GET') {
      json(res, 405, { error: 'Method not allowed.' });
      return;
    }
    const files = await listDriveConfigFiles();
    json(res, 200, { folderId: sharedFolderId(), files });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      json(res, 401, { error: err.message });
      return;
    }
    if (err instanceof GoogleApiError && (err.status === 403 || err.status === 404)) {
      json(res, 502, {
        error: 'The shared Site-configs folder is not readable by the service account. '
          + 'Share the folder with the service-account email (Viewer) and check GOOGLE_SHARED_FOLDER_ID.',
      });
      return;
    }
    json(res, 500, { error: err.message || 'Server error.' });
  }
}
