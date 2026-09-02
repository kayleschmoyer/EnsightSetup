/**
 * Vercel serverless function — issues a presigned PUT URL for uploading an
 * image straight to the `com.ensight-technologies.public` S3 bucket under
 * setup_app/, and a presigned DELETE for removing one. The bucket is public
 * for reads, so GETs need no signing — the client builds the object URL
 * directly (see ImageStorageService.js) once the PUT succeeds.
 *
 * AWS credentials never leave the server: the client only ever receives a
 * short-lived, single-object presigned URL, not the access/secret key pair.
 */
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getS3Client, getS3Bucket, assertSetupAppKey } from './_s3.js';
import { requireEnsightSession } from './_auth.js';
import { json, readBody } from './_http.js';

const SIGNED_URL_TTL_SECONDS = 300;
const ALLOWED_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    json(res, 405, { error: 'Method not allowed.' });
    return;
  }

  try {
    await requireEnsightSession(req);
  } catch (err) {
    json(res, err.statusCode || 401, { error: err.message || 'Unauthorized.' });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    json(res, 400, { error: err.message || 'Invalid request.' });
    return;
  }

  let key;
  try {
    key = assertSetupAppKey(body.key);
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
      json(res, 400, { error: 'contentType must be image/png, image/jpeg, image/webp, or image/gif.' });
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
