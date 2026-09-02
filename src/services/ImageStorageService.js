import { guardedWrite } from './WriteGuard';

/**
 * Client for the `com.ensight-technologies.public` S3 bucket (see
 * api/storage-image-url.js and api/_s3.js). Every key this app writes MUST
 * live under SETUP_APP_PREFIX — the bucket also serves other, unrelated apps
 * at its root. AWS credentials never reach the browser: the server only ever
 * hands back a short-lived presigned URL for a single object.
 */

export const SETUP_APP_PREFIX = 'setup_app/';

const PRESIGN_ENDPOINT = '/api/storage-image-url';

function extensionForBlob(blob) {
  const type = blob?.type || '';
  if (type.includes('webp')) return 'webp';
  if (type.includes('png')) return 'png';
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  if (type.includes('avif')) return 'avif';
  if (type.includes('heic')) return 'heic';
  if (type.includes('heif')) return 'heif';
  if (type.includes('tiff')) return 'tiff';
  if (type.includes('bmp')) return 'bmp';
  if (type.includes('gif')) return 'gif';
  return 'bin';
}

function assertSetupAppKey(key) {
  if (!key || !key.startsWith(SETUP_APP_PREFIX)) {
    throw new Error(`Storage key must start with "${SETUP_APP_PREFIX}".`);
  }
  return key;
}

async function requestPresignedUrl(method, key, contentType) {
  const response = await fetch(PRESIGN_ENDPOINT, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, contentType }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Could not get a storage URL (${response.status}).`);
  }
  return data.url;
}

/**
 * Upload an image Blob to `setup_app/<subpath>` and return its stored key.
 * @param {string} subpath - path segments under setup_app/, without a
 *   leading slash and without the file extension (e.g. `customerId/siteId`).
 * @param {Blob} blob
 */
export async function uploadSetupAppImage(subpath, blob) {
  const key = assertSetupAppKey(`${SETUP_APP_PREFIX}${subpath}.${extensionForBlob(blob)}`);
  return guardedWrite(
    () => ({
      title: `Upload image to storage bucket "com.ensight-technologies.public"`,
      tables: [`s3.objects (setup_app/)`],
      changes: [{
        table: 'com.ensight-technologies.public', identifier: key, before: null, after: `${blob.type || 'unknown type'}, ${blob.size} bytes`,
      }],
    }),
    async () => {
      const uploadUrl = await requestPresignedUrl('POST', key, blob.type || 'application/octet-stream');
      const putResponse = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': blob.type || 'application/octet-stream' },
        body: blob,
      });
      if (!putResponse.ok) {
        throw new Error(`Image upload to storage failed (${putResponse.status}).`);
      }
      return key;
    },
  );
}

export async function deleteSetupAppImage(key) {
  if (!key) return;
  assertSetupAppKey(key);
  return guardedWrite(
    () => ({
      title: 'Delete image from storage bucket "com.ensight-technologies.public"',
      tables: [`s3.objects (setup_app/)`],
      changes: [{ table: 'com.ensight-technologies.public', identifier: key, before: key, after: null }],
    }),
    async () => {
      const deleteUrl = await requestPresignedUrl('DELETE', key);
      const deleteResponse = await fetch(deleteUrl, { method: 'DELETE' });
      if (!deleteResponse.ok && deleteResponse.status !== 404) {
        throw new Error(`Image delete from storage failed (${deleteResponse.status}).`);
      }
    },
  );
}

/**
 * The bucket is public for reads — no signing needed, just build the URL.
 * Throws if `key` isn't under setup_app/.
 *
 * Path-style (`s3.<region>.amazonaws.com/<bucket>/<key>`), not virtual-hosted
 * style: this bucket's name contains dots, and AWS's `*.s3.<region>.amazonaws.com`
 * certificate only covers a single label, so `com.ensight-technologies.public.s3...`
 * fails TLS verification in the browser. The presigner signs path-style for the
 * same reason, so both halves of a round-trip agree.
 */
export function getSetupAppImageUrl(key, { bucket = 'com.ensight-technologies.public', region = 'us-west-1' } = {}) {
  assertSetupAppKey(key);
  return `https://s3.${region}.amazonaws.com/${bucket}/${key}`;
}
