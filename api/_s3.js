/**
 * Shared S3 client for Vercel serverless functions — the
 * `com.ensight-technologies.public` bucket used for app image storage (see
 * ImageStorageService.js on the client). Module-scope singleton so warm
 * invocations reuse the client instead of re-creating it per request, same
 * pattern as api/_db.js's connection pool.
 *
 * Credentials (S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_REGION) are
 * server-side only — never prefixed with VITE_. Every object this app writes
 * MUST live under the SETUP_APP_PREFIX key prefix; the bucket also serves
 * other, unrelated apps at its root, so a key outside that prefix is refused
 * before it ever reaches S3.
 */
/* global process */
import { S3Client } from '@aws-sdk/client-s3';

export const SETUP_APP_PREFIX = 'setup_app/';

let client;

export function getS3Client() {
  if (!client) {
    const { S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION } = process.env;
    if (!S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY || !S3_REGION) {
      throw new Error(
        'S3 image storage is not configured: missing S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_REGION env vars.',
      );
    }
    client = new S3Client({
      region: S3_REGION,
      credentials: {
        accessKeyId: S3_ACCESS_KEY_ID,
        secretAccessKey: S3_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

export function getS3Bucket() {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error('S3 image storage is not configured: missing S3_BUCKET env var.');
  }
  return bucket;
}

/**
 * Refuses any key that doesn't live under setup_app/ — this bucket is shared
 * with other apps at its root, so a stray key must never land outside our
 * own prefix. Also rejects path traversal and leading slashes.
 */
export function assertSetupAppKey(key) {
  const value = String(key || '');
  if (!value || value.startsWith('/') || value.includes('..')) {
    throw new Error('Invalid storage key.');
  }
  if (!value.startsWith(SETUP_APP_PREFIX)) {
    throw new Error(`Storage key must start with "${SETUP_APP_PREFIX}".`);
  }
  return value;
}

/**
 * Path-style, not virtual-hosted style — the bucket name contains dots, which
 * AWS's `*.s3.<region>.amazonaws.com` wildcard certificate does not cover, so
 * the virtual-hosted host fails TLS verification. Matches the presigned URLs
 * the SDK produces for this bucket, and ImageStorageService.getSetupAppImageUrl.
 */
export function publicObjectUrl(key) {
  assertSetupAppKey(key);
  const bucket = getS3Bucket();
  const region = process.env.S3_REGION;
  return `https://s3.${region}.amazonaws.com/${bucket}/${key}`;
}
