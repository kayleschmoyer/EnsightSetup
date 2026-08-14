/**
 * GoogleDriveService - Handles Google OAuth 2.0 and Google Drive file operations
 *
 * Uses Google Identity Services (GIS) for OAuth token-based auth.
 *
 * Scopes:
 *   - https://www.googleapis.com/auth/drive (read/write in shared folder)
 *   - https://www.googleapis.com/auth/spreadsheets (read/write sheet data)
 */

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
  'email',
].join(' ');
const SHARED_FOLDER_ID = import.meta.env.VITE_GOOGLE_SHARED_FOLDER_ID || '';

function assertGoogleConfig() {
  if (!CLIENT_ID) {
    throw new Error('Google OAuth is not configured. Set VITE_GOOGLE_CLIENT_ID in your environment.');
  }
  if (!SHARED_FOLDER_ID) {
    throw new Error('Google Drive folder is not configured. Set VITE_GOOGLE_SHARED_FOLDER_ID in your environment.');
  }
}
const ALLOWED_DOMAIN = 'ensight-technologies.com';

const TOKEN_STORAGE_KEY = 'garage_editor_google_token';
const TOKEN_EXPIRY_STORAGE_KEY = 'garage_editor_google_token_expires';
const HAD_GOOGLE_SESSION_KEY = 'garage_editor_had_google_session';

// Security: Maximum file size for downloads (50MB)
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

/** Per-request timeout for Drive/Sheets HTTP calls (avoids infinite spinner). */
const GOOGLE_API_TIMEOUT_MS = 45_000;
const SILENT_REFRESH_TIMEOUT_MS = 15_000;

/**
 * fetch() with an AbortController timeout.
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs]
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = GOOGLE_API_TIMEOUT_MS) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Google request timed out. Please try again.');
    }
    throw err;
  } finally {
    clearTimeout(tid);
  }
}

// Security: Allowed MIME types for file operations
const ALLOWED_MIME_TYPES = Object.freeze([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls
  'application/vnd.google-apps.spreadsheet', // native Google Sheet
]);

const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';

export { CLIENT_ID, SPREADSHEET_MIME };

/** Return the current OAuth access token (throws if not signed in). */
export function getAccessToken() {
  if (!accessToken || isTokenExpired()) {
    clearAccessToken();
    throw new Error('Not signed in. Please sign in with Google first.');
  }
  return accessToken;
}

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = null; // Track token expiration
let silentRefreshPromise = null;
const authListeners = new Set();

function notifyGoogleAuthChanged(signedInOverride, meta = {}) {
  const signedIn = typeof signedInOverride === 'boolean'
    ? signedInOverride
    : (Boolean(accessToken) && !(tokenExpiresAt && Date.now() > tokenExpiresAt));
  for (const listener of authListeners) {
    try {
      listener(signedIn, meta);
    } catch {
      // ignore listener errors
    }
  }
}

/** Notify subscribers of auth / Drive-access state (used after verifySharedFolderAccess). */
export function publishGoogleAuthState(signedIn, meta = {}) {
  notifyGoogleAuthChanged(signedIn, meta);
}

/** Subscribe to Google sign-in / sign-out changes. Returns an unsubscribe function. */
export function subscribeGoogleAuth(listener) {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

/** Clear the access token and notify listeners (e.g. after API 401). */
export function invalidateGoogleAccessToken() {
  clearAccessToken();
}

function saveTokenToSession() {
  if (!accessToken || !tokenExpiresAt) return;
  try {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, accessToken);
    sessionStorage.setItem(TOKEN_EXPIRY_STORAGE_KEY, String(tokenExpiresAt));
    sessionStorage.setItem(HAD_GOOGLE_SESSION_KEY, '1');
  } catch {
    // sessionStorage may be unavailable in some contexts
  }
}

