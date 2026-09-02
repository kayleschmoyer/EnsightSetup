/**
 * DriveConfigService — the browser side of the shared "Site-configs" Drive
 * folder. Talks only to this app's own api/drive-configs/* routes (session
 * cookie, same as CustomerRepository.js), which read Drive with the server's
 * service account. No Google OAuth consent, no Drive token and no folder id in
 * the browser — that is what separates this from the legacy
 * GoogleDriveService.js flow.
 */

export const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';

/**
 * @returns {Promise<Array<{ id: string, name: string, mimeType: string,
 *   modifiedTime?: string, webViewLink?: string, appProperties?: object }>>}
 */
export async function listDriveConfigFiles({ signal } = {}) {
  const res = await fetch('/api/drive-configs', { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `Could not list Drive site-configs (${res.status}).`);
  return Array.isArray(body?.files) ? body.files : [];
}

/**
 * Download one config file as xlsx bytes (native Sheets are exported server-side).
 * @param {string} fileId
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ buffer: ArrayBuffer, name: string, mimeType: string }>}
 */
export async function downloadDriveConfigFile(fileId, { signal } = {}) {
  if (!fileId) throw new Error('No Drive file selected.');
  const res = await fetch(`/api/drive-configs/${encodeURIComponent(fileId)}`, { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `Could not download the config file (${res.status}).`);
  }
  const buffer = await res.arrayBuffer();
  const rawName = res.headers.get('X-Drive-File-Name') || '';
  let name = '';
  try {
    name = decodeURIComponent(rawName);
  } catch {
    name = rawName;
  }
  return { buffer, name, mimeType: res.headers.get('X-Drive-Mime-Type') || '' };
}
