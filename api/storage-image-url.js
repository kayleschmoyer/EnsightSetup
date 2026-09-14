/**
 * Vercel serverless function — issues presigned PUT/GET/DELETE URLs for the
 * `com.ensight-technologies.public` S3 bucket under setup_app/. The bucket
 * is private; every read goes through a short-lived presigned GET here too
 * (see ImageStorageService.js), so no public bucket policy is required.
 *
 * AWS credentials never leave the server: the client only ever receives a
 * short-lived, single-object presigned URL, not the access/secret key pair.
 */
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getS3Client, getS3Bucket, assertSetupAppKey } from './_s3.js';
import { requireEnsightSession } from './_auth.js';
import { json, readBody } from './_http.js';

const SIGNED_URL_TTL_SECONDS = 300;
// Reads are cached client-side for this long (see ImageUploadService.js), so
// the presigned GET needs to outlive that cache or a render can race an
// expired URL.
const READ_SIGNED_URL_TTL_SECONDS = 3600;
// Raster image types only. The bucket is public for reads, so image/svg+xml is
// deliberately excluded — a hosted SVG is script-capable in the browser.
// Device photos are normally re-encoded to webp/jpeg/png before upload, but an
// already-small original is uploaded as-is (see photoPick.prepareDevicePhotoFromFile),
// which is why the camera-native types are here too.
const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'image/avif',
  'image/heic',
  'image/heif',
]);

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE' && req.method !== 'GET') {
    json(res, 405, { error: 'Method not allowed.' });
    return;
  }

  try {
    await requireEnsightSession(req);
  } catch (err) {
    json(res, err.statusCode || 401, { error: err.message || 'Unauthorized.' });
    return;
  }

  // GET carries the key as a query param (a GET request can't have a body);
  // POST/DELETE carry it in a JSON body.
  let body = {};
  if (req.method !== 'GET') {
    try {
      body = await readBody(req);
    } catch (err) {
      json(res, 400, { error: err.message || 'Invalid request.' });
      return;
    }
  }

  let key;
  try {
    key = assertSetupAppKey(req.method === 'GET' ? req.query?.key : body.key);
  } catch (err) {
    json(res, 400, { error: err.message });
    return;
  }

  let bucket;
  try {
    bucket = getS3Bucket();
  } catch (err) {
    json(res, 503, { error: err.message });
    return;
  }

  try {
    const client = getS3Client();

    if (req.method === 'GET') {
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: READ_SIGNED_URL_TTL_SECONDS },
      );
      json(res, 200, { url, method: 'GET' });
      return;
    }

    if (req.method === 'DELETE') {
      const url = await getSignedUrl(
        client,
        new DeleteObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: SIGNED_URL_TTL_SECONDS },
      );
      json(res, 200, { url, method: 'DELETE' });
      return;
    }

    const contentType = String(body.contentType || '').toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      json(res, 400, {
        error: `contentType must be one of: ${[...ALLOWED_CONTENT_TYPES].join(', ')}.`,
      });
      return;
    }

    const url = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
      { expiresIn: SIGNED_URL_TTL_SECONDS },
    );
    json(res, 200, { url, method: 'PUT', key });
  } catch (err) {
    json(res, 502, { error: err.message || 'Failed to create a storage URL.' });
  }
}
