/**
 * Floor-plan backgrounds and device photos.
 *
 * New uploads go to the `com.ensight-technologies.public` S3 bucket under the
 * setup_app/ key prefix (see ImageStorageService.js, api/storage-image-url.js).
 * The bucket is public for reads, so rendering a freshly uploaded image is a
 * plain URL build — no signing round-trip, no expiry, no refresh timer.
 *
 * Reads and deletes stay dual-mode during the transition: rows written before
 * this migration still hold bucket-relative Supabase Storage paths
 * (`<customerId>/<siteId>/...`), and those keep resolving through Supabase's
 * short-lived signed URLs until they're replaced by a new upload. A path is
 * recognised by its prefix — anything starting with `setup_app/` is S3,
 * anything else is legacy Supabase Storage. Nothing writes to Supabase
 * Storage any more.
 */
import { guardedWrite } from './WriteGuard';
import {
  SETUP_APP_PREFIX,
  uploadSetupAppImage,
  deleteSetupAppImage,
  getSetupAppImageUrl,
} from './ImageStorageService';

/** Legacy Supabase Storage buckets — read/delete only, never written to now. */
export const FLOOR_PLAN_BUCKET = 'floor-plans';
export const DEVICE_PHOTO_BUCKET = 'device-photos';

/** S3 key prefixes new uploads land under, inside setup_app/. */
export const FLOOR_PLAN_S3_PREFIX = `${SETUP_APP_PREFIX}floor-plans/`;
export const DEVICE_PHOTO_S3_PREFIX = `${SETUP_APP_PREFIX}device-photos/`;

const SIGNED_URL_TTL_SECONDS = 3600;
// Refresh a bit before actual expiry so a render never races an expired URL.
const SIGNED_URL_CACHE_MARGIN_MS = 60_000;

const signedUrlCache = new Map(); // legacy Supabase path -> { url, expiresAt }

/**
 * Legacy Supabase Storage is only reachable from the pre-migration paths below,
 * so load its client on demand — an app whose images all live in S3 shouldn't
 * need Supabase credentials configured just to render them.
 */
async function legacyStorage(bucket) {
  const { supabase } = await import('./SupabaseClient');
  return supabase.storage.from(bucket);
}

/** True for paths stored in S3 under setup_app/; false for legacy Supabase paths. */
export function isS3ImagePath(path) {
  return typeof path === 'string' && path.startsWith(SETUP_APP_PREFIX);
}

/**
 * Keys are assembled from customer/site/level/device ids. Keep each segment to
 * characters that are safe in an S3 key so a stray id can never produce a key
 * the server-side setup_app/ guard rejects (or one that escapes the prefix).
 */
function segment(value) {
  const cleaned = String(value ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '');
  return cleaned || 'unknown';
}

/**
 * Upload a compressed floor-plan Blob (see loadFloorPlanBackground) to
 * `setup_app/floor-plans/...` and return the stored key, ready to save on
 * levels.bg_image_path.
 */
export async function uploadFloorPlanBackground(customerId, siteId, levelId, blob) {
  const subpath = `floor-plans/${segment(customerId)}/${segment(siteId)}/${segment(levelId)}`
    + `/bg-${Date.now()}`;
  return uploadSetupAppImage(subpath, blob);
}

/**
 * Upload a compressed device/sign photo Blob (see prepareDevicePhotoFromFile)
 * to `setup_app/device-photos/...` and return the stored key.
 */
export async function uploadDevicePhoto(customerId, siteId, levelId, deviceId, index, blob) {
  const subpath = `device-photos/${segment(customerId)}/${segment(siteId)}/${segment(levelId)}`
    + `/${segment(deviceId)}/${segment(index)}-${Date.now()}`;
  return uploadSetupAppImage(subpath, blob);
}

/**
 * Delete a stored image. `bucket` only applies to legacy Supabase paths — an
 * S3 key carries its own location, so it's ignored for those.
 */
export async function deleteStorageObject(bucket, path) {
  if (!path) return undefined;
  if (isS3ImagePath(path)) return deleteSetupAppImage(path);
  return guardedWrite(
    () => ({
      title: `Delete storage object from bucket "${bucket}"`,
      tables: [`storage.objects (${bucket})`],
      changes: [{ table: bucket, identifier: path, before: path, after: null }],
    }),
    async () => {
      await (await legacyStorage(bucket)).remove([path]);
      signedUrlCache.delete(path);
    },
  );
}

/**
 * Resolve a stored image path to a URL a browser can render.
 *
 * S3 keys resolve to the bucket's public object URL — stable, no expiry.
 * Legacy Supabase paths fall back to a short-lived signed URL, cached
 * client-side so a canvas re-render doesn't re-request one every frame.
 */
export async function getImageUrl(bucket, path) {
  if (!path) return null;
  if (isS3ImagePath(path)) return getSetupAppImageUrl(path);
  const cached = signedUrlCache.get(path);
  if (cached && cached.expiresAt - SIGNED_URL_CACHE_MARGIN_MS > Date.now()) {
    return cached.url;
  }
  const { data, error } = await (await legacyStorage(bucket))
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (error) throw error;
  signedUrlCache.set(path, {
    url: data.signedUrl,
    expiresAt: Date.now() + SIGNED_URL_TTL_SECONDS * 1000,
  });
  return data.signedUrl;
}

export const getFloorPlanImageUrl = (path) => getImageUrl(FLOOR_PLAN_BUCKET, path);
export const getDevicePhotoImageUrl = (path) => getImageUrl(DEVICE_PHOTO_BUCKET, path);
