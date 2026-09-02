/**
 * Shared S3 client for Vercel serverless functions — the
 * `com.ensight-technologies.public` bucket used for app image storage (see
 * ImageStorageService.js on the client). Module-scope singleton so warm
 * invocations reuse the client instead of re-creating it per request, same
 * pattern as api/_db.js's connection pool.
 *
 * Credentials (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_REGION) are
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
    const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION } = process.env;
    if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_REGION) {
      throw new Error(
        'S3 image storage is not configured: missing AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_REGION env vars.',
      );
    }
    client = new S3Client({
      region: AWS_REGION,
      credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

export function getS3Bucket() {
  const bucket = process.env.AWS_S3_BUCKET;
  if (!bucket) {
    throw new Error('S3 image storage is not configured: missing AWS_S3_BUCKET env var.');
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

export function publicObjectUrl(key) {
  assertSetupAppKey(key);
  const bucket = getS3Bucket();
  const region = process.env.AWS_REGION;
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}