function clearTokenFromSession() {
  try {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    sessionStorage.removeItem(TOKEN_EXPIRY_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function restoreTokenFromSession() {
  try {
    const token = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    const expiresAt = Number(sessionStorage.getItem(TOKEN_EXPIRY_STORAGE_KEY) || 0);
    if (token && expiresAt > Date.now()) {
      accessToken = token;
      tokenExpiresAt = expiresAt;
    }
  } catch {
    // ignore
  }
}

function clearAccessToken() {
  const hadToken = Boolean(accessToken);
  accessToken = null;
  tokenExpiresAt = null;
  clearTokenFromSession();
  if (hadToken) notifyGoogleAuthChanged();
}

/** True if the user had a Google session earlier in this browser tab. */
export function hadGoogleSession() {
  try {
    return sessionStorage.getItem(HAD_GOOGLE_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

/** True when the token will expire inside the given buffer (default 10 minutes). */
export function isTokenExpiringSoon(bufferMs = 10 * 60 * 1000) {
  if (!accessToken || !tokenExpiresAt) return true;
  return Date.now() >= tokenExpiresAt - bufferMs;
}

/**
 * Silently renew the OAuth token without a consent popup (when Google still allows it).
 */
export async function refreshAccessTokenSilently() {
  if (!CLIENT_ID) {
    throw new Error('Google OAuth is not configured.');
  }
  if (silentRefreshPromise) return silentRefreshPromise;

  silentRefreshPromise = (async () => {
    await loadGisScript();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Google sign-in refresh timed out. Please sign in again.'));
      }, SILENT_REFRESH_TIMEOUT_MS);

      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          if (response.error) {
            reject(new Error(response.error_description || response.error));
            return;
          }
          accessToken = response.access_token;
          if (response.expires_in) {
            tokenExpiresAt = Date.now() + (response.expires_in * 1000) - 60000;
          } else {
            tokenExpiresAt = Date.now() + 3600000;
          }
          saveTokenToSession();
          notifyGoogleAuthChanged();
          resolve(accessToken);
        },
      });
      client.requestAccessToken({ prompt: '' });
    });
  })().finally(() => {
    silentRefreshPromise = null;
  });

  return silentRefreshPromise;
}

restoreTokenFromSession();

/**
 * Load the Google Identity Services script dynamically
 */
function loadGisScript() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) {
      resolve();
      return;
    }
    const existing = document.querySelector('script[src*="accounts.google.com/gsi/client"]');
    if (existing) {
      existing.addEventListener('load', resolve);
      existing.addEventListener('error', reject);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Failed to load Google Identity Services'));
    document.head.appendChild(script);
  });
}

/**
 * Initialize the OAuth token client and trigger the consent flow.
 * Returns an access token upon successful login.
 *
 * @returns {Promise<string>} access token
 */
function buildOriginMismatchError(origin) {
  return new Error(
    `redirect_uri_mismatch: The origin ${origin} is not registered for this OAuth client.\n\n` +
    `To fix this, open the Google Cloud Console → APIs & Credentials → OAuth 2.0 Client IDs, ` +
    `select client ${CLIENT_ID}, and add ${origin} to "Authorized JavaScript Origins".`
  );
}

/**
 * @param {Object} [options]
 * @param {'select_account'|'consent'|''} [options.prompt] - OAuth prompt mode.
 *   Use 'consent' to force re-approval of Drive scopes after a 403.
 */
