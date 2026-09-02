/**
 * api/drive-configs/* — the read-only Drive proxy for the site-config import.
 * Google is faked at the fetch boundary; what matters is that the folder
 * guard, the mime routing (Sheet export vs xlsx download), the id check and
 * the size cap all hold, since any of those failing would let the route pull
 * files it must not, or hand the parser something it cannot read.
 */
/* global process */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FOLDER = 'folder-shared-1234';

const google = vi.hoisted(() => ({
  googleAccessToken: vi.fn(async () => 'sa-token'),
}));
vi.mock('./_google.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, googleAccessToken: google.googleAccessToken };
});

const { listDriveConfigFiles } = await import('./drive-configs/index.js');
const { downloadDriveConfigFile, MAX_FILE_SIZE_BYTES } = await import('./drive-configs/[fileId].js');
const { SPREADSHEET_MIME, XLSX_MIME, sharedFolderId, DEFAULT_SHARED_FOLDER_ID } = await import('./_google.js');

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}
function bytesResponse(bytes, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => '',
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

let calls;
beforeEach(() => {
  calls = [];
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(handler) {
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }));
}

describe('sharedFolderId', () => {
  it('falls back to the production folder when the env var is unset', () => {
    const before = process.env.GOOGLE_SHARED_FOLDER_ID;
    delete process.env.GOOGLE_SHARED_FOLDER_ID;
    expect(sharedFolderId()).toBe(DEFAULT_SHARED_FOLDER_ID);
    process.env.GOOGLE_SHARED_FOLDER_ID = ' env-folder ';
    expect(sharedFolderId()).toBe('env-folder');
    if (before === undefined) delete process.env.GOOGLE_SHARED_FOLDER_ID;
    else process.env.GOOGLE_SHARED_FOLDER_ID = before;
  });
});

describe('listDriveConfigFiles', () => {
  it('queries the shared folder for sheets + xlsx and pages to the end', async () => {
    stubFetch((url) => {
      const params = new URL(url).searchParams;
      if (!params.get('pageToken')) {
        return jsonResponse({ files: [{ id: 'f1', name: 'A-config', mimeType: SPREADSHEET_MIME }], nextPageToken: 'p2' });
      }
      return jsonResponse({ files: [{ id: 'f2', name: 'B.xlsx', mimeType: XLSX_MIME }] });
    });

    const files = await listDriveConfigFiles({ folderId: FOLDER });

    expect(files.map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(calls).toHaveLength(2);
    const q = new URL(calls[0].url).searchParams.get('q');
    expect(q).toContain(`'${FOLDER}' in parents`);
    expect(q).toContain('trashed=false');
    expect(q).toContain(SPREADSHEET_MIME);
    expect(q).toContain(XLSX_MIME);
    expect(new URL(calls[0].url).searchParams.get('supportsAllDrives')).toBe('true');
    expect(calls[0].init.headers.Authorization).toBe('Bearer sa-token');
    expect(google.googleAccessToken).toHaveBeenCalledWith(['https://www.googleapis.com/auth/drive.readonly']);
  });
});

describe('downloadDriveConfigFile', () => {
  const meta = (over = {}) => ({ id: 'file-abcdefghij', name: 'Acme-config', mimeType: SPREADSHEET_MIME, parents: [FOLDER], ...over });

  it('exports a native Sheet as xlsx', async () => {
    const payload = new Uint8Array([1, 2, 3]);
    stubFetch((url) => (url.includes('/export') ? bytesResponse(payload) : jsonResponse(meta())));

    const result = await downloadDriveConfigFile('file-abcdefghij', { folderId: FOLDER });

    expect(result.name).toBe('Acme-config');
    expect(result.mimeType).toBe(SPREADSHEET_MIME);
    expect([...result.bytes]).toEqual([1, 2, 3]);
    expect(calls[1].url).toContain(`/files/file-abcdefghij/export?mimeType=${encodeURIComponent(XLSX_MIME)}`);
  });

  it('downloads an xlsx file as-is', async () => {
    stubFetch((url) => (url.includes('alt=media') ? bytesResponse(new Uint8Array([9])) : jsonResponse(meta({ mimeType: XLSX_MIME, name: 'B.xlsx' }))));

    const result = await downloadDriveConfigFile('file-abcdefghij', { folderId: FOLDER });

    expect(result.name).toBe('B.xlsx');
    expect(calls[1].url).toContain('alt=media');
    expect(calls[1].url).not.toContain('/export');
  });

  it('refuses a file that is not in the shared folder', async () => {
    stubFetch(() => jsonResponse(meta({ parents: ['somewhere-else'] })));

    await expect(downloadDriveConfigFile('file-abcdefghij', { folderId: FOLDER }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(calls).toHaveLength(1);
  });

  it('refuses non-spreadsheet files and malformed ids', async () => {
    stubFetch(() => jsonResponse(meta({ mimeType: 'application/pdf' })));
    await expect(downloadDriveConfigFile('file-abcdefghij', { folderId: FOLDER }))
      .rejects.toMatchObject({ statusCode: 415 });

    await expect(downloadDriveConfigFile('../etc', { folderId: FOLDER }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses files over the size cap before downloading them', async () => {
    stubFetch(() => jsonResponse(meta({ mimeType: XLSX_MIME, size: String(MAX_FILE_SIZE_BYTES + 1) })));

    await expect(downloadDriveConfigFile('file-abcdefghij', { folderId: FOLDER }))
      .rejects.toMatchObject({ statusCode: 413 });
    expect(calls).toHaveLength(1);
  });

  it('surfaces a Google failure with its upstream status', async () => {
    stubFetch((url) => (url.includes('/export') ? jsonResponse({ error: { message: 'nope' } }, 403) : jsonResponse(meta())));

    await expect(downloadDriveConfigFile('file-abcdefghij', { folderId: FOLDER }))
      .rejects.toMatchObject({ name: 'GoogleApiError', status: 403 });
  });
});