export async function signInWithGoogle({ prompt = 'select_account' } = {}) {
  assertGoogleConfig();
  await loadGisScript();

  return new Promise((resolve, reject) => {
    try {
      const origin = window.location.origin;
      let popupOpenedAt = Date.now();

      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        ux_mode: 'popup',
        callback: (response) => {
          if (response.error) {
            if (response.error === 'redirect_uri_mismatch' ||
                response.error === 'invalid_request' ||
                (response.error_description && response.error_description.includes('redirect_uri_mismatch'))) {
              reject(buildOriginMismatchError(origin));
              return;
            }
            reject(new Error(response.error_description || response.error));
            return;
          }
          accessToken = response.access_token;
          // Track token expiration (expires_in is in seconds)
          if (response.expires_in) {
            tokenExpiresAt = Date.now() + (response.expires_in * 1000) - 60000; // 1 min buffer
          } else {
            tokenExpiresAt = Date.now() + 3600000; // Default 1 hour
          }
          saveTokenToSession();
          // Verify the signed-in account belongs to the allowed domain
          fetchWithTimeout('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` },
          }, 15_000)
            .then(r => r.json())
            .then(info => {
              const email = info.email || '';
              if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) {
                clearAccessToken();
                reject(new Error(`Access restricted to @${ALLOWED_DOMAIN} accounts. You signed in as ${email}.`));
              } else {
                notifyGoogleAuthChanged();
                resolve(accessToken);
              }
            })
            .catch(() => reject(new Error('Could not verify account domain.')));
        },
        error_callback: (err) => {
          if (err.type === 'popup_failed_to_open') {
            reject(new Error(
              'Could not open sign-in popup. Please allow popups for this site and try again.'
            ));
          } else if (err.type === 'popup_closed') {
            // If the popup closed very quickly, it likely showed an error page
            // (e.g. redirect_uri_mismatch) that the user had to dismiss.
            const elapsed = Date.now() - popupOpenedAt;
            if (elapsed < 3000) {
              reject(buildOriginMismatchError(origin));
            } else {
              reject(new Error('Sign-in popup was closed before completing authentication.'));
            }
          } else {
            reject(new Error(
              `OAuth error: ${err.message || err.type || 'unknown'}. ` +
              `If you see "redirect_uri_mismatch", add ${origin} to Authorized JavaScript Origins ` +
              `in the Google Cloud Console for OAuth client ${CLIENT_ID}.`
            ));
          }
        },
      });
      popupOpenedAt = Date.now();
      tokenClient.requestAccessToken({ prompt });
    } catch (err) {
      reject(err);
    }
  });
}

function parseDriveApiError(status, errBody) {
  const msg = errBody?.error?.message || '';
  const reason = errBody?.error?.errors?.[0]?.reason || '';

  if (status === 403) {
    if (/has not been used|is disabled/i.test(msg)) {
      return (
        'Google Drive API is not enabled for this OAuth app. ' +
        'An administrator must enable the Drive API in Google Cloud Console for this client.'
      );
    }
    if (
      reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'
      || /insufficient.*(authentication )?scopes/i.test(msg)
    ) {
      return (
        'Google sign-in is missing permissions needed for Excel configs (create Sheet copy). ' +
        'Sign out, remove EnSight Technologies at myaccount.google.com/permissions, ' +
        'sign in again, and approve all Drive and Sheets access.'
      );
    }
    if (reason === 'insufficientPermissions' || /permission|forbidden/i.test(msg)) {
      return (
        'Google Drive access was denied. Sign out, then sign in again and approve Drive permissions. ' +
        'If the problem persists, ask an administrator to share the configuration folder with your account.'
      );
    }
    return msg || 'Google Drive access denied (403). Try signing in again with Drive permissions.';
  }

  if (status === 401) {
    return 'Session expired. Please sign in again.';
  }

  return msg || `Google Drive API error (${status})`;
}

/**
 * Verify the signed-in user can read the shared configuration folder.
 * @returns {Promise<boolean>}
 */
export async function verifySharedFolderAccess() {
  if (!accessToken || isTokenExpired()) return false;
  try {
    const params = new URLSearchParams({
      q: `'${SHARED_FOLDER_ID}' in parents and trashed=false`,
      pageSize: '1',
      fields: 'files(id)',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    const response = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Check if we currently have a valid access token
 */
export function isSignedIn() {
  // Check both token existence and expiration
  if (!accessToken) return false;
  if (tokenExpiresAt && Date.now() > tokenExpiresAt) {
    clearAccessToken();
    return false;
  }
  return true;
}

/**
 * Check if token is expired or will expire soon
 */
export function isTokenExpired() {
  if (!accessToken || !tokenExpiresAt) return true;
  return Date.now() > tokenExpiresAt;
}

/**
 * Sign out / revoke the current token
 */
export function signOut() {
  if (accessToken && window.google?.accounts?.oauth2) {
    window.google.accounts.oauth2.revoke(accessToken);
  }
  const hadToken = Boolean(accessToken);
  accessToken = null;
  tokenClient = null;
  tokenExpiresAt = null;
  clearTokenFromSession();
  try {
    sessionStorage.removeItem(HAD_GOOGLE_SESSION_KEY);
  } catch {
    // ignore
  }
  if (hadToken) notifyGoogleAuthChanged();
}

/**
 * Validate file ID format to prevent injection
 * Google Drive file IDs are alphanumeric with hyphens and underscores
 */
function isValidFileId(fileId) {
  if (!fileId || typeof fileId !== 'string') return false;
  // Google Drive IDs are typically 28-44 characters, alphanumeric with - and _
  return /^[a-zA-Z0-9_-]{10,100}$/.test(fileId);
}

/**
 * Sanitize search query to prevent query injection
 */
function sanitizeSearchQuery(query) {
  if (!query || typeof query !== 'string') return '';
  // Remove potentially dangerous characters, keep alphanumeric, spaces, and common punctuation
  return query
    .trim()
    .slice(0, 100) // Limit length
    .replace(/[^\w\s.-]/g, '') // Only allow word chars, spaces, dots, hyphens
    .replace(/'/g, "\\'"); // Escape quotes
}

/** Escape a value for use inside a Drive API `name='...'` query clause. */
function escapeDriveQueryValue(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

/**
 * Find an existing config file in the shared folder by sheet title.
 * @param {string} sheetTitle - e.g. "EastCentral-config"
 * @param {{ spreadsheetsOnly?: boolean }} [options]
 *   When spreadsheetsOnly is true, only matches native Google Sheets (not .xlsx).
 * @returns {Promise<{ id: string, name: string, mimeType: string, webViewLink?: string }|null>}
 */
export async function findConfigSheetInFolder(sheetTitle, {
  spreadsheetsOnly = false,
  excludeFileIds = [],
} = {}) {
  assertGoogleConfig();
  if (!accessToken || isTokenExpired()) {
    throw new Error('Not signed in. Please sign in with Google first.');
  }

  const title = String(sheetTitle || '').trim();
  if (!title) return null;

  const mimeClause = spreadsheetsOnly
    ? `mimeType='${SPREADSHEET_MIME}'`
    : `(mimeType='${SPREADSHEET_MIME}' or mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')`;

  const candidates = spreadsheetsOnly ? [title] : [title, `${title}.xlsx`];
  const nameClause = candidates.map((n) => `name='${escapeDriveQueryValue(n)}'`).join(' or ');
  const q = `'${SHARED_FOLDER_ID}' in parents and trashed=false and ${mimeClause} and (${nameClause})`;

  const params = new URLSearchParams({
    q,
    pageSize: '10',
    fields: 'files(id,name,mimeType,webViewLink)',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });

  const response = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (response.status === 401) {
    clearAccessToken();
    throw new Error('Session expired. Please sign in again.');
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(parseDriveApiError(response.status, err));
  }

  const data = await response.json();
  const target = title.toLowerCase();
  const targetXlsx = `${title}.xlsx`.toLowerCase();
  const exclude = new Set(
    (Array.isArray(excludeFileIds) ? excludeFileIds : []).filter(Boolean),
  );

  const match = (data.files || []).find((file) => {
    if (exclude.has(file.id)) return false;
    const name = String(file.name || '').toLowerCase();
    if (spreadsheetsOnly) return name === target;
    return name === target || name === targetXlsx;
  });

  return match || null;
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function listFolderFilesPage({ pageToken, pageSize = 100, searchQuery, mimeClause } = {}) {
  assertGoogleConfig();
  if (!accessToken) {
    throw new Error('Not signed in. Please sign in with Google first.');
  }
  if (isTokenExpired()) {
    clearAccessToken();
    throw new Error('Session expired. Please sign in again.');
  }

  const safePageSize = Math.min(Math.max(1, parseInt(pageSize, 10) || 100), 100);
  let q = `'${SHARED_FOLDER_ID}' in parents and ${mimeClause} and trashed=false`;
  if (searchQuery && searchQuery.trim()) {
    const sanitized = sanitizeSearchQuery(searchQuery);
    if (sanitized) {
      q += ` and name contains '${sanitized}'`;
    }
  }

  const params = new URLSearchParams({
    q,
    pageSize: String(safePageSize),
    fields: 'nextPageToken,files(id,name,modifiedTime,size,mimeType,owners,iconLink,webViewLink,appProperties)',
    orderBy: 'modifiedTime desc',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  if (pageToken) {
    params.set('pageToken', pageToken);
  }

  const response = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (response.status === 401) {
    clearAccessToken();
    throw new Error('Session expired. Please sign in again.');
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const message = parseDriveApiError(response.status, err);
    const error = new Error(message);
    if (response.status === 403) error.code = 'DRIVE_FORBIDDEN';
    throw error;
  }

  const data = await response.json();
  const safeFiles = (data.files || []).filter((file) => ALLOWED_MIME_TYPES.includes(file.mimeType));

  return {
    files: safeFiles,
    nextPageToken: data.nextPageToken || null,
  };
}

/**
 * List xlsx files from the shared Google Drive folder.
 * Supports pagination via pageToken.
 *
 * @param {Object} options
 * @param {string} [options.pageToken] - token for next page
 * @param {number} [options.pageSize=100] - results per page
 * @param {string} [options.searchQuery] - optional name filter
 * @returns {Promise<{files: Array, nextPageToken: string|null}>}
 */
export async function listXlsxFiles({ pageToken, pageSize = 100, searchQuery } = {}) {
  return listFolderFilesPage({
    pageToken,
    pageSize,
    searchQuery,
    mimeClause: `mimeType='${XLSX_MIME}'`,
  });
}

/**
 * List xlsx + native Google Sheets from the shared folder (one page).
 */
export async function listConfigFilesInFolder({ pageToken, pageSize = 100, searchQuery } = {}) {
  return listFolderFilesPage({
    pageToken,
    pageSize,
    searchQuery,
    mimeClause: `(mimeType='${XLSX_MIME}' or mimeType='${SPREADSHEET_MIME}')`,
  });
}

/**
 * Fetch every page of config files (xlsx + Google Sheets) from the shared folder.
 * @returns {Promise<{files: Array}>}
 */
export async function listAllConfigFilesInFolder({ searchQuery } = {}) {
  const files = [];
  let pageToken;
  do {
    const page = await listConfigFilesInFolder({ pageToken, pageSize: 100, searchQuery });
    files.push(...page.files);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return { files };
}

/**
 * Download an xlsx (or export a native Google Sheet as xlsx) as an ArrayBuffer.
 *
 * @param {string} fileId - Google Drive file ID
 * @returns {Promise<ArrayBuffer>}
 */
export async function downloadFile(fileId) {
  return downloadConfigFile(fileId);
}

/**
 * Download a config file for parsing.
 * Native Google Sheets are exported as .xlsx so ExcelParserService can read them.
 *
 * @param {string} fileId - Google Drive file ID
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<ArrayBuffer>}
 */
export async function downloadConfigFile(fileId, options = {}) {
  assertGoogleConfig();
  if (!isValidFileId(fileId)) {
    throw new Error('Invalid file ID format.');
  }

  if (!accessToken) {
    throw new Error('Not signed in. Please sign in with Google first.');
  }

  if (isTokenExpired()) {
    clearAccessToken();
    throw new Error('Session expired. Please sign in again.');
  }

  const metaResponse = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,size,mimeType,parents&supportsAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: options.signal,
    }
  );

  if (metaResponse.status === 401) {
    clearAccessToken();
    throw new Error('Session expired. Please sign in again.');
  }

  if (!metaResponse.ok) {
    const err = await metaResponse.json().catch(() => ({}));
    throw new Error(err.error?.message || `Failed to get file info (${metaResponse.status})`);
  }

  const fileMeta = await metaResponse.json();

  const parents = fileMeta.parents || [];
  if (!parents.includes(SHARED_FOLDER_ID)) {
    throw new Error('File is not in the authorized configuration folder.');
  }

  if (!ALLOWED_MIME_TYPES.includes(fileMeta.mimeType)) {
    throw new Error('File type not allowed. Only Excel (.xlsx) or Google Sheets are supported.');
  }

  const isNativeSheet = fileMeta.mimeType === SPREADSHEET_MIME;
  // Native sheets often omit size; only enforce the limit when Drive reports one.
  const fileSize = parseInt(fileMeta.size, 10);
  if (Number.isFinite(fileSize) && fileSize > MAX_FILE_SIZE_BYTES) {
    throw new Error(`File too large. Maximum size is ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB.`);
  }

  const downloadUrl = isNativeSheet
    ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(XLSX_MIME)}&supportsAllDrives=true`
    : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;

  const response = await fetchWithTimeout(downloadUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: options.signal,
  }, 120_000);

  if (response.status === 401) {
    clearAccessToken();
    throw new Error('Session expired. Please sign in again.');
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Failed to download file (${response.status})`);
  }

  return response.arrayBuffer();
}

/**
 * Fetch Drive file metadata.
 * @param {string} fileId
 * @param {string} [fields]
 */
export async function getFileMetadata(fileId, fields = 'id,name,mimeType,parents,webViewLink') {
  assertGoogleConfig();
  if (!isValidFileId(fileId)) {
    throw new Error('Invalid file ID format.');
  }
  if (!accessToken || isTokenExpired()) {
    clearAccessToken();
    throw new Error('Not signed in. Please sign in with Google first.');
  }

  const response = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (response.status === 401) {
    clearAccessToken();
    throw new Error('Session expired. Please sign in again.');
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(parseDriveApiError(response.status, err));
  }

  const meta = await response.json();
  const parents = meta.parents || [];
  if (!parents.includes(SHARED_FOLDER_ID)) {
    throw new Error('File is not in the authorized configuration folder.');
  }
  return meta;
}

/**
 * Rename a Drive file (Sheet or xlsx) in place.
 * @param {string} fileId
 * @param {string} name
 */
export async function renameDriveFile(fileId, name) {
  assertGoogleConfig();
  if (!isValidFileId(fileId)) {
    throw new Error('Invalid file ID format.');
  }
  const token = getAccessToken();
  const safeName = String(name || '').trim().slice(0, 200);
  if (!safeName) throw new Error('File name is required.');

  const response = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,name,webViewLink`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: safeName }),
    },
  );

  if (response.status === 401) {
    clearAccessToken();
    throw new Error('Session expired. Please sign in again.');
  }
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(parseDriveApiError(response.status, err));
  }
  return response.json();
}

/**
 * Update a Drive file's appProperties (shared catalog metadata, string values).
 * @param {string} fileId
 * @param {Record<string, string>} appProperties
 */
export async function updateFileAppProperties(fileId, appProperties) {
  assertGoogleConfig();
  if (!isValidFileId(fileId)) {
    throw new Error('Invalid file ID format.');
  }
  const safeProps = {};
  for (const [key, value] of Object.entries(appProperties || {})) {
    if (!key) continue;
    safeProps[key] = String(value ?? '').slice(0, 120);
  }
  if (!Object.keys(safeProps).length) return null;

  const token = getAccessToken();
  const response = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,appProperties`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ appProperties: safeProps }),
    },
  );

  if (response.status === 401) {
    clearAccessToken();
    throw new Error('Session expired. Please sign in again.');
  }
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(parseDriveApiError(response.status, err));
  }
  return response.json();
}

/**
 * Move a Drive file to trash (used to roll back failed Sheet creates).
 * @param {string} fileId
 */
export async function trashDriveFile(fileId) {
  assertGoogleConfig();
  if (!isValidFileId(fileId)) {
    throw new Error('Invalid file ID format.');
  }
  const token = getAccessToken();
  const response = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ trashed: true }),
    },
  );

  if (response.status === 401) {
    clearAccessToken();
    throw new Error('Session expired. Please sign in again.');
  }
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(parseDriveApiError(response.status, err));
  }
}
